//! Symbol search (IB `reqMatchingSymbols`).

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use ibapi::contracts::SecurityType;
use serde::{Deserialize, Serialize};

use super::AppState;

#[derive(Deserialize)]
pub struct SearchParams {
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

pub async fn search(State(st): State<AppState>, Query(p): Query<SearchParams>) -> Response {
    let q = p.q.trim();
    if q.is_empty() || q.len() > 32 {
        return Json(Vec::<SearchHit>::new()).into_response();
    }
    let result = async {
        let client = st.ib.client().await?;
        let hits = client
            .matching_symbols(q)
            .await
            .map_err(|e| anyhow::anyhow!("symbol search failed: {e}"))?;
        Ok::<_, anyhow::Error>(hits.into_iter().filter_map(|d| hit(d.contract)).collect::<Vec<_>>())
    }
    .await;
    match result {
        Ok(hits) => Json(hits).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
    }
}

fn hit(c: ibapi::contracts::Contract) -> Option<SearchHit> {
    let (input, kind) = match c.security_type {
        // Non-USD listings need exchange + currency or they'd resolve to the US line.
        SecurityType::Stock if c.currency.as_str() != "USD" => (format!("{}:{}:{}", c.symbol, c.primary_exchange, c.currency), "Stock"),
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
}
