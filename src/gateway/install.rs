//! Finding IB Gateway installations and installing IBC.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

/// An offline (versioned) IB Gateway installation — the kind IBC can drive.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInstall {
    /// The version folder, e.g. `~/Applications/IB Gateway 10.50` or `C:\Jts\ibgateway\1050`.
    pub dir: PathBuf,
    /// Version as IBC wants it on this OS: `10.50` on macOS, `1050` elsewhere.
    pub version: String,
}

impl GatewayInstall {
    /// IBC's `--tws-path`: the folder that contains the version folder.
    pub fn tws_path(&self) -> PathBuf {
        let parent = self.dir.parent().unwrap_or(Path::new("/"));
        if cfg!(target_os = "macos") {
            parent.to_path_buf()
        } else {
            // ~/Jts/ibgateway/1050 -> ~/Jts
            parent.parent().unwrap_or(parent).to_path_buf()
        }
    }

    pub fn from_dir(dir: &Path) -> Option<Self> {
        if !dir.join("jars").is_dir() {
            return None; // auto-updating installs have no jars folder and don't work with IBC
        }
        let name = dir.file_name()?.to_string_lossy().to_string();
        let version = if cfg!(target_os = "macos") {
            name.strip_prefix("IB Gateway ")?.to_string()
        } else {
            name.chars().all(|c| c.is_ascii_digit()).then_some(name)?
        };
        Some(Self {
            dir: dir.to_path_buf(),
            version,
        })
    }
}

/// Looks for Gateway installs in the default locations, newest first.
pub fn find_gateways() -> Vec<GatewayInstall> {
    let home = directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf()).unwrap_or_default();
    let roots: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![home.join("Applications"), PathBuf::from("/Applications")]
    } else if cfg!(target_os = "windows") {
        vec![PathBuf::from(r"C:\Jts\ibgateway")]
    } else {
        vec![home.join("Jts/ibgateway"), PathBuf::from("/opt/ibgateway")]
    };
    let mut found: Vec<GatewayInstall> = roots
        .iter()
        .filter_map(|r| std::fs::read_dir(r).ok())
        .flatten()
        .flatten()
        .filter_map(|e| GatewayInstall::from_dir(&e.path()))
        .collect();
    found.sort_by_key(|g| std::cmp::Reverse(version_key(&g.version)));
    found
}

fn version_key(v: &str) -> u32 {
    v.replace('.', "").parse().unwrap_or(0)
}

/// IBC lives in `<data dir>/ibc/<version>/`.
pub fn ibc_root(data_dir: &Path) -> PathBuf {
    data_dir.join("ibc")
}

/// The newest installed IBC version and its folder, if any.
pub fn installed_ibc(data_dir: &Path) -> Option<(String, PathBuf)> {
    let mut versions: Vec<(Vec<u32>, String, PathBuf)> = std::fs::read_dir(ibc_root(data_dir))
        .ok()?
        .flatten()
        .filter(|e| e.path().join("IBC.jar").is_file())
        .map(|e| {
            let v = e.file_name().to_string_lossy().to_string();
            (v.split('.').filter_map(|p| p.parse().ok()).collect(), v, e.path())
        })
        .collect();
    versions.sort();
    versions.pop().map(|(_, v, p)| (v, p))
}

/// Downloads the latest IBC release from GitHub (github.com/IbcAlpha/IBC) for this OS.
pub async fn install_latest_ibc(data_dir: &Path) -> Result<String> {
    let http = reqwest::Client::builder().user_agent("ib-charts").build()?;
    let release: serde_json::Value = http
        .get("https://api.github.com/repos/IbcAlpha/IBC/releases/latest")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("cannot read IBC release info")?;
    let version = release["tag_name"]
        .as_str()
        .ok_or_else(|| anyhow!("no IBC release tag"))?
        .to_string();
    if !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        bail!("unexpected IBC version '{version}'");
    }
    let prefix = if cfg!(target_os = "macos") {
        "IBCMacos-"
    } else if cfg!(target_os = "windows") {
        "IBCWin-"
    } else {
        "IBCLinux-"
    };
    let url = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.starts_with(prefix) && n.ends_with(".zip")))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or_else(|| anyhow!("no {prefix}*.zip in IBC release {version}"))?
        .to_string();
    if !url.starts_with("https://github.com/IbcAlpha/IBC/releases/download/") {
        bail!("unexpected IBC download location {url}");
    }

    tracing::info!("downloading IBC {version} from {url}");
    let bytes = http.get(&url).send().await?.error_for_status()?.bytes().await?;

    let dest = ibc_root(data_dir).join(&version);
    let tmp = ibc_root(data_dir).join(format!(".{version}.partial"));
    let bytes = bytes.to_vec();
    let (tmp2, dest2) = (tmp.clone(), dest.clone());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = std::fs::remove_dir_all(&tmp2);
        std::fs::create_dir_all(&tmp2)?;
        extract_zip(&bytes, &tmp2)?;
        if !tmp2.join("IBC.jar").is_file() {
            bail!("IBC.jar missing from download");
        }
        let _ = std::fs::remove_dir_all(&dest2);
        std::fs::rename(&tmp2, &dest2)?;
        Ok(())
    })
    .await??;
    Ok(version)
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        // enclosed_name() rejects absolute paths and `..` (zip-slip).
        let Some(rel) = f.enclosed_name() else { continue };
        let out = dest.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut w = std::fs::File::create(&out)?;
        std::io::copy(&mut f, &mut w)?;
        #[cfg(unix)]
        if out.extension().is_some_and(|e| e == "sh") {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_install_dirs() {
        let base = std::env::temp_dir().join(format!("ibc-detect-{}", std::process::id()));
        let name = if cfg!(target_os = "macos") { "IB Gateway 10.50" } else { "1050" };
        let dir = base.join(name);
        std::fs::create_dir_all(dir.join("jars")).unwrap();
        let g = GatewayInstall::from_dir(&dir).unwrap();
        assert_eq!(g.version, if cfg!(target_os = "macos") { "10.50" } else { "1050" });
        std::fs::create_dir_all(base.join("IB Gateway")).unwrap();
        assert!(GatewayInstall::from_dir(&base.join("IB Gateway")).is_none());
        let _ = std::fs::remove_dir_all(base);
    }
}
