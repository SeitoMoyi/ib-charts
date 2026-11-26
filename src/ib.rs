//! Shared, lazily (re)connecting IB API client.

use std::sync::Arc;

use anyhow::{Context, Result};
use ibapi::Client;
use tokio::sync::Mutex;

pub struct Ib {
    addr: String,
    client_id: i32,
    client: Mutex<Option<Arc<Client>>>,
}

impl Ib {
    pub fn new(addr: String, client_id: i32) -> Self {
        Self {
            addr,
            client_id,
            client: Mutex::new(None),
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
}
