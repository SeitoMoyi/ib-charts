//! ib-charts: read-only, TradingView-style charts fed by your own IB Gateway / TWS market data.
//!
//! The binary connects to the IB API socket, serves a small web UI (embedded in the binary),
//! and streams historical + live-updating bars to the browser over a WebSocket.
//!
//! This program never places, modifies or cancels orders — it only requests market data.

mod contracts;
mod ib;
mod server;
mod store;
mod timeframe;

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug, Clone)]
#[command(version, about = "Read-only TradingView-style charts powered by IB Gateway / TWS market data")]
pub struct Args {
    /// IB Gateway / TWS host.
    #[arg(long, env = "IB_HOST", default_value = "127.0.0.1")]
    pub ib_host: String,

    /// IB API port. Gateway: 4001 live / 4002 paper. TWS: 7496 live / 7497 paper.
    #[arg(long, env = "IB_PORT", default_value_t = 4001)]
    pub ib_port: u16,

    /// API client id. Must be unique among apps connected to the same Gateway.
    #[arg(long, env = "IB_CLIENT_ID", default_value_t = 77)]
    pub client_id: i32,

    /// Address the web UI listens on. Keep it on 127.0.0.1 unless you know what you're doing.
    #[arg(long, env = "LISTEN", default_value = "127.0.0.1:8088")]
    pub listen: String,

    /// Don't open the browser automatically.
    #[arg(long)]
    pub no_open: bool,

    /// Where watchlists, drawings, scripts and layouts are saved.
    /// Defaults to the platform's per-user app-data directory.
    #[arg(long, env = "IB_CHARTS_DATA")]
    pub data_dir: Option<std::path::PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,ibapi=warn")))
        .init();

    let args = Args::parse();
    let ib = Arc::new(ib::Ib::new(format!("{}:{}", args.ib_host, args.ib_port), args.client_id));

    // Try to connect up front so problems show immediately; the UI will retry on demand otherwise.
    match ib.client().await {
        Ok(c) => tracing::info!(
            "connected to IB at {}:{} (server version {})",
            args.ib_host,
            args.ib_port,
            c.server_version()
        ),
        Err(e) => tracing::warn!("{e:#} — will retry when the chart requests data"),
    }

    let store = store::Store::open(match &args.data_dir {
        Some(d) => d.clone(),
        None => store::Store::default_root()?,
    })?;
    tracing::info!("data directory: {}", store.root().display());

    let listener = tokio::net::TcpListener::bind(&args.listen)
        .await
        .with_context(|| format!("cannot listen on {}", args.listen))?;
    let url = format!("http://{}", args.listen);
    tracing::info!("chart UI at {url}");
    if !args.no_open {
        open_browser(&url);
    }

    let loopback_only = listener.local_addr()?.ip().is_loopback();
    let state = server::AppState { ib, store, loopback_only };
    axum::serve(listener, server::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(e) = r {
        tracing::debug!("could not open browser: {e}");
    }
}
