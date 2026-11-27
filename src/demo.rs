//! `--demo`: synthetic market data so the app can be tried (and developed) without IB.
//!
//! Every symbol gets a deterministic random walk per timeframe, then live ticks every second.

use std::time::Duration;

use serde_json::{Value, json};

use crate::contracts::SymbolInfo;
use crate::quotes::WireQuote;

const HISTORY_BARS: i64 = 1500;

/// Seconds per bar for a timeframe id.
fn bar_secs(tf: &str) -> i64 {
    crate::timeframe::parse(tf).map_or(300, |t| t.seconds)
}

/// Small deterministic PRNG (xorshift64*).
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Standard normal (Box–Muller).
    fn normal(&mut self) -> f64 {
        let (u, v) = (self.next().max(1e-12), self.next());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

fn hash(s: &str) -> u64 {
    s.bytes()
        .fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x1000_0000_01b3))
}

/// Typical price level for a symbol (stable across runs).
pub fn base_price(symbol: &str) -> f64 {
    let s = symbol.to_uppercase();
    if s.contains('.') && s.len() == 7 {
        return if s.ends_with("JPY") { 150.0 } else { 1.1 };
    }
    20.0 + (hash(&s) % 48000) as f64 / 100.0
}

fn tick_for(price: f64) -> f64 {
    if price < 10.0 { 0.0001 } else { 0.01 }
}

fn round_to(v: f64, tick: f64) -> f64 {
    (v / tick).round() * tick
}

pub fn symbol_info(symbol: &str) -> SymbolInfo {
    let s = symbol.trim().to_uppercase();
    SymbolInfo {
        key: format!("demo:{s}"),
        con_id: 0,
        kind: "stock",
        symbol: s.clone(),
        long_name: format!("{s} (demo data)"),
        exchange: "DEMO".into(),
        currency: "USD".into(),
        time_zone: "UTC".into(),
        trading_hours: vec![],
        liquid_hours: vec![],
        industry: String::new(),
        category: String::new(),
        subcategory: String::new(),
        expiry: String::new(),
        multiplier: String::new(),
    }
}

/// History plus the state needed to keep streaming.
pub struct Series {
    secs: i64,
    sigma: f64,
    tick: f64,
    rng: Rng,
    bar: Value,
    pub history: Vec<Value>,
}

pub fn history(symbol: &str, tf: &str) -> Series {
    let secs = bar_secs(tf);
    let now = chrono::Utc::now().timestamp();
    let last = now - now.rem_euclid(secs);
    let base = base_price(symbol);
    let tick = tick_for(base);
    let sigma = 0.02 * (secs as f64 / 86400.0).sqrt();
    let mut rng = Rng::new(hash(&format!("{symbol}|{tf}")));

    // Walk backwards from the base so the latest price sits near it.
    let mut closes = vec![base; HISTORY_BARS as usize];
    for i in (0..HISTORY_BARS as usize - 1).rev() {
        closes[i] = closes[i + 1] * (-sigma * rng.normal()).exp();
    }
    let mut history = Vec::with_capacity(HISTORY_BARS as usize);
    let mut open = closes[0];
    for (i, &close) in closes.iter().enumerate() {
        let time = last - (HISTORY_BARS - 1 - i as i64) * secs;
        let hi = open.max(close) * (1.0 + rng.next() * sigma * 0.6);
        let lo = open.min(close) * (1.0 - rng.next() * sigma * 0.6);
        let volume = ((2e5 + rng.next() * 8e5) * (secs as f64 / 60.0).sqrt()).round();
        history.push(json!({
            "time": time, "open": round_to(open, tick), "high": round_to(hi, tick),
            "low": round_to(lo, tick), "close": round_to(close, tick), "volume": volume,
        }));
        open = close;
    }
    let bar = history.last().cloned().unwrap_or(Value::Null);
    Series {
        secs,
        sigma,
        tick,
        rng: Rng::new(hash(symbol) ^ now as u64),
        bar,
        history,
    }
}

impl Series {
    /// Advances one second of live trading and returns the updated (or new) bar.
    pub fn tick(&mut self) -> Value {
        let now = chrono::Utc::now().timestamp();
        let t0 = now - now.rem_euclid(self.secs);
        let last_close = self.bar["close"].as_f64().unwrap_or(1.0);
        let step = self.sigma / (self.secs as f64).sqrt() * 3.0;
        let price = round_to(last_close * (step * self.rng.normal()).exp(), self.tick);
        if self.bar["time"].as_i64().unwrap_or(0) < t0 {
            self.bar = json!({ "time": t0, "open": last_close, "high": last_close.max(price), "low": last_close.min(price), "close": price, "volume": 0.0 });
        } else {
            let b = &mut self.bar;
            b["high"] = json!(b["high"].as_f64().unwrap_or(price).max(price));
            b["low"] = json!(b["low"].as_f64().unwrap_or(price).min(price));
            b["close"] = json!(price);
        }
        let vol = self.bar["volume"].as_f64().unwrap_or(0.0) + (self.rng.next() * 3000.0).round();
        self.bar["volume"] = json!(vol);
        self.bar.clone()
    }
}

/// Live demo quotes for the watchlist, published once a second.
pub async fn quotes(symbol: String, publish: impl Fn(WireQuote)) {
    let close = base_price(&symbol);
    let tick = tick_for(close);
    let mut rng = Rng::new(hash(&symbol) ^ chrono::Utc::now().timestamp() as u64);
    let mut price = close * (1.0 + rng.normal() * 0.01);
    loop {
        price = round_to(price * (0.0008 * rng.normal()).exp(), tick);
        let change = price - close;
        publish(WireQuote {
            symbol: symbol.clone(),
            price: Some(price),
            bid: Some(price - tick),
            ask: Some(price + tick),
            close: Some(close),
            change: Some(change),
            change_pct: Some(change / close * 100.0),
            data_type: Some("realtime"),
            ..Default::default()
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

const SEARCH: &[&str] = &[
    "AAPL", "AMZN", "AMD", "GOOGL", "META", "MSFT", "NFLX", "NVDA", "TSLA", "SPY", "QQQ", "IWM", "JPM", "V", "KO",
];

pub fn search(q: &str) -> Vec<Value> {
    let q = q.to_uppercase();
    SEARCH
        .iter()
        .filter(|s| s.starts_with(&q))
        .map(|s| json!({ "input": s, "symbol": s, "kind": "Stock", "exchange": "DEMO", "currency": "USD" }))
        .collect()
}

// ---------- demo account / research data ----------

pub fn positions() -> Value {
    json!([
        { "account": "DEMO", "conId": 0, "symbol": "AAPL", "localSymbol": "AAPL", "secType": "Stock", "currency": "USD", "position": 100.0, "avgCost": round_to(base_price("AAPL") * 0.97, 0.01), "multiplier": "" },
        { "account": "DEMO", "conId": 0, "symbol": "MSFT", "localSymbol": "MSFT", "secType": "Stock", "currency": "USD", "position": -50.0, "avgCost": round_to(base_price("MSFT") * 1.02, 0.01), "multiplier": "" },
    ])
}

pub fn executions() -> Value {
    let now = chrono::Utc::now();
    let t = |mins: i64| (now - chrono::Duration::minutes(mins)).format("%Y%m%d %H:%M:%S UTC").to_string();
    let p = base_price("AAPL");
    json!([
        { "conId": 0, "symbol": "AAPL", "side": "buy", "shares": 60.0, "price": round_to(p * 0.995, 0.01), "time": t(300), "exchange": "DEMO" },
        { "conId": 0, "symbol": "AAPL", "side": "buy", "shares": 40.0, "price": round_to(p * 0.99, 0.01), "time": t(180), "exchange": "DEMO" },
        { "conId": 0, "symbol": "AAPL", "side": "sell", "shares": 20.0, "price": round_to(p * 1.002, 0.01), "time": t(60), "exchange": "DEMO" },
    ])
}

pub fn scanner(code: &str) -> Value {
    let mut rng = Rng::new(hash(code));
    let mut list: Vec<&str> = SEARCH.to_vec();
    for i in (1..list.len()).rev() {
        list.swap(i, (rng.next() * (i + 1) as f64) as usize);
    }
    json!(
        list.iter()
            .enumerate()
            .map(|(i, s)| json!({ "rank": i, "symbol": s, "exchange": "DEMO", "currency": "USD", "name": format!("{s} (demo)") }))
            .collect::<Vec<_>>()
    )
}

pub fn news(symbol: &str) -> Value {
    let now = chrono::Utc::now().timestamp();
    let s = symbol.to_uppercase();
    json!({
        "providers": [{ "code": "DEMO", "name": "Demo news" }],
        "items": [
            { "time": now - 3600, "provider": "DEMO", "id": "1", "headline": format!("{s} shares move as traders weigh outlook (demo)") },
            { "time": now - 86400, "provider": "DEMO", "id": "2", "headline": format!("Analyst updates price target on {s} (demo)") },
            { "time": now - 3 * 86400, "provider": "DEMO", "id": "3", "headline": format!("{s} to report quarterly results (demo)") },
        ],
    })
}

pub fn earnings() -> Value {
    let today = chrono::Utc::now().date_naive();
    let d = |days: i64| (today + chrono::Duration::days(days)).format("%Y%m%d").to_string();
    json!([d(-180), d(-90), d(-2), d(88)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_deterministic_and_sane() {
        let a = history("AAPL", "5m");
        let b = history("AAPL", "5m");
        assert_eq!(a.history.len(), HISTORY_BARS as usize);
        assert_eq!(a.history[10], b.history[10]);
        for bar in &a.history {
            let (o, h, l, c) = (
                bar["open"].as_f64().unwrap(),
                bar["high"].as_f64().unwrap(),
                bar["low"].as_f64().unwrap(),
                bar["close"].as_f64().unwrap(),
            );
            assert!(h >= o.max(c) - 1e-9 && l <= o.min(c) + 1e-9 && l > 0.0);
        }
        let t: Vec<i64> = a.history.iter().map(|b| b["time"].as_i64().unwrap()).collect();
        assert!(t.windows(2).all(|w| w[1] - w[0] == 300));
    }
}
