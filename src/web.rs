//! HTTP + WebSocket server for the chart UI.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use ibapi::contracts::SecurityType;
use ibapi::market_data::TradingHours;
use ibapi::market_data::historical::{Bar, BarTimestamp, HistoricalBarUpdate};
use ibapi::subscriptions::SubscriptionItemStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::ib::Ib;
use crate::{contracts, timeframe};

const INDEX_HTML: &str = include_str!("../static/index.html");
const APP_JS: &str = include_str!("../static/app.js");
const STYLE_CSS: &str = include_str!("../static/style.css");
const CHARTS_JS: &str = include_str!("../static/vendor/lightweight-charts.standalone.production.js");

pub fn router(ib: Arc<Ib>) -> Router {
    Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route(
            "/app.js",
            get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP_JS) }),
        )
        .route(
            "/style.css",
            get(|| async { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], STYLE_CSS) }),
        )
        .route(
            "/vendor/lightweight-charts.js",
            get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], CHARTS_JS) }),
        )
        .route("/api/search", get(search))
        .route("/ws", get(ws_upgrade))
        .with_state(ib)
}

// ---------- symbol search ----------

#[derive(Deserialize)]
struct SearchParams {
    q: String,
}

#[derive(Serialize)]
struct SearchHit {
    /// What to put in the symbol box to chart this result.
    input: String,
    symbol: String,
    kind: String,
    exchange: String,
    currency: String,
}

async fn search(State(ib): State<Arc<Ib>>, Query(p): Query<SearchParams>) -> Response {
    let q = p.q.trim();
    if q.is_empty() || q.len() > 32 {
        return Json(Vec::<SearchHit>::new()).into_response();
    }
    let result = async {
        let client = ib.client().await?;
        let hits = client.matching_symbols(q).await.map_err(|e| anyhow!("symbol search failed: {e}"))?;
        Ok::<_, anyhow::Error>(
            hits.into_iter()
                .filter_map(|d| {
                    let c = d.contract;
                    let (input, kind) = match c.security_type {
                        // Non-USD listings need exchange + currency or they'd resolve to the US line.
                        SecurityType::Stock if c.currency.as_str() != "USD" => {
                            (format!("{}:{}:{}", c.symbol, c.primary_exchange, c.currency), "Stock")
                        }
                        SecurityType::Stock => (c.symbol.to_string(), "Stock"),
                        SecurityType::Index => (format!("^{}", c.symbol), "Index"),
                        SecurityType::Crypto => (format!("${}", c.symbol), "Crypto"),
                        SecurityType::Future => (format!("/{}", c.symbol), "Future"),
                        _ => return None,
                    };
                    Some(SearchHit {
                        input,
                        symbol: c.symbol.to_string(),
                        kind: kind.to_string(),
                        exchange: c.primary_exchange.to_string(),
                        currency: c.currency.to_string(),
                    })
                })
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match result {
        Ok(hits) => Json(hits).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
    }
}

// ---------- websocket bar streaming ----------

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMsg {
    Subscribe {
        seq: u64,
        symbol: String,
        tf: String,
        #[serde(default)]
        rth: bool,
    },
}

#[derive(Serialize)]
struct WireBar {
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

/// Rejects cross-site WebSocket connections (some other web page in your browser
/// talking to this local server).
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true; // non-browser client
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) == Some(host)
}

async fn ws_upgrade(State(ib): State<Arc<Ib>>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !same_origin(&headers) {
        return (StatusCode::FORBIDDEN, "cross-origin websocket rejected").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, ib))
}

async fn handle_socket(socket: WebSocket, ib: Arc<Ib>) {
    let (mut sink, mut incoming) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(1024);

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // One active market-data subscription per browser tab. Aborting the task
    // drops the IB subscription, which sends the cancel to the Gateway.
    let mut active: Option<JoinHandle<()>> = None;

    while let Some(Ok(msg)) = incoming.next().await {
        let Message::Text(text) = msg else { continue };
        match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::Subscribe { seq, symbol, tf, rth }) => {
                if let Some(h) = active.take() {
                    h.abort();
                }
                let (ib, tx) = (ib.clone(), tx.clone());
                active = Some(tokio::spawn(async move {
                    if let Err(e) = stream_bars(&ib, seq, &symbol, &tf, rth, &tx).await {
                        tracing::warn!("{symbol} {tf}: {e:#}");
                        send(&tx, json!({"type": "error", "seq": seq, "message": format!("{e:#}")})).await;
                    }
                }));
            }
            Err(e) => tracing::debug!("bad client message: {e}"),
        }
    }

    if let Some(h) = active {
        h.abort();
    }
    writer.abort();
}

async fn send(tx: &mpsc::Sender<String>, v: serde_json::Value) {
    let _ = tx.send(v.to_string()).await;
}

async fn stream_bars(ib: &Ib, seq: u64, input: &str, tf_id: &str, rth: bool, tx: &mpsc::Sender<String>) -> Result<()> {
    let tf = timeframe::parse(tf_id).ok_or_else(|| anyhow!("unknown timeframe '{tf_id}'"))?;
    send(tx, json!({"type": "status", "seq": seq, "message": format!("Looking up {input}…")})).await;

    let client = ib.client().await?;
    let r = contracts::resolve(&client, input).await?;
    let has_volume = r.has_volume;

    send(
        tx,
        json!({"type": "status", "seq": seq, "message": format!("Loading {} {tf_id}…", r.label)}),
    )
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
                let bars: Vec<_> = data.bars.iter().map(|b| wire_bar(b, has_volume)).collect();
                send(
                    tx,
                    json!({
                        "type": "history",
                        "seq": seq,
                        "symbol": r.label,
                        "description": r.description,
                        "intraday": tf.intraday,
                        "hasVolume": has_volume,
                        "minTick": r.min_tick,
                        "bars": bars,
                    }),
                )
                .await;
            }
            HistoricalBarUpdate::Update(bar) => {
                send(tx, json!({"type": "bar", "seq": seq, "bar": wire_bar(&bar, has_volume)})).await;
            }
            HistoricalBarUpdate::End { .. } => {}
        }
    }

    send(tx, json!({"type": "ended", "seq": seq})).await;
    Ok(())
}
