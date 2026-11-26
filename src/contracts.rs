//! Turning what the user types into a fully resolved IB contract.
//!
//! Syntax:
//! - `AAPL`              US stock (SMART routing, USD)
//! - `7203:TSEJ:JPY`     stock with explicit exchange and currency (`SYMBOL[:EXCHANGE[:CURRENCY]]`)
//! - `EUR.USD`           forex pair on IDEALPRO
//! - `/ES`, `/CL:NYMEX`  front-month future (optional exchange)
//! - `^SPX`              index
//! - `$BTC`              crypto (PAXOS)

use anyhow::{Result, anyhow, bail};
use ibapi::Client;
use ibapi::contracts::{Contract, SecurityType};
use ibapi::market_data::historical::WhatToShow;
use time::OffsetDateTime;

pub struct Resolved {
    pub contract: Contract,
    /// Short label shown on the chart, e.g. `AAPL` or `ESZ6`.
    pub label: String,
    /// Long description, e.g. `APPLE INC · NASDAQ · USD`.
    pub description: String,
    pub what_to_show: WhatToShow,
    /// Whether bars carry meaningful volume.
    pub has_volume: bool,
    /// Minimum price increment, used for price formatting.
    pub min_tick: f64,
}

fn parse_query(input: &str) -> Result<Contract> {
    let s = input.trim().to_uppercase();
    if s.is_empty() {
        bail!("empty symbol");
    }

    if let Some(rest) = s.strip_prefix('/') {
        let mut parts = rest.split(':');
        let sym = parts.next().unwrap_or_default();
        let mut b = Contract::futures(sym).any_month();
        if let Some(ex) = parts.next().filter(|e| !e.is_empty()) {
            b = b.on_exchange(ex);
        }
        if let Some(cur) = parts.next().filter(|c| !c.is_empty()) {
            b = b.in_currency(cur);
        }
        return Ok(b.build());
    }
    if let Some(rest) = s.strip_prefix('^') {
        // Leave the exchange blank (unless given, e.g. `^VIX:CBOE`) and let IB find the listing:
        // indices live on different exchanges (SPX: CBOE, NDX: NASDAQ, DAX: EUREX, ...).
        let mut parts = rest.split(':');
        return Ok(Contract {
            symbol: parts.next().unwrap_or_default().into(),
            security_type: SecurityType::Index,
            exchange: parts.next().unwrap_or_default().into(),
            currency: parts.next().unwrap_or_default().into(),
            ..Default::default()
        });
    }
    if let Some(sym) = s.strip_prefix('$') {
        return Ok(Contract::crypto(sym).build());
    }
    let is_fx_pair = |b: &str, q: &str| b.len() == 3 && q.len() == 3 && b.chars().chain(q.chars()).all(|c| c.is_ascii_alphabetic());
    if let Some((base, quote)) = s.split_once('.').filter(|(b, q)| is_fx_pair(b, q)) {
        return Ok(Contract::forex(base, quote).build());
    }

    let mut parts = s.split(':');
    let sym = parts.next().unwrap_or_default();
    let mut b = Contract::stock(sym);
    if let Some(ex) = parts.next().filter(|e| !e.is_empty()) {
        b = b.on_exchange(ex);
    }
    if let Some(cur) = parts.next().filter(|c| !c.is_empty()) {
        b = b.in_currency(cur);
    }
    Ok(b.build())
}

/// Resolve user input into a concrete contract via `reqContractDetails`.
pub async fn resolve(client: &Client, input: &str) -> Result<Resolved> {
    let query = parse_query(input)?;
    let mut details = client
        .contract_details(&query)
        .await
        .map_err(|e| anyhow!("contract lookup for '{input}' failed: {e}"))?;

    if query.security_type == SecurityType::Future {
        // Pick the nearest expiry that hasn't passed yet.
        let today = OffsetDateTime::now_utc();
        let today = format!("{:04}{:02}{:02}", today.year(), today.month() as u8, today.day());
        details.retain(|d| expiry_key(&d.contract.last_trade_date_or_contract_month) >= today);
        details.sort_by(|a, b| {
            expiry_key(&a.contract.last_trade_date_or_contract_month).cmp(&expiry_key(&b.contract.last_trade_date_or_contract_month))
        });
    }

    let d = details
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no contract found for '{input}'"))?;
    let c = d.contract;

    let label = match c.security_type {
        SecurityType::Future => non_empty(&c.local_symbol).unwrap_or(c.symbol.as_str()).to_string(),
        SecurityType::ForexPair => format!("{}.{}", c.symbol, c.currency),
        _ => c.symbol.to_string(),
    };
    let exchange = non_empty(c.primary_exchange.as_str()).unwrap_or(c.exchange.as_str());
    let name = non_empty(&d.long_name).unwrap_or(&d.market_name);
    let description = [name, exchange, c.currency.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");

    let what_to_show = match c.security_type {
        SecurityType::ForexPair => WhatToShow::MidPoint,
        // IB rejects AGGTRADES for live-updating history, so crypto charts use midpoint.
        SecurityType::Crypto => WhatToShow::MidPoint,
        _ => WhatToShow::Trades,
    };

    let has_volume = what_to_show == WhatToShow::Trades && c.security_type != SecurityType::Index;

    Ok(Resolved {
        contract: c,
        label,
        description,
        what_to_show,
        has_volume,
        min_tick: d.min_tick,
    })
}

/// Normalises `YYYYMM` / `YYYYMMDD` expiries so they compare correctly.
fn expiry_key(s: &str) -> String {
    let s: String = s.chars().take(8).collect();
    if s.len() == 6 { format!("{s}31") } else { s }
}

fn non_empty(s: &str) -> Option<&str> {
    (!s.is_empty()).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_symbol_syntax() {
        assert_eq!(parse_query("aapl").unwrap().security_type, SecurityType::Stock);
        assert_eq!(parse_query("EUR.USD").unwrap().security_type, SecurityType::ForexPair);
        assert_eq!(parse_query("/ES").unwrap().security_type, SecurityType::Future);
        assert_eq!(parse_query("^SPX").unwrap().security_type, SecurityType::Index);
        assert_eq!(parse_query("$BTC").unwrap().security_type, SecurityType::Crypto);
        assert_eq!(parse_query("BRK.B").unwrap().security_type, SecurityType::Stock);
        let c = parse_query("7203:TSEJ:JPY").unwrap();
        assert_eq!((c.exchange.as_str(), c.currency.as_str()), ("TSEJ", "JPY"));
        assert!(parse_query("  ").is_err());
    }

    #[test]
    fn expiry_ordering() {
        assert!(expiry_key("202612") > expiry_key("20261218"));
        assert!(expiry_key("20270319") > expiry_key("202612"));
    }
}
