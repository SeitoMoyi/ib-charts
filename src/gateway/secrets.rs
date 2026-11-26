//! IB password storage in the OS credential store
//! (macOS Keychain, Windows Credential Manager, Linux Secret Service).

use anyhow::{Context, Result};

const SERVICE: &str = "ib-charts";

fn entry(username: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, username).context("cannot open the OS credential store")
}

pub fn set_password(username: &str, password: &str) -> Result<()> {
    entry(username)?
        .set_password(password)
        .context("cannot save password to the OS credential store")
}

pub fn get_password(username: &str) -> Result<Option<String>> {
    match entry(username)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).context("cannot read password from the OS credential store"),
    }
}

pub fn has_password(username: &str) -> bool {
    !username.is_empty() && matches!(get_password(username), Ok(Some(_)))
}

pub fn delete_password(username: &str) -> Result<()> {
    match entry(username)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).context("cannot delete password from the OS credential store"),
    }
}
