//! Shared, lazily (re)connecting IB API client.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use ibapi::Client;
use tokio::sync::Mutex;

use crate::contracts::{self, Resolved};

/// How long a symbol -> contract resolution is reused (futures roll, so not forever).
const RESOLVE_TTL: Duration = Duration::from_secs(3600);

pub struct Ib {
    addr: std::sync::Mutex<String>,
    client_id: i32,
    client: Mutex<Option<Arc<Client>>>,
    resolved: Mutex<HashMap<String, (Instant, Arc<Resolved>)>>,
}

impl Ib {
    pub fn new(addr: String, client_id: i32) -> Self {
        Self {
            addr: std::sync::Mutex::new(addr),
            client_id,
            client: Mutex::new(None),
            resolved: Mutex::new(HashMap::new()),
        }
    }

    pub fn address(&self) -> String {
        self.addr.lock().unwrap().clone()
    }

    /// Points the client at a different Gateway/TWS address; the next request reconnects.
    pub async fn set_address(&self, addr: String) {
        if *self.addr.lock().unwrap() == addr {
            return;
        }
        tracing::info!("IB API address is now {addr}");
        *self.addr.lock().unwrap() = addr;
        *self.client.lock().await = None;
        self.resolved.lock().await.clear();
    }

    /// Drops the current connection so the next request reconnects (e.g. after a Gateway restart).
    pub async fn reset(&self) {
        *self.client.lock().await = None;
    }

    /// Returns a connected client, connecting (or reconnecting after e.g. the
    /// Gateway's daily restart) if needed.
    pub async fn client(&self) -> Result<Arc<Client>> {
        let mut slot = self.client.lock().await;
        if let Some(c) = slot.as_ref() {
            if c.is_connected() {
                return Ok(c.clone());
            }
            tracing::warn!("IB connection lost; reconnecting");
        }
        *slot = None;
        let addr = self.address();
        let connect = tokio::time::timeout(Duration::from_secs(15), Client::connect(&addr, self.client_id));
        let client = connect
            .await
            .map_err(|_| anyhow::anyhow!("timed out"))
            .and_then(|r| r.map_err(Into::into))
            .with_context(|| {
                format!(
                    "cannot connect to IB at {} with client id {} — is IB Gateway running, \
                 API enabled, port correct and client id unused? (If the connection is closed \
                 immediately, another program may be using this port: pick a different API port.)",
                    addr, self.client_id
                )
            })?;
        let client = Arc::new(client);
        *slot = Some(client.clone());
        Ok(client)
    }

    /// Resolves user input to a contract, with caching.
    pub async fn resolve(&self, input: &str) -> Result<Arc<Resolved>> {
        let norm = input.trim().to_uppercase();
        if let Some((at, r)) = self.resolved.lock().await.get(&norm)
            && at.elapsed() < RESOLVE_TTL
        {
            return Ok(r.clone());
        }
        let client = self.client().await?;
        let r = Arc::new(contracts::resolve(&client, &norm).await?);
        self.resolved.lock().await.insert(norm, (Instant::now(), r.clone()));
        Ok(r)
    }
}
