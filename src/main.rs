//! IB Charts: read-only, TradingView-style charts fed by your own IB Gateway / TWS market data.
//!
//! The app runs a small local server (HTTP + WebSocket) that talks to the IB API and serves
//! the chart UI. By default the UI is shown in a native desktop window (Tauri); with
//! `--browser` it is opened in your normal web browser instead.
//!
//! This program never places, modifies or cancels orders — it only requests market data.

// Don't open a console window next to the app on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod contracts;
mod demo;
mod desktop;
mod gateway;
mod gex;
mod ib;
mod quotes;
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

    /// Run without the desktop window and open the UI in your web browser instead.
    #[arg(long)]
    pub browser: bool,

    /// With --browser: don't open the browser automatically (server only).
    #[arg(long, requires = "browser")]
    pub no_open: bool,

    /// Address the UI server listens on. Default: 127.0.0.1:8088 with --browser,
    /// a random free localhost port for the desktop app.
    #[arg(long, env = "LISTEN")]
    pub listen: Option<String>,

    /// Use synthetic demo data instead of connecting to IB (try the app without an account).
    #[arg(long)]
    pub demo: bool,

    /// Where watchlists, drawings, scripts and layouts are saved.
    /// Defaults to the platform's per-user app-data directory.
    #[arg(long, env = "IB_CHARTS_DATA")]
    pub data_dir: Option<std::path::PathBuf>,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,ibapi=warn")))
        .init();
    let args = Args::parse();

    // One Tokio runtime shared by the server, the IB client and Tauri.
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    tauri::async_runtime::set(rt.handle().clone());

    let (url, gw) = rt.block_on(start_server(&args))?;

    if args.browser {
        if !args.no_open
            && let Err(e) = opener::open_browser(&url)
        {
            tracing::warn!("could not open browser: {e}");
        }
        rt.block_on(async {
            let _ = tokio::signal::ctrl_c().await;
            gw.shutdown().await;
        });
        return Ok(());
    }

    let handle = rt.handle().clone();
    desktop::run(
        url,
        desktop::Hooks {
            // Quitting IB Charts also stops the Gateway it started (if enabled).
            on_exit: Box::new(move || handle.block_on(gw.shutdown())),
        },
    )
}

/// Starts the Gateway supervisor, binds the UI server and spawns it. Returns the UI URL.
async fn start_server(args: &Args) -> Result<(String, Arc<gateway::Gateway>)> {
    let ib = Arc::new(ib::Ib::new(format!("{}:{}", args.ib_host, args.ib_port), args.client_id));

    let store = store::Store::open(match &args.data_dir {
        Some(d) => d.clone(),
        None => store::Store::default_root()?,
    })?;
    tracing::info!("data directory: {}", store.root().display());
    let gateway = gateway::Gateway::new(store.clone(), ib.clone(), args.ib_host.clone(), args.ib_port, args.demo).await;
    tracing::info!("IB API address: {}", ib.address());

    let listen = args
        .listen
        .clone()
        .unwrap_or_else(|| if args.browser { "127.0.0.1:8088" } else { "127.0.0.1:0" }.to_string());
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("cannot listen on {listen}"))?;
    let addr = listener.local_addr()?;
    let url = format!("http://{addr}/");
    tracing::info!("chart UI at {url}");

    let (events, _) = tokio::sync::broadcast::channel(64);
    let ev = events.clone();
    match store.watch_scripts(move |name| {
        let _ = ev.send(serde_json::json!({ "type": "scriptChanged", "name": name }));
    }) {
        // The watcher stops when dropped; it lives for the whole run.
        Ok(w) => std::mem::forget(w),
        Err(e) => tracing::warn!("not watching the scripts folder: {e}"),
    }

    let state = server::AppState {
        ib: ib.clone(),
        store,
        gateway: gateway.clone(),
        quotes: quotes::QuoteHub::new(ib.clone(), args.demo),
        gex: gex::GexJobs::new(ib.clone(), args.demo),
        demo: args.demo,
        events,
        loopback_only: addr.ip().is_loopback(),
    };
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, server::router(state)).await {
            tracing::error!("server stopped: {e}");
        }
    });
    Ok((url, gateway))
}
