//! Chart timeframes and how much history to load for each.

use ibapi::market_data::historical::{BarSize, Duration};

pub struct Timeframe {
    pub bar_size: BarSize,
    pub duration: Duration,
    pub intraday: bool,
}

/// Timeframe ids used by the UI. History lengths are chosen to stay well within
/// IB's historical-data limits while still giving a useful amount of context.
pub fn parse(id: &str) -> Option<Timeframe> {
    let (bar_size, duration, intraday) = match id {
        "1m" => (BarSize::Min, Duration::days(2), true),
        "5m" => (BarSize::Min5, Duration::weeks(1), true),
        "15m" => (BarSize::Min15, Duration::months(1), true),
        "30m" => (BarSize::Min30, Duration::months(2), true),
        "1h" => (BarSize::Hour, Duration::months(6), true),
        "4h" => (BarSize::Hour4, Duration::years(1), true),
        "1D" => (BarSize::Day, Duration::years(5), false),
        "1W" => (BarSize::Week, Duration::years(15), false),
        "1M" => (BarSize::Month, Duration::years(30), false),
        _ => return None,
    };
    Some(Timeframe {
        bar_size,
        duration,
        intraday,
    })
}
