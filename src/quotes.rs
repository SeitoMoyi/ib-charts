//! Shared live quotes (IB `reqMktData`) for the watchlist.
//!
//! Each symbol has at most one IB subscription no matter how many windows watch it,
//! because IB limits concurrent market-data lines (usually 100 per user).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use futures::StreamExt;
use ibapi::market_data::MarketDataType;
use ibapi::market_data::realtime::Quote;
use ibapi::subscriptions::SubscriptionItem;
use serde::Serialize;
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;

use crate::ib::Ib;

/// Minimum time between updates for one symbol.
const THROTTLE: Duration = Duration::from_millis(300);
const RETRY: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQuote {
    pub symbol: String,
    /// Last trade, or the bid/ask midpoint when there are no trades (forex), or the close.
    pub price: Option<f64>,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    /// Previous session close.
    pub close: Option<f64>,
    pub change: Option<f64>,
    pub change_pct: Option<f64>,
    pub volume: Option<f64>,
    /// `realtime`, `frozen`, `delayed` or `delayedFrozen`.
    pub data_type: Option<&'static str>,
    pub error: Option<String>,
}

impl WireQuote {
    fn from_quote(symbol: &str, q: &Quote) -> Self {
        let mid = match (q.bid, q.ask) {
            (Some(b), Some(a)) if b > 0.0 && a > 0.0 => Some((b + a) / 2.0),
            _ => None,
        };
        let price = q.last.filter(|v| *v > 0.0).or(mid).or(q.close);
        let close = q.close.filter(|v| *v > 0.0);
        let change = price.zip(close).map(|(p, c)| p - c);
        Self {
            symbol: symbol.to_string(),
            price,
            bid: q.bid,
            ask: q.ask,
            open: q.open,
            high: q.high,
            low: q.low,
            close,
            change,
            change_pct: change.zip(close).map(|(d, c)| d / c * 100.0),
            volume: q.volume,
            data_type: q.market_data_type.map(|t| match t {
                MarketDataType::Realtime => "realtime",
                MarketDataType::Frozen => "frozen",
                MarketDataType::Delayed => "delayed",
                MarketDataType::DelayedFrozen => "delayedFrozen",
                _ => "unknown",
            }),
            error: None,
        }
    }

    fn error(symbol: &str, msg: String) -> Self {
        Self {
            symbol: symbol.to_string(),
            error: Some(msg),
            ..Default::default()
        }
    }
}

struct Entry {
    tx: broadcast::Sender<Arc<WireQuote>>,
    last: Arc<std::sync::Mutex<Option<Arc<WireQuote>>>>,
    refs: usize,
    task: JoinHandle<()>,
}

pub struct QuoteHub {
    ib: Arc<Ib>,
    demo: bool,
    entries: Mutex<HashMap<String, Entry>>,
}

impl QuoteHub {
    pub fn new(ib: Arc<Ib>, demo: bool) -> Arc<Self> {
        Arc::new(Self {
            ib,
            demo,
            entries: Mutex::new(HashMap::new()),
        })
    }

    /// Starts (or joins) the quote stream for `symbol`. Returns a receiver plus the
    /// latest quote so a new watcher can render immediately.
    pub async fn subscribe(&self, symbol: &str) -> (broadcast::Receiver<Arc<WireQuote>>, Option<Arc<WireQuote>>) {
        let key = symbol.trim().to_uppercase();
        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.get_mut(&key) {
            e.refs += 1;
            return (e.tx.subscribe(), e.last.lock().unwrap().clone());
        }
        let (tx, rx) = broadcast::channel(64);
        let last = Arc::new(std::sync::Mutex::new(None));
        let task = if self.demo {
            let (sym, tx2, last2) = (key.clone(), tx.clone(), last.clone());
            tokio::spawn(async move {
                crate::demo::quotes(sym, move |q| {
                    let q = Arc::new(q);
                    *last2.lock().unwrap() = Some(q.clone());
                    let _ = tx2.send(q);
                })
                .await
            })
        } else {
            tokio::spawn(run(self.ib.clone(), key.clone(), tx.clone(), last.clone()))
        };
        entries.insert(key, Entry { tx, last, refs: 1, task });
        (rx, None)
    }

    pub async fn unsubscribe(&self, symbol: &str) {
        let key = symbol.trim().to_uppercase();
        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.get_mut(&key) {
            e.refs -= 1;
            if e.refs == 0 {
                // Dropping the IB subscription inside the task sends the cancel.
                e.task.abort();
                entries.remove(&key);
            }
        }
    }
}

/// Streams quotes for one symbol forever, retrying after errors (e.g. Gateway restarts).
async fn run(ib: Arc<Ib>, symbol: String, tx: broadcast::Sender<Arc<WireQuote>>, last: Arc<std::sync::Mutex<Option<Arc<WireQuote>>>>) {
    let publish = |q: WireQuote| {
        let q = Arc::new(q);
        *last.lock().unwrap() = Some(q.clone());
        let _ = tx.send(q);
    };
    loop {
        if let Err(e) = stream_once(&ib, &symbol, &publish).await {
            tracing::debug!("quote {symbol}: {e:#}");
            publish(WireQuote::error(&symbol, format!("{e:#}")));
        }
        tokio::time::sleep(RETRY).await;
    }
}

async fn stream_once(ib: &Ib, symbol: &str, publish: &impl Fn(WireQuote)) -> Result<()> {
    let r = ib.resolve(symbol).await?;
    let client = ib.client().await?;
    // Live data where subscribed, delayed otherwise; last values when the market is closed.
    client
        .switch_market_data_type(MarketDataType::DelayedFrozen)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let mut sub = client
        .market_data(&r.contract)
        .subscribe()
        .await
        .map_err(|e| anyhow!("market data request failed: {e}"))?;

    let mut quote = Quote::default();
    let mut dirty = false;
    let mut tick = tokio::time::interval(THROTTLE);
    loop {
        tokio::select! {
            item = sub.next() => match item {
                Some(Ok(SubscriptionItem::Data(t))) => { quote.apply(&t); dirty = true; }
                Some(Ok(SubscriptionItem::Notice(n))) => tracing::debug!("quote {symbol} notice: {n:?}"),
                Some(Err(e)) => return Err(anyhow!("{e}")),
                None => return Err(anyhow!("quote stream ended")),
            },
            _ = tick.tick() => if dirty {
                dirty = false;
                publish(WireQuote::from_quote(symbol, &quote));
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_falls_back_to_midpoint_then_close() {
        let mut q = Quote::default();
        (q.bid, q.ask, q.close) = (Some(1.1), Some(1.3), Some(1.0));
        let w = WireQuote::from_quote("EUR.USD", &q);
        assert!((w.price.unwrap() - 1.2).abs() < 1e-9);
        assert!((w.change_pct.unwrap() - 20.0).abs() < 1e-9);
        let mut q = Quote::default();
        q.close = Some(50.0);
        assert_eq!(WireQuote::from_quote("X", &q).price, Some(50.0));
    }
}
