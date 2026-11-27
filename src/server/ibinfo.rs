//! Read-only account and research data from IB: positions, fills, market scanner,
//! news headlines/articles and earnings dates. (Nothing here can place or change orders.)

use std::time::Duration;

use anyhow::{Result, anyhow};
use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use ibapi::orders::{ExecutionFilter, Executions};
use ibapi::prelude::PositionUpdate;
use ibapi::scanner::ScannerSubscription;
use ibapi::subscriptions::SubscriptionItemStreamExt;
use serde::Deserialize;
use serde_json::{Value, json};

use super::AppState;

const TIMEOUT: Duration = Duration::from_secs(15);

fn reply(r: Result<Value>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
    }
}

/// Runs `f` with an overall time limit.
async fn limited<T>(f: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(TIMEOUT, f)
        .await
        .map_err(|_| anyhow!("IB didn't answer in time"))?
}

// ---------- positions & fills ----------

pub async fn positions(State(st): State<AppState>) -> Response {
    if st.demo {
        return Json(crate::demo::positions()).into_response();
    }
    reply(
        limited(async {
            let client = st.ib.client().await?;
            let mut sub = client.positions().await.map_err(|e| anyhow!("{e}"))?.filter_data();
            let mut out = Vec::new();
            while let Some(item) = sub.next().await {
                match item.map_err(|e| anyhow!("{e}"))? {
                    PositionUpdate::Position(p) if p.position != 0.0 => out.push(json!({
                        "account": p.account,
                        "conId": p.contract.contract_id,
                        "symbol": p.contract.symbol.to_string(),
                        "localSymbol": p.contract.local_symbol,
                        "secType": format!("{:?}", p.contract.security_type),
                        "currency": p.contract.currency.to_string(),
                        "position": p.position,
                        "avgCost": p.average_cost,
                        "multiplier": p.contract.multiplier,
                    })),
                    PositionUpdate::PositionEnd => break,
                    _ => {}
                }
            }
            Ok(json!(out))
        })
        .await,
    )
}

pub async fn executions(State(st): State<AppState>) -> Response {
    if st.demo {
        return Json(crate::demo::executions()).into_response();
    }
    reply(
        limited(async {
            let client = st.ib.client().await?;
            let mut sub = client
                .executions(ExecutionFilter::default())
                .await
                .map_err(|e| anyhow!("{e}"))?
                .filter_data();
            let mut out = Vec::new();
            while let Some(item) = sub.next().await {
                if let Executions::ExecutionData(d) = item.map_err(|e| anyhow!("{e}"))? {
                    let e = d.execution;
                    out.push(json!({
                        "conId": d.contract.contract_id,
                        "symbol": d.contract.symbol.to_string(),
                        "side": if format!("{:?}", e.side).starts_with('B') { "buy" } else { "sell" },
                        "shares": e.shares,
                        "price": e.price,
                        "time": e.time,
                        "exchange": e.exchange,
                    }));
                }
            }
            Ok(json!(out))
        })
        .await,
    )
}

// ---------- market scanner ----------

#[derive(Deserialize)]
pub struct ScanParams {
    code: String,
    #[serde(default = "default_location")]
    location: String,
    #[serde(default = "default_instrument")]
    instrument: String,
    #[serde(default)]
    above_price: Option<f64>,
    #[serde(default)]
    above_volume: Option<i32>,
}

fn default_location() -> String {
    "STK.US.MAJOR".into()
}
fn default_instrument() -> String {
    "STK".into()
}

pub async fn scanner(State(st): State<AppState>, Query(p): Query<ScanParams>) -> Response {
    if st.demo {
        return Json(crate::demo::scanner(&p.code)).into_response();
    }
    reply(
        limited(async {
            let client = st.ib.client().await?;
            let params = ScannerSubscription {
                number_of_rows: 30,
                instrument: Some(p.instrument.clone()),
                location_code: Some(p.location.clone()),
                scan_code: Some(p.code.clone()),
                above_price: p.above_price,
                above_volume: p.above_volume,
                ..Default::default()
            };
            let mut sub = client
                .scanner_subscription(&params, &[])
                .await
                .map_err(|e| anyhow!("{e}"))?
                .filter_data();
            // The first result set is all we need; dropping the subscription cancels the scan.
            let rows = sub
                .next()
                .await
                .ok_or_else(|| anyhow!("scanner returned nothing"))?
                .map_err(|e| anyhow!("{e}"))?;
            Ok(json!(
                rows.into_iter()
                    .map(|r| {
                        let c = &r.contract_details.contract;
                        json!({
                            "rank": r.rank,
                            "symbol": c.symbol.to_string(),
                            "exchange": c.primary_exchange.to_string(),
                            "currency": c.currency.to_string(),
                            "name": r.contract_details.long_name,
                        })
                    })
                    .collect::<Vec<_>>()
            ))
        })
        .await,
    )
}

// ---------- news ----------

#[derive(Deserialize)]
pub struct SymbolParam {
    symbol: String,
}

pub async fn news(State(st): State<AppState>, Query(p): Query<SymbolParam>) -> Response {
    if st.demo {
        return Json(crate::demo::news(&p.symbol)).into_response();
    }
    reply(
        limited(async {
            let r = st.ib.resolve(&p.symbol).await?;
            let client = st.ib.client().await?;
            let providers = client.news_providers().await.map_err(|e| anyhow!("news providers: {e}"))?;
            if providers.is_empty() {
                return Ok(json!({ "providers": [], "items": [], "note": "No news providers on this IB account." }));
            }
            let codes: Vec<&str> = providers.iter().map(|p| p.code.as_str()).collect();
            let end = time::OffsetDateTime::now_utc();
            let start = end - time::Duration::days(30);
            let mut sub = client
                .historical_news(r.contract.contract_id, &codes, start, end, 50)
                .await
                .map_err(|e| anyhow!("{e}"))?
                .filter_data();
            let mut items = Vec::new();
            while let Some(a) = sub.next().await {
                let a = a.map_err(|e| anyhow!("{e}"))?;
                items.push(json!({
                    "time": a.time.unix_timestamp(),
                    "provider": a.provider_code,
                    "id": a.article_id,
                    "headline": a.headline,
                }));
            }
            let names: Vec<_> = providers.iter().map(|p| json!({ "code": p.code, "name": p.name })).collect();
            Ok(json!({ "providers": names, "items": items }))
        })
        .await,
    )
}

#[derive(Deserialize)]
pub struct ArticleParams {
    provider: String,
    id: String,
}

pub async fn news_article(State(st): State<AppState>, Query(p): Query<ArticleParams>) -> Response {
    if st.demo {
        return Json(json!({ "binary": false, "text": "<p>This is demo news. Connect IB Gateway for real headlines.</p>" }))
            .into_response();
    }
    reply(
        limited(async {
            let client = st.ib.client().await?;
            let a = client.news_article(&p.provider, &p.id).await.map_err(|e| anyhow!("{e}"))?;
            Ok(json!({ "binary": format!("{:?}", a.article_type).contains("Binary"), "text": a.article_text }))
        })
        .await,
    )
}

// ---------- earnings (Wall Street Horizon) ----------

pub async fn earnings(State(st): State<AppState>, Query(p): Query<SymbolParam>) -> Response {
    if st.demo {
        return Json(crate::demo::earnings()).into_response();
    }
    reply(
        limited(async {
            let r = st.ib.resolve(&p.symbol).await?;
            let client = st.ib.client().await?;
            client.wsh_metadata().await.map_err(|e| anyhow!("Wall Street Horizon: {e}"))?;
            let today = time::OffsetDateTime::now_utc().date();
            let data = client
                .wsh_event_data_by_contract(r.contract.contract_id)
                .starting(today - time::Duration::days(730))
                .ending(today + time::Duration::days(180))
                .limit(100)
                .fetch()
                .await
                .map_err(|e| anyhow!("Wall Street Horizon: {e}"))?;
            let v: Value = serde_json::from_str(&data.data_json).unwrap_or(Value::Null);
            let mut dates = Vec::new();
            collect_earnings(&v, &mut dates);
            dates.sort();
            dates.dedup();
            Ok(json!(dates))
        })
        .await,
    )
}

/// Pulls `YYYYMMDD` earnings dates out of WSH's JSON, whatever its exact nesting.
fn collect_earnings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            let is_earnings = m
                .get("event_type")
                .and_then(Value::as_str)
                .is_some_and(|t| t.contains("wshe_ed") || t.contains("earnings"));
            for (k, val) in m {
                if let Some(s) = val.as_str()
                    && (k.contains("earnings_date") || (is_earnings && k.contains("date")))
                {
                    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).take(8).collect();
                    if digits.len() == 8 {
                        out.push(digits);
                    }
                }
                collect_earnings(val, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_earnings(x, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_earnings_dates() {
        let v = json!({ "events": [
            { "event_type": "wshe_ed", "data": { "earnings_date": "20260129", "time_of_day": "AMC" } },
            { "event_type": "wshe_div", "data": { "ex_date": "20260210" } },
            { "event_type": "wshe_ed", "date": "2026-04-30" }
        ]});
        let mut d = Vec::new();
        collect_earnings(&v, &mut d);
        d.sort();
        assert_eq!(d, vec!["20260129", "20260430"]);
    }
}
