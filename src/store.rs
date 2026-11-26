//! Simple file-backed key/value storage in the platform's app-data directory.
//!
//! Layout: `<data dir>/<namespace>/<encoded key>.<ext>` where scripts are stored as
//! `.js` (so they can be edited in any editor) and everything else as `.json`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// Namespaces the UI is allowed to use.
pub const NAMESPACES: &[&str] = &["settings", "watchlist", "drawings", "scripts", "layouts", "alerts", "templates"];

pub const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root).with_context(|| format!("cannot create data directory {}", root.display()))?;
        Ok(Self { root })
    }

    /// The default per-user data directory, e.g. `~/Library/Application Support/io.github.ib-charts`.
    pub fn default_root() -> Result<PathBuf> {
        let dirs = directories::ProjectDirs::from("io.github", "", "ib-charts").context("cannot determine the user data directory")?;
        Ok(dirs.data_dir().to_path_buf())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn ext(ns: &str) -> &'static str {
        if ns == "scripts" { "js" } else { "json" }
    }

    fn ns_dir(&self, ns: &str) -> Result<PathBuf> {
        if !NAMESPACES.contains(&ns) {
            bail!("unknown namespace '{ns}'");
        }
        Ok(self.root.join(ns))
    }

    fn path(&self, ns: &str, key: &str) -> Result<PathBuf> {
        Ok(self.ns_dir(ns)?.join(format!("{}.{}", encode_key(key)?, Self::ext(ns))))
    }

    pub async fn list(&self, ns: &str) -> Result<Vec<String>> {
        let dir = self.ns_dir(ns)?;
        let ext = format!(".{}", Self::ext(ns));
        let mut keys = Vec::new();
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(keys),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(&ext)
                && let Some(key) = decode_key(stem)
            {
                keys.push(key);
            }
        }
        keys.sort();
        Ok(keys)
    }

    pub async fn get(&self, ns: &str, key: &str) -> Result<Option<Vec<u8>>> {
        match tokio::fs::read(self.path(ns, key)?).await {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Atomic write (temp file + rename) so a crash never leaves a half-written file.
    pub async fn put(&self, ns: &str, key: &str, value: &[u8]) -> Result<()> {
        if value.len() > MAX_VALUE_BYTES {
            bail!("value too large");
        }
        let path = self.path(ns, key)?;
        tokio::fs::create_dir_all(path.parent().unwrap()).await?;
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, value).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    pub async fn delete(&self, ns: &str, key: &str) -> Result<()> {
        match tokio::fs::remove_file(self.path(ns, key)?).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

/// Encodes an arbitrary key (e.g. `/ES:CME`, `BRK B`) as a safe file name:
/// `[A-Za-z0-9_-]` are kept, everything else becomes `~XX` (hex byte).
fn encode_key(key: &str) -> Result<String> {
    if key.is_empty() || key.len() > 200 {
        bail!("invalid key");
    }
    let mut out = String::with_capacity(key.len());
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
            out.push(b as char);
        } else {
            out.push_str(&format!("~{b:02X}"));
        }
    }
    Ok(out)
}

fn decode_key(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            let hex = name.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_roundtrip() {
        for k in ["AAPL", "/ES:CME", "BRK B", "EUR.USD", "../etc/passwd", "^SPX", "$BTC", "日本"] {
            let e = encode_key(k).unwrap();
            assert!(!e.contains('/') && !e.contains('.') && !e.contains(' '), "{e}");
            assert_eq!(decode_key(&e).as_deref(), Some(k));
        }
        assert!(encode_key("").is_err());
    }

    #[tokio::test]
    async fn put_get_list_delete() {
        let dir = std::env::temp_dir().join(format!("ib-charts-test-{}", std::process::id()));
        let s = Store::open(dir.clone()).unwrap();
        s.put("drawings", "/ES", b"[1]").await.unwrap();
        s.put("scripts", "My EMA", b"plot(close)").await.unwrap();
        assert_eq!(s.get("drawings", "/ES").await.unwrap().as_deref(), Some(&b"[1]"[..]));
        assert_eq!(s.list("drawings").await.unwrap(), vec!["/ES"]);
        assert_eq!(s.list("scripts").await.unwrap(), vec!["My EMA"]);
        assert!(dir.join("scripts").join("My~20EMA.js").exists());
        s.delete("drawings", "/ES").await.unwrap();
        assert_eq!(s.get("drawings", "/ES").await.unwrap(), None);
        assert!(s.put("nope", "x", b"").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
