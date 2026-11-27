//! Chart timeframes and how much history to load for each.
//!
//! Any bar size IB supports can be used: `1s 5s 10s 15s 30s`, `1m 2m 3m 5m 10m 15m 20m 30m`,
//! `1h 2h 3h 4h 8h`, `1D 1W 1M`. History lengths stay within IB's historical-data limits.

use ibapi::market_data::historical::{BarSize, Duration};

pub struct Timeframe {
    pub bar_size: BarSize,
    pub duration: Duration,
    pub intraday: bool,
    /// Bar length in seconds (months count as 30 days).
    pub seconds: i64,
}

pub fn parse(id: &str) -> Option<Timeframe> {
    let id = id.trim();
    let (num, unit) = id.split_at(id.find(|c: char| !c.is_ascii_digit())?);
    let n: u32 = num.parse().ok()?;
    let (bar_size, duration, seconds) = match (unit, n) {
        ("s", 1) => (BarSize::Sec, Duration::seconds(1800), 1),
        ("s", 5) => (BarSize::Sec5, Duration::seconds(7200), 5),
        ("s", 10) => (BarSize::Sec10, Duration::seconds(14400), 10),
        ("s", 15) => (BarSize::Sec15, Duration::seconds(14400), 15),
        ("s", 30) => (BarSize::Sec30, Duration::seconds(28800), 30),
        ("m", 1) => (BarSize::Min, Duration::days(2), 60),
        ("m", 2) => (BarSize::Min2, Duration::days(3), 120),
        ("m", 3) => (BarSize::Min3, Duration::days(5), 180),
        ("m", 5) => (BarSize::Min5, Duration::weeks(1), 300),
        ("m", 10) => (BarSize::Min10, Duration::weeks(2), 600),
        ("m", 15) => (BarSize::Min15, Duration::months(1), 900),
        ("m", 20) => (BarSize::Min20, Duration::months(1), 1200),
        ("m", 30) => (BarSize::Min30, Duration::months(2), 1800),
        ("h", 1) => (BarSize::Hour, Duration::months(6), 3600),
        ("h", 2) => (BarSize::Hour2, Duration::years(1), 7200),
        ("h", 3) => (BarSize::Hour3, Duration::years(1), 10800),
        ("h", 4) => (BarSize::Hour4, Duration::years(1), 14400),
        ("h", 8) => (BarSize::Hour8, Duration::years(2), 28800),
        ("D", 1) => (BarSize::Day, Duration::years(5), 86400),
        ("W", 1) => (BarSize::Week, Duration::years(15), 7 * 86400),
        ("M", 1) => (BarSize::Month, Duration::years(30), 30 * 86400),
        _ => return None,
    };
    Some(Timeframe {
        bar_size,
        duration,
        intraday: seconds < 86400,
        seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_and_rejects_others() {
        for id in ["1s", "30s", "1m", "3m", "5m", "45m", "2h", "8h", "1D", "1W", "1M"] {
            assert_eq!(parse(id).is_some(), id != "45m", "{id}");
        }
        assert!(parse("1D").is_some_and(|t| !t.intraday));
        assert_eq!(parse("2h").unwrap().seconds, 7200);
        assert!(parse("").is_none() && parse("m").is_none() && parse("5x").is_none());
    }
}
