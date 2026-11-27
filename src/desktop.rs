//! Native desktop shell (Tauri 2): a window that shows the chart UI served by the
//! embedded server, a tray / menu-bar icon, and single-instance handling.
//!
//! The UI keeps talking to the local HTTP/WebSocket server exactly as in browser
//! mode, so it needs no Tauri IPC — the webview is just a dedicated browser window.

use anyhow::Result;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MAIN: &str = "main";

/// Set once the desktop app is running (absent in --browser mode).
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Shows a native notification. Returns false outside the desktop app.
pub fn notify(title: &str, body: &str) -> bool {
    use tauri_plugin_notification::NotificationExt;
    let Some(app) = APP.get() else { return false };
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("notification failed: {e}");
            false
        }
    }
}

/// Hooks the rest of the app can attach to the desktop lifecycle.
pub struct Hooks {
    /// Runs once when the app is about to exit (e.g. to stop IB Gateway).
    pub on_exit: Box<dyn FnOnce() + Send>,
}

pub fn run(url: String, hooks: Hooks) -> Result<()> {
    let app = tauri::Builder::default()
        // A second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let _ = APP.set(app.handle().clone());
            build_main_window(app.handle(), &url)?;
            build_tray(app.handle(), &url)?;
            Ok(())
        })
        .build(tauri::generate_context!())?;

    let mut on_exit = Some(hooks.on_exit);
    app.run(move |_app, event| match event {
        // macOS: clicking the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(_app),
        RunEvent::Exit => {
            if let Some(f) = on_exit.take() {
                f();
            }
        }
        _ => {}
    });
    Ok(())
}

fn build_main_window(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let url: Url = url.parse().map_err(|e| anyhow::anyhow!("bad UI url: {e}"))?;
    let origin = url.origin();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("IB Charts")
        .inner_size(1440.0, 900.0)
        .min_inner_size(800.0, 500.0)
        .initialization_script("window.__IB_CHARTS_DESKTOP__ = true;")
        // Anything that isn't our own UI (e.g. the TradingView credit link) opens in the system browser.
        .on_navigation(move |u| {
            if u.origin() == origin {
                return true;
            }
            open_external(u);
            false
        })
        .on_new_window(|u, _| {
            open_external(&u);
            NewWindowResponse::Deny
        })
        .build()?;

    // Closing the window keeps the app (and later, alerts) running in the tray.
    let w = window.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = w.hide();
        }
    });
    Ok(())
}

fn build_tray(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show IB Charts", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit IB Charts", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &browser, &PredefinedMenuItem::separator(app)?, &quit])?;

    let url = url.to_string();
    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip("IB Charts")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "show" => show_main(app),
            "browser" => {
                let _ = opener::open_browser(&url);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_external(u: &Url) {
    if matches!(u.scheme(), "http" | "https")
        && let Err(e) = opener::open_browser(u.as_str())
    {
        tracing::warn!("could not open {u}: {e}");
    }
}
