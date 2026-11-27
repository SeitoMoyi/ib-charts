//! Option data for gamma exposure (GEX).
//!
//! A GEX job fetches the option chain for a stock / ETF / index, picks the nearest
//! expirations and strikes around the current price, and streams each option's IB model
//! gamma, implied volatility and open interest. The UI turns those into the GEX profile.
//!
//! IB limits simultaneous market-data lines (usually 100) and API messages (~50/s), so
//! options are requested a limited number at a time, at a throttled rate.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use futures::StreamExt;
use ibapi::contracts::tick_types::TickType;
use ibapi::contracts::{Contract, OptionRight, SecurityType};
use ibapi::market_data::MarketDataType;
use ibapi::market_data::realtime::{Quote, TickTypes};
use ibapi::subscriptions::{SubscriptionItem, SubscriptionItemStreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};

use crate::ib::Ib;

/// Options requested at the same time (leaves lines for charts and the watchlist).
const CONCURRENT: usize = 40;
/// One new request per this interval: request + cancel stay under IB's 50 msg/s.
const START_EVERY: Duration = Duration::from_millis(50);
/// How long to wait for an option's gamma and open interest.
const PER_OPTION: Duration = Duration::from_secs(8);
const CACHE_FOR: Duration = Duration::from_secs(300);
const MAX_OPTIONS: usize = 1200;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GexParams {
    pub symbol: String,
    /// Use at most this many expirations (nearest first).
    pub max_expiries: usize,
    /// …and only those expiring within this many days.
    pub max_days: i64,
    /// Strikes within ±range of the spot price (0.12 = ±12%).
    pub range: f64,
}

impl Default for GexParams {
    fn default() -> Self {
        Self {
            symbol: String::new(),
            max_expiries: 4,
            max_days: 45,
            range: 0.12,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionRow {
    pub expiry: String,
    pub strike: f64,
    pub call: bool,
    pub gamma: Option<f64>,
    pub iv: Option<f64>,
    pub open_interest: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GexResult {
    pub symbol: String,
    pub spot: f64,
    pub multiplier: f64,
    pub expiries: Vec<String>,
    pub rows: Vec<OptionRow>,
    pub data_type: String,
    pub requested: usize,
    pub complete: usize,
    pub fetched_at: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub state: &'static str, // running | done | error
    pub message: String,
    pub done: usize,
    pub total: usize,
    pub result: Option<Arc<GexResult>>,
}

/// A job's start time and shared status.
type Job = (Instant, Arc<Mutex<JobStatus>>);

pub struct GexJobs {
    ib: Arc<Ib>,
    demo: bool,
    jobs: Mutex<HashMap<String, Job>>,
}

impl GexJobs {
    pub fn new(ib: Arc<Ib>, demo: bool) -> Arc<Self> {
        Arc::new(Self {
            ib,
            demo,
            jobs: Mutex::new(HashMap::new()),
        })
    }

    fn key(p: &GexParams) -> String {
        format!(
            "{}|{}|{}|{:.3}",
            p.symbol.trim().to_uppercase(),
            p.max_expiries,
            p.max_days,
            p.range
        )
    }

    /// Starts a job (or reuses a recent one for the same parameters). Returns its id.
    pub async fn start(self: &Arc<Self>, mut p: GexParams, refresh: bool) -> String {
        p.symbol = p.symbol.trim().to_uppercase();
        p.max_expiries = p.max_expiries.clamp(1, 12);
        p.max_days = p.max_days.clamp(0, 400);
        p.range = p.range.clamp(0.01, 0.5);
        let key = Self::key(&p);
        let mut jobs = self.jobs.lock().await;
        jobs.retain(|_, (at, _)| at.elapsed() < CACHE_FOR * 4);
        if let Some((at, status)) = jobs.get(&key) {
            let st = status.lock().await.state;
            if st == "running" || (!refresh && st == "done" && at.elapsed() < CACHE_FOR) {
                return key;
            }
        }
        let status = Arc::new(Mutex::new(JobStatus {
            state: "running",
            message: "Starting…".into(),
            ..Default::default()
        }));
        jobs.insert(key.clone(), (Instant::now(), status.clone()));
        let me = self.clone();
        tokio::spawn(async move {
            let res = if me.demo {
                Ok(crate::demo::gex(&p))
            } else {
                me.run(&p, &status).await
            };
            let mut s = status.lock().await;
            match res {
                Ok(r) => {
                    s.state = "done";
                    s.message = format!("{} of {} options", r.complete, r.requested);
                    s.result = Some(Arc::new(r));
                }
                Err(e) => {
                    s.state = "error";
                    s.message = format!("{e:#}");
                }
            }
        });
        key
    }

    pub async fn status(&self, id: &str) -> Option<JobStatus> {
        let jobs = self.jobs.lock().await;
        let (_, s) = jobs.get(id)?;
        Some(s.lock().await.clone())
    }

    async fn run(&self, p: &GexParams, status: &Arc<Mutex<JobStatus>>) -> Result<GexResult> {
        let set = |msg: String| async move { status.lock().await.message = msg };
        set(format!("Looking up {}…", p.symbol)).await;
        let und = self.ib.resolve(&p.symbol).await?;
        let sec_type = und.contract.security_type.clone();
        if !matches!(sec_type, SecurityType::Stock | SecurityType::Index) {
            bail!("GEX works for stocks, ETFs and indices (not {sec_type:?})");
        }
        let client = self.ib.client().await?;
        client
            .switch_market_data_type(MarketDataType::DelayedFrozen)
            .await
            .map_err(|e| anyhow!("{e}"))?;

        set("Getting the spot price…".into()).await;
        let spot = spot_price(&client, &und.contract).await?;

        set("Getting the option chain…".into()).await;
        let mut chains = Vec::new();
        let mut sub = client
            .option_chain(und.contract.symbol.as_str(), sec_type, und.contract.contract_id)
            .subscribe()
            .await
            .map_err(|e| anyhow!("option chain: {e}"))?
            .filter_data();
        while let Ok(Some(c)) = tokio::time::timeout(Duration::from_secs(10), sub.next()).await {
            chains.push(c.map_err(|e| anyhow!("option chain: {e}"))?);
        }
        drop(sub);
        // SMART routing for stocks/ETFs; index options (e.g. SPX/SPXW) list on CBOE.
        let preferred = if chains.iter().any(|c| c.exchange == "SMART") {
            "SMART"
        } else {
            "CBOE"
        };
        let chains: Vec<_> = chains.into_iter().filter(|c| c.exchange == preferred).collect();
        if chains.is_empty() {
            bail!("no options found for {}", p.symbol);
        }

        // Nearest expirations, then strikes around spot.
        let today = chrono::Utc::now().date_naive().format("%Y%m%d").to_string();
        let horizon = (chrono::Utc::now() + chrono::Duration::days(p.max_days))
            .format("%Y%m%d")
            .to_string();
        let mut expiries: Vec<(String, String)> = chains
            .iter()
            .flat_map(|c| c.expirations.iter().map(move |e| (e.clone(), c.trading_class.clone())))
            .filter(|(e, _)| *e >= today && *e <= horizon)
            .collect();
        expiries.sort();
        expiries.dedup_by(|a, b| a.0 == b.0); // one trading class per date (SPXW wins dailies)
        expiries.truncate(p.max_expiries);
        if expiries.is_empty() {
            bail!("no expirations within {} days", p.max_days);
        }
        let multiplier: f64 = chains[0].multiplier.parse().unwrap_or(100.0);
        let (lo, hi) = (spot * (1.0 - p.range), spot * (1.0 + p.range));

        let mut contracts = Vec::new();
        for (exp, class) in &expiries {
            let strikes: Vec<f64> = chains
                .iter()
                .filter(|c| &c.trading_class == class)
                .flat_map(|c| c.strikes.iter().copied())
                .filter(|k| *k >= lo && *k <= hi)
                .collect();
            for k in strikes {
                for call in [true, false] {
                    contracts.push((
                        exp.clone(),
                        k,
                        call,
                        Contract {
                            symbol: und.contract.symbol.clone(),
                            security_type: SecurityType::Option,
                            last_trade_date_or_contract_month: exp.clone(),
                            strike: k,
                            right: Some(if call { OptionRight::Call } else { OptionRight::Put }),
                            exchange: preferred.into(),
                            currency: und.contract.currency.clone(),
                            multiplier: chains[0].multiplier.clone(),
                            trading_class: class.clone(),
                            ..Default::default()
                        },
                    ));
                }
            }
        }
        contracts.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        contracts.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1 && a.2 == b.2);
        if contracts.len() > MAX_OPTIONS {
            bail!(
                "{} options is too many — narrow the strike range or use fewer expirations",
                contracts.len()
            );
        }
        let total = contracts.len();
        {
            let mut s = status.lock().await;
            s.total = total;
            s.message = format!("Fetching {total} options…");
        }

        let sem = Arc::new(Semaphore::new(CONCURRENT));
        let data_types = Arc::new(std::sync::Mutex::new(HashMap::<String, usize>::new()));
        let mut tasks = Vec::with_capacity(total);
        for (exp, strike, call, contract) in contracts {
            let permit = sem.clone().acquire_owned().await?;
            tokio::time::sleep(START_EVERY).await;
            let (client, status, data_types) = (client.clone(), status.clone(), data_types.clone());
            tasks.push(tokio::spawn(async move {
                let row = fetch_option(&client, &contract, exp, strike, call, &data_types).await;
                drop(permit);
                status.lock().await.done += 1;
                row
            }));
        }
        let mut rows = Vec::with_capacity(total);
        for t in tasks {
            if let Ok(Some(r)) = t.await {
                rows.push(r);
            }
        }
        let complete = rows.iter().filter(|r| r.gamma.is_some() && r.open_interest.is_some()).count();
        if complete == 0 {
            bail!(
                "IB returned no option greeks/open interest — US options data (OPRA) is needed. \
                 Check Account → Market Data Subscriptions in IBKR Client Portal."
            );
        }
        let data_type = data_types
            .lock()
            .unwrap()
            .iter()
            .max_by_key(|(_, n)| **n)
            .map(|(t, _)| t.clone())
            .unwrap_or_default();
        Ok(GexResult {
            symbol: und.label.clone(),
            spot,
            multiplier,
            expiries: expiries.into_iter().map(|(e, _)| e).collect(),
            rows,
            data_type,
            requested: total,
            complete,
            fetched_at: chrono::Utc::now().timestamp(),
        })
    }
}

/// Last price of the underlying (falls back to the bid/ask midpoint or the close).
async fn spot_price(client: &ibapi::Client, contract: &Contract) -> Result<f64> {
    let mut sub = client
        .market_data(contract)
        .subscribe()
        .await
        .map_err(|e| anyhow!("spot price: {e}"))?;
    let mut q = Quote::default();
    let deadline = Instant::now() + Duration::from_secs(6);
    while let Ok(Some(item)) = tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), sub.next()).await {
        if let Ok(SubscriptionItem::Data(t)) = item {
            q.apply(&t);
            if q.last.is_some_and(|v| v > 0.0) {
                break;
            }
        }
    }
    let mid = q.bid.zip(q.ask).filter(|(b, a)| *b > 0.0 && *a > 0.0).map(|(b, a)| (b + a) / 2.0);
    q.last
        .filter(|v| *v > 0.0)
        .or(mid)
        .or(q.close)
        .ok_or_else(|| anyhow!("no price for the underlying (market data subscription?)"))
}

/// Streams one option until both gamma and open interest arrive (or time runs out).
async fn fetch_option(
    client: &ibapi::Client,
    contract: &Contract,
    expiry: String,
    strike: f64,
    call: bool,
    data_types: &std::sync::Mutex<HashMap<String, usize>>,
) -> Option<OptionRow> {
    let mut row = OptionRow {
        expiry,
        strike,
        call,
        ..Default::default()
    };
    // Generic tick 101 = open interest.
    let mut sub = client.market_data(contract).generic_ticks(&["101"]).subscribe().await.ok()?;
    let deadline = Instant::now() + PER_OPTION;
    while let Ok(Some(item)) = tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), sub.next()).await {
        match item {
            Ok(SubscriptionItem::Data(TickTypes::OptionComputation(c)))
                if matches!(c.field, TickType::ModelOption | TickType::DelayedModelOption) =>
            {
                row.gamma = c.gamma.filter(|g| g.is_finite() && *g >= 0.0).or(row.gamma);
                row.iv = c.implied_volatility.filter(|v| v.is_finite() && *v > 0.0).or(row.iv);
            }
            Ok(SubscriptionItem::Data(TickTypes::Size(s)))
                if matches!(
                    s.tick_type,
                    TickType::OptionCallOpenInterest | TickType::OptionPutOpenInterest | TickType::OpenInterest
                ) =>
            {
                row.open_interest = Some(s.size);
            }
            Ok(SubscriptionItem::Data(TickTypes::MarketDataType(t))) => {
                *data_types.lock().unwrap().entry(format!("{t:?}")).or_default() += 1;
            }
            Err(_) => return None, // e.g. no such strike for this expiry
            _ => {}
        }
        if row.gamma.is_some() && row.open_interest.is_some() {
            break;
        }
    }
    // Dropping `sub` cancels the market-data request.
    Some(row)
}
