//! Starting, watching and stopping IB Gateway.
//!
//! Three modes:
//! - `external`: don't touch Gateway, just wait for its API port (you start it yourself).
//! - `manual`:   open the Gateway app for you; you type the login.
//! - `auto`:     log in automatically with [IBC](https://github.com/IbcAlpha/IBC). The password
//!   comes from the OS credential store and is only written to a private (0600) IBC config
//!   file until the login completes, then scrubbed from it.

pub mod install;
mod secrets;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify, watch};

use crate::ib::Ib;
use crate::store::Store;
use install::GatewayInstall;

const LOG_LINES: usize = 3000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    External,
    Manual,
    Auto,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TradingMode {
    #[default]
    Live,
    Paper,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub mode: Mode,
    pub trading_mode: TradingMode,
    pub username: String,
    /// Gateway version folder; `None` = newest one found.
    pub install_dir: Option<PathBuf>,
    /// API port; `None` = 4001 (live) / 4002 (paper).
    pub api_port: Option<u16>,
    /// Stop Gateway when IB Charts quits (only a Gateway that IB Charts started).
    pub quit_on_exit: bool,
    /// IBC command-server port, used to stop Gateway cleanly.
    pub command_port: u16,
    /// False until the setup dialog has been saved once.
    pub configured: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: Mode::External,
            trading_mode: TradingMode::Live,
            username: String::new(),
            install_dir: None,
            api_port: None,
            quit_on_exit: true,
            command_port: 7462,
            configured: false,
        }
    }
}

impl Settings {
    pub fn port(&self) -> u16 {
        self.api_port.unwrap_or(match self.trading_mode {
            TradingMode::Live => 4001,
            TradingMode::Paper => 4002,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Offline,
    Starting,
    LoggingIn,
    TwoFactor,
    Connected,
    Stopping,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub message: String,
    pub mode: Mode,
    /// IB Charts started this Gateway (so it may stop it).
    pub managed: bool,
    pub port: u16,
}

struct Running {
    child: Child,
    ini: Option<PathBuf>,
    started: Instant,
}

pub struct Gateway {
    data_dir: PathBuf,
    store: Store,
    ib: Arc<Ib>,
    host: String,
    settings: Mutex<Settings>,
    status: watch::Sender<Status>,
    log: std::sync::Mutex<VecDeque<String>>,
    running: Mutex<Option<Running>>,
    /// The user wants Gateway up (auto/manual modes).
    want_running: AtomicBool,
    /// Manual mode: we already opened the app for this run.
    manual_opened: AtomicBool,
    /// Last error reported by the IBC launcher, if any.
    last_error: std::sync::Mutex<Option<String>>,
    wake: Notify,
}

impl Gateway {
    pub async fn new(store: Store, ib: Arc<Ib>, host: String, cli_port: u16, demo: bool) -> Arc<Self> {
        let settings: Settings = match store.get("settings", "gateway").await {
            Ok(Some(b)) => serde_json::from_slice(&b).unwrap_or_default(),
            _ => Settings::default(),
        };
        let port = if settings.configured { settings.port() } else { cli_port };
        if settings.configured {
            ib.set_address(format!("{host}:{port}")).await;
        }
        let want = !demo && settings.configured && settings.mode != Mode::External;
        let status = Status {
            phase: Phase::Offline,
            message: "Starting…".into(),
            mode: settings.mode,
            managed: false,
            port,
        };
        let gw = Arc::new(Self {
            data_dir: store.root().to_path_buf(),
            store,
            ib,
            host,
            settings: Mutex::new(settings),
            status: watch::channel(status).0,
            log: std::sync::Mutex::new(VecDeque::new()),
            running: Mutex::new(None),
            want_running: AtomicBool::new(want),
            manual_opened: AtomicBool::new(false),
            last_error: std::sync::Mutex::new(None),
            wake: Notify::new(),
        });
        if demo {
            gw.set(Phase::Connected, "Demo mode — synthetic data, not connected to IB".into(), false);
        } else {
            tokio::spawn(gw.clone().supervise());
        }
        gw
    }

    // ---------- public API ----------

    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }

    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }

    pub async fn settings(&self) -> Settings {
        self.settings.lock().await.clone()
    }

    pub fn has_password(username: &str) -> bool {
        secrets::has_password(username)
    }

    pub fn ibc_version(&self) -> Option<String> {
        install::installed_ibc(&self.data_dir).map(|(v, _)| v)
    }

    pub fn log_lines(&self) -> Vec<String> {
        self.log.lock().unwrap().iter().cloned().collect()
    }

    /// Saves new settings (and optionally a new password) and applies them.
    pub async fn update(&self, mut new: Settings, password: Option<String>) -> Result<()> {
        new.username = new.username.trim().to_string();
        new.configured = true;
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            if new.username.is_empty() {
                bail!("enter the username before the password");
            }
            let user = new.username.clone();
            tokio::task::spawn_blocking(move || secrets::set_password(&user, &pw)).await??;
        }
        let old = self.settings.lock().await.clone();
        if old.username != new.username && !old.username.is_empty() {
            let user = old.username.clone();
            let _ = tokio::task::spawn_blocking(move || secrets::delete_password(&user)).await;
        }
        self.store.put("settings", "gateway", &serde_json::to_vec_pretty(&new)?).await?;
        self.ib.set_address(format!("{}:{}", self.host, new.port())).await;

        let restart = old.mode != new.mode || old.trading_mode != new.trading_mode || old.install_dir != new.install_dir;
        *self.settings.lock().await = new.clone();
        self.status.send_modify(|s| {
            s.mode = new.mode;
            s.port = new.port();
        });
        if restart {
            self.stop_running().await;
        }
        self.want_running.store(new.mode != Mode::External, Ordering::SeqCst);
        self.manual_opened.store(false, Ordering::SeqCst);
        self.wake.notify_one();
        Ok(())
    }

    pub async fn start(&self) {
        self.manual_opened.store(false, Ordering::SeqCst);
        self.want_running.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub async fn stop(&self) {
        self.want_running.store(false, Ordering::SeqCst);
        self.stop_running().await;
        self.wake.notify_one();
    }

    pub async fn restart(&self) {
        self.stop_running().await;
        self.start().await;
    }

    pub async fn install_ibc(&self) -> Result<String> {
        self.log_line("Downloading IBC from github.com/IbcAlpha/IBC…");
        let v = install::install_latest_ibc(&self.data_dir).await?;
        self.log_line(&format!("Installed IBC {v}"));
        Ok(v)
    }

    /// Called when IB Charts quits.
    pub async fn shutdown(&self) {
        self.want_running.store(false, Ordering::SeqCst);
        if self.settings.lock().await.quit_on_exit {
            self.stop_running().await;
        } else if let Some(r) = self.running.lock().await.as_mut() {
            // Leave Gateway running, but don't leave credentials behind.
            if let Some(ini) = &r.ini {
                let _ = scrub_credentials(ini).await;
            }
        }
    }

    // ---------- supervisor ----------

    async fn supervise(self: Arc<Self>) {
        let mut was_up = false;
        let mut backoff = Duration::from_secs(5);
        loop {
            let s = self.settings.lock().await.clone();
            let port = s.port();
            let probe_host = self.host.trim_start_matches('[').trim_end_matches(']');
            let up = TcpStream::connect((probe_host, port)).await.is_ok();

            // Did our IBC/Gateway process exit?
            let mut exited = None;
            if let Some(r) = self.running.lock().await.as_mut()
                && let Ok(Some(code)) = r.child.try_wait()
            {
                exited = Some((code, r.started.elapsed()));
            }
            if let Some((code, ran_for)) = exited {
                if let Some(r) = self.running.lock().await.take()
                    && let Some(ini) = r.ini
                {
                    let _ = tokio::fs::remove_file(ini).await;
                }
                self.log_line(&format!("IBC exited ({code})"));
                let error = self.last_error.lock().unwrap().take();
                if let Some(err) = error.filter(|_| ran_for < Duration::from_secs(60)) {
                    // A setup problem (paths, Java, config): retrying won't help.
                    self.want_running.store(false, Ordering::SeqCst);
                    self.set(Phase::Error, format!("IBC: {err}"), false);
                } else if self.want_running.load(Ordering::SeqCst) {
                    backoff = if ran_for > Duration::from_secs(600) {
                        Duration::from_secs(5)
                    } else {
                        (backoff * 2).min(Duration::from_secs(300))
                    };
                    self.set(
                        Phase::Error,
                        format!("Gateway exited ({code}); retrying in {}s", backoff.as_secs()),
                        false,
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = self.wake.notified() => {}
                    }
                    continue;
                }
            }

            let managed = self.running.lock().await.is_some();
            let want = self.want_running.load(Ordering::SeqCst);

            if up {
                if !was_up {
                    self.log_line(&format!("IB API is up on port {port}"));
                    self.ib.reset().await;
                }
                if let Some(ini) = self.running.lock().await.as_ref().and_then(|r| r.ini.as_ref()) {
                    // Logged in: credentials are no longer needed on disk.
                    let _ = scrub_credentials(ini).await;
                }
                let msg = if managed || s.mode == Mode::Manual {
                    "Connected".to_string()
                } else {
                    format!("Connected to Gateway/TWS on port {port}")
                };
                self.set(Phase::Connected, msg, managed);
            } else {
                if was_up {
                    self.log_line("IB API went down");
                }
                match s.mode {
                    Mode::External => self.set(Phase::Offline, format!("Waiting for IB Gateway / TWS on port {port}"), false),
                    Mode::Manual if want => {
                        if !self.manual_opened.swap(true, Ordering::SeqCst)
                            && let Err(e) = self.open_gateway_app(&s)
                        {
                            self.set(Phase::Error, format!("{e:#}"), false);
                        } else if self.status().phase != Phase::Error {
                            self.set(Phase::LoggingIn, "Log in to IB Gateway…".into(), false);
                        }
                    }
                    Mode::Auto if want && !managed => {
                        self.set(Phase::Starting, "Starting IB Gateway…".into(), false);
                        if let Err(e) = self.launch_ibc(&s).await {
                            self.log_line(&format!("ERROR: {e:#}"));
                            self.set(Phase::Error, format!("{e:#}"), false);
                            self.want_running.store(false, Ordering::SeqCst);
                        }
                    }
                    Mode::Auto if want => {
                        if self.status().phase == Phase::Connected {
                            self.set(Phase::LoggingIn, "Reconnecting…".into(), true);
                        }
                    }
                    _ => {
                        if self.status().phase != Phase::Error {
                            self.set(Phase::Offline, "Gateway is stopped".into(), false);
                        }
                    }
                }
            }
            was_up = up;

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = self.wake.notified() => {}
            }
        }
    }

    fn set(&self, phase: Phase, message: String, managed: bool) {
        self.status.send_if_modified(|s| {
            let changed = s.phase != phase || s.message != message || s.managed != managed;
            s.phase = phase;
            s.message = message;
            s.managed = managed;
            changed
        });
    }

    fn log_line(&self, line: &str) {
        let line = format!("{} {line}", chrono::Local::now().format("%H:%M:%S"));
        let mut log = self.log.lock().unwrap();
        if log.len() >= LOG_LINES {
            log.pop_front();
        }
        log.push_back(line);
    }

    /// Reacts to IBC / Gateway console output.
    fn on_output(&self, line: &str) {
        self.log_line(line);
        let l = line.to_ascii_lowercase();
        if l.contains("second factor authentication") && !l.contains("timed out") {
            self.set(Phase::TwoFactor, "Approve the login in IBKR Mobile on your phone…".into(), true);
        } else if l.contains("login has completed") {
            self.set(Phase::LoggingIn, "Logged in — starting the API…".into(), true);
        } else if l.contains("login dialog") && l.contains("opened") || l.contains("entitled: login") {
            self.set(Phase::LoggingIn, "Logging in…".into(), true);
        } else if let Some(msg) = line.trim().strip_prefix("Error:") {
            *self.last_error.lock().unwrap() = Some(msg.trim().to_string());
            self.set(Phase::Error, format!("IBC: {}", msg.trim()), true);
        }
    }

    // ---------- launching / stopping ----------

    fn gateway_install(&self, s: &Settings) -> Result<GatewayInstall> {
        match &s.install_dir {
            Some(d) => GatewayInstall::from_dir(d).ok_or_else(|| anyhow!("{} is not an offline IB Gateway install", d.display())),
            None => install::find_gateways()
                .into_iter()
                .next()
                .ok_or_else(|| anyhow!("IB Gateway not found — install the *offline* IB Gateway from interactivebrokers.com")),
        }
    }

    async fn launch_ibc(self: &Arc<Self>, s: &Settings) -> Result<()> {
        if s.username.is_empty() {
            bail!("set your IB username in Gateway settings");
        }
        let gw = self.gateway_install(s)?;
        let (ibc_version, ibc_dir) = match install::installed_ibc(&self.data_dir) {
            Some(v) => v,
            None => {
                self.set(Phase::Starting, "Installing IBC…".into(), false);
                self.install_ibc().await?;
                install::installed_ibc(&self.data_dir).ok_or_else(|| anyhow!("IBC install failed"))?
            }
        };
        let user = s.username.clone();
        let password = tokio::task::spawn_blocking(move || secrets::get_password(&user))
            .await??
            .ok_or_else(|| anyhow!("no password saved for {} — enter it in Gateway settings", s.username))?;

        let ini = install::ibc_root(&self.data_dir).join("config.ini");
        write_private(&ini, &ibc_config(s, &password)).await?;

        let mode = match s.trading_mode {
            TradingMode::Live => "live",
            TradingMode::Paper => "paper",
        };
        self.log_line(&format!(
            "Starting IB Gateway {} ({mode}) with IBC {ibc_version} as {}",
            gw.version, s.username
        ));

        *self.last_error.lock().unwrap() = None;
        let mut cmd = ibc_command(&gw, &ibc_dir, &ini, mode);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        let mut child = cmd.spawn().context("cannot start IBC")?;

        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child.stderr.take().map(|p| Box::new(p) as _),
        ]
        .into_iter()
        .flatten()
        {
            let me = Arc::downgrade(self);
            tokio::spawn(async move {
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(gw) = me.upgrade() {
                        gw.on_output(&line);
                    }
                }
            });
        }

        *self.running.lock().await = Some(Running {
            child,
            ini: Some(ini),
            started: Instant::now(),
        });
        self.set(Phase::LoggingIn, "Logging in…".into(), true);
        Ok(())
    }

    fn open_gateway_app(&self, s: &Settings) -> Result<()> {
        let gw = self.gateway_install(s)?;
        self.log_line(&format!("Opening IB Gateway {}", gw.version));
        #[cfg(target_os = "macos")]
        {
            // IBC renames the app to "...-1.app" to stop manual starts; accept either.
            let app = [format!("IB Gateway {}.app", gw.version), format!("IB Gateway {}-1.app", gw.version)]
                .into_iter()
                .map(|n| gw.dir.join(n))
                .find(|p| p.exists())
                .ok_or_else(|| anyhow!("IB Gateway app not found in {}", gw.dir.display()))?;
            std::process::Command::new("open").arg(app).spawn()?;
        }
        #[cfg(target_os = "windows")]
        std::process::Command::new(gw.dir.join("ibgateway.exe")).spawn()?;
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let exe = ["ibgateway", "ibgateway1"]
                .into_iter()
                .map(|n| gw.dir.join(n))
                .find(|p| p.exists())
                .ok_or_else(|| anyhow!("ibgateway not found in {}", gw.dir.display()))?;
            std::process::Command::new(exe).spawn()?;
        }
        Ok(())
    }

    /// Stops the Gateway that we started (no-op otherwise).
    async fn stop_running(&self) {
        let Some(mut r) = self.running.lock().await.take() else { return };
        self.set(Phase::Stopping, "Stopping IB Gateway…".into(), true);
        self.log_line("Stopping IB Gateway");
        let port = self.settings.lock().await.command_port;

        // 1. Ask IBC to shut Gateway down cleanly.
        if let Ok(Ok(mut sock)) = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(("127.0.0.1", port))).await {
            let _ = sock.write_all(b"STOP\n").await;
            let _ = sock.flush().await;
        }
        let exited = tokio::time::timeout(Duration::from_secs(20), r.child.wait()).await.is_ok();

        // 2. Otherwise terminate the whole process tree (the launcher script and Java).
        if !exited {
            self.log_line("Gateway didn't stop in time; terminating it");
            kill_tree(&mut r.child).await;
        }
        if let Some(ini) = r.ini {
            let _ = tokio::fs::remove_file(ini).await;
        }
        self.set(Phase::Offline, "Gateway is stopped".into(), false);
    }
}

/// The IBC config: login, read-only API, and unattended-operation settings.
fn ibc_config(s: &Settings, password: &str) -> String {
    let mode = match s.trading_mode {
        TradingMode::Live => "live",
        TradingMode::Paper => "paper",
    };
    format!(
        "# Written by IB Charts. Credentials are removed automatically after login.\n\
         IbLoginId={user}\n\
         IbPassword={password}\n\
         TradingMode={mode}\n\
         FIX=no\n\
         ReadOnlyApi=yes\n\
         ReadOnlyLogin=no\n\
         OverrideTwsApiPort={port}\n\
         MinimizeMainWindow=yes\n\
         ExistingSessionDetectedAction=primary\n\
         ReloginAfterSecondFactorAuthenticationTimeout=yes\n\
         SecondFactorAuthenticationTimeout=180\n\
         ExitAfterSecondFactorAuthenticationTimeout=no\n\
         LoginDialogDisplayTimeout=90\n\
         AllowBlindTrading=no\n\
         CommandServerPort={cmd}\n\
         BindAddress=127.0.0.1\n\
         ControlFrom=\n\
         SuppressInfoMessages=yes\n",
        user = s.username,
        port = s.port(),
        cmd = s.command_port,
    )
}

/// Rewrites the IBC config without the login and password lines.
async fn scrub_credentials(ini: &Path) -> Result<()> {
    let text = tokio::fs::read_to_string(ini).await?;
    if !text.contains("IbPassword=") {
        return Ok(());
    }
    let cleaned: String = text
        .lines()
        .filter(|l| !l.starts_with("IbLoginId=") && !l.starts_with("IbPassword="))
        .map(|l| format!("{l}\n"))
        .collect();
    write_private(ini, &cleaned).await
}

/// Writes a file readable only by the current user.
async fn write_private(path: &Path, contents: &str) -> Result<()> {
    if let Some(p) = path.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    let mut opts = tokio::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts.open(path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    f.write_all(contents.as_bytes()).await?;
    f.flush().await?;
    Ok(())
}

fn ibc_command(gw: &GatewayInstall, ibc_dir: &Path, ini: &Path, mode: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(ibc_dir.join("scripts").join("StartIBC.bat"))
            .arg(&gw.version)
            .arg("/Gateway")
            .arg(format!("/TwsPath:{}", gw.tws_path().display()))
            .arg(format!("/IbcPath:{}", ibc_dir.display()))
            .arg(format!("/Config:{}", ini.display()))
            .arg(format!("/Mode:{mode}"))
            .arg("/On2FATimeout:restart");
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(unix)]
    {
        let mut cmd = Command::new("bash");
        cmd.arg(ibc_dir.join("scripts").join("ibcstart.sh"))
            .arg(&gw.version)
            .arg("--gateway")
            .arg(format!("--tws-path={}", gw.tws_path().display()))
            .arg(format!("--ibc-path={}", ibc_dir.display()))
            .arg(format!("--ibc-ini={}", ini.display()))
            .arg(format!("--mode={mode}"))
            .arg("--on2fatimeout=restart");
        // Own process group, so the script and Java can be stopped together.
        cmd.process_group(0);
        cmd
    }
}

async fn kill_tree(child: &mut Child) {
    let Some(pid) = child.id() else { return };
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status().await;
        if tokio::time::timeout(Duration::from_secs(8), child.wait()).await.is_err() {
            let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status().await;
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status().await;
    }
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_has_safe_defaults() {
        let s = Settings {
            username: "apiuser".into(),
            ..Default::default()
        };
        let ini = ibc_config(&s, "secret");
        for line in [
            "ReadOnlyApi=yes",
            "AllowBlindTrading=no",
            "TradingMode=live",
            "OverrideTwsApiPort=4001",
            "BindAddress=127.0.0.1",
        ] {
            assert!(ini.lines().any(|l| l == line), "{line}");
        }
    }

    #[tokio::test]
    async fn scrub_removes_credentials() {
        let p = std::env::temp_dir().join(format!("ibc-scrub-{}.ini", std::process::id()));
        let s = Settings {
            username: "apiuser".into(),
            ..Default::default()
        };
        write_private(&p, &ibc_config(&s, "secret")).await.unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        scrub_credentials(&p).await.unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("secret") && !text.contains("apiuser") && text.contains("ReadOnlyApi=yes"));
        let _ = std::fs::remove_file(p);
    }
}
