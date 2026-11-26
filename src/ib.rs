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
    addr: String,
    client_id: i32,
    client: Mutex<Option<Arc<Client>>>,
    resolved: Mutex<HashMap<String, (Instant, Arc<Resolved>)>>,
}

impl Ib {
    pub fn new(addr: String, client_id: i32) -> Self {
        Self {
            addr,
            client_id,
            client: Mutex::new(None),
            resolved: Mutex::new(HashMap::new()),
        }
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
        let client = Client::connect(&self.addr, self.client_id).await.with_context(|| {
            format!(
                "cannot connect to IB at {} with client id {} — is IB Gateway running, \
                 API enabled, port correct and client id unused?",
                self.addr, self.client_id
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
