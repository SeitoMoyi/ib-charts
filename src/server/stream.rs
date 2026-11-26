//! WebSocket streaming of bars (and, later, quotes) to the UI.
//!
//! Client → server:
//!   `{"type":"subscribe","id":"main","seq":1,"symbol":"AAPL","tf":"5m","rth":false}`
//!   `{"type":"unsubscribe","id":"main"}`
//! Server → client (every message carries the `id` and `seq` it belongs to):
//!   `status`, `history`, `bar`, `error`, `ended`

use std::collections::HashMap;

use anyhow::{Result, anyhow};
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use ibapi::market_data::TradingHours;
use ibapi::market_data::historical::{Bar, BarTimestamp, HistoricalBarUpdate};
use ibapi::subscriptions::SubscriptionItemStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::AppState;
use crate::timeframe;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMsg {
    Subscribe {
        id: String,
        seq: u64,
        symbol: String,
        tf: String,
        #[serde(default)]
        rth: bool,
    },
    Unsubscribe {
        id: String,
    },
}

#[derive(Serialize)]
pub struct WireBar {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    volume: Option<f64>,
}

fn wire_bar(b: &Bar, has_volume: bool) -> WireBar {
    let time = match &b.date {
        BarTimestamp::Date(d) => d.midnight().assume_utc().unix_timestamp(),
        BarTimestamp::DateTime(dt) => dt.unix_timestamp(),
    };
    WireBar {
        time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: (has_volume && b.volume >= 0.0).then_some(b.volume),
    }
}

pub async fn ws_upgrade(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, st))
}

/// Sender tagged with the subscription it belongs to.
#[derive(Clone)]
struct Out {
    tx: mpsc::Sender<String>,
    id: String,
    seq: u64,
}

impl Out {
    async fn send(&self, mut v: serde_json::Value) {
        v["id"] = json!(self.id);
        v["seq"] = json!(self.seq);
        let _ = self.tx.send(v.to_string()).await;
    }
}

async fn handle_socket(socket: WebSocket, st: AppState) {
    let (mut sink, mut incoming) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(4096);

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Push Gateway status changes to the UI (no subscription id).
    let mut gw_status = st.gateway.subscribe();
    let gw_tx = tx.clone();
    let gw_task = tokio::spawn(async move {
        loop {
            let status = gw_status.borrow_and_update().clone();
            if gw_tx.send(json!({"type": "gateway", "status": status}).to_string()).await.is_err() {
                break;
            }
            if gw_status.changed().await.is_err() {
                break;
            }
        }
    });

    // Active subscriptions by id. Aborting a task drops its IB subscription,
    // which sends the cancel to the Gateway.
    let mut active: HashMap<String, JoinHandle<()>> = HashMap::new();

    while let Some(Ok(msg)) = incoming.next().await {
        let Message::Text(text) = msg else { continue };
        match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::Subscribe { id, seq, symbol, tf, rth }) => {
                if let Some(h) = active.remove(&id) {
                    h.abort();
                }
                if active.len() >= 16 {
                    tracing::warn!("too many chart subscriptions on one connection");
                    continue;
                }
                let out = Out {
                    tx: tx.clone(),
                    id: id.clone(),
                    seq,
                };
                let st = st.clone();
                active.insert(
                    id,
                    tokio::spawn(async move {
                        if let Err(e) = stream_bars(&st, &out, &symbol, &tf, rth).await {
                            tracing::warn!("{symbol} {tf}: {e:#}");
                            out.send(json!({"type": "error", "message": format!("{e:#}")})).await;
                        }
                    }),
                );
            }
            Ok(ClientMsg::Unsubscribe { id }) => {
                if let Some(h) = active.remove(&id) {
                    h.abort();
                }
            }
            Err(e) => tracing::debug!("bad client message: {e}"),
        }
    }

    for (_, h) in active {
        h.abort();
    }
    gw_task.abort();
    writer.abort();
}

async fn stream_bars(st: &AppState, out: &Out, input: &str, tf_id: &str, rth: bool) -> Result<()> {
    let tf = timeframe::parse(tf_id).ok_or_else(|| anyhow!("unknown timeframe '{tf_id}'"))?;
    out.send(json!({"type": "status", "message": format!("Looking up {input}…")})).await;

    let r = st.ib.resolve(input).await?;
    let client = st.ib.client().await?;
    out.send(json!({"type": "status", "message": format!("Loading {} {tf_id}…", r.label)}))
        .await;

    let subscription = client
        .historical_data(&r.contract, tf.bar_size)
        .what_to_show(r.what_to_show)
        .trading_hours(if rth { TradingHours::Regular } else { TradingHours::Extended })
        .duration(tf.duration)
        .stream() // keepUpToDate = true: history first, then live updates of the forming bar
        .await
        .map_err(|e| anyhow!("historical data request failed: {e}"))?;

    let mut updates = subscription.filter_data();
    while let Some(update) = updates.next().await {
        match update.map_err(|e| anyhow!("{e}"))? {
            HistoricalBarUpdate::Historical(data) => {
                let bars: Vec<_> = data.bars.iter().map(|b| wire_bar(b, r.has_volume)).collect();
                out.send(json!({
                    "type": "history",
                    "symbol": r.label,
                    "description": r.description,
                    "info": r.info,
                    "intraday": tf.intraday,
                    "hasVolume": r.has_volume,
                    "minTick": r.min_tick,
                    "bars": bars,
                }))
                .await;
            }
            HistoricalBarUpdate::Update(bar) => {
                out.send(json!({"type": "bar", "bar": wire_bar(&bar, r.has_volume)})).await;
            }
            HistoricalBarUpdate::End { .. } => {}
        }
    }

    out.send(json!({"type": "ended"})).await;
    Ok(())
}
