//! HTTP + WebSocket server for the chart UI.

mod gateway_api;
mod search;
mod store_api;
mod stream;

use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::gateway::Gateway;
use crate::ib::Ib;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub ib: Arc<Ib>,
    pub store: Store,
    pub gateway: Arc<Gateway>,
    pub quotes: Arc<crate::quotes::QuoteHub>,
    /// App-wide events pushed to every open window (e.g. a script file changed).
    pub events: tokio::sync::broadcast::Sender<serde_json::Value>,
    /// `--demo`: synthetic data instead of IB.
    pub demo: bool,
    /// Only accept requests addressed to localhost (blocks DNS-rebinding attacks).
    pub loopback_only: bool,
}

#[derive(rust_embed::Embed)]
#[folder = "static/"]
struct Assets;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/search", get(search::search))
        .route("/api/store/{ns}", get(store_api::list))
        .route(
            "/api/store/{ns}/{key}",
            get(store_api::get).put(store_api::put).delete(store_api::delete),
        )
        .route("/api/gateway", get(gateway_api::get))
        .route("/api/gateway/settings", axum::routing::put(gateway_api::put_settings))
        .route("/api/gateway/log", get(gateway_api::log))
        .route("/api/gateway/{action}", axum::routing::post(gateway_api::action))
        .route("/api/notify", axum::routing::post(notify))
        .route("/api/screenshot", axum::routing::post(screenshot))
        .route("/ws", get(stream::ws_upgrade))
        .fallback(static_file)
        .layer(axum::extract::DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

#[derive(serde::Deserialize)]
struct Notify {
    title: String,
    body: String,
}

/// Native desktop notification (alerts). 501 in browser mode: the page then uses web notifications.
async fn notify(axum::Json(n): axum::Json<Notify>) -> Response {
    let title: String = n.title.chars().take(120).collect();
    let body: String = n.body.chars().take(500).collect();
    if crate::desktop::notify(&title, &body) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_IMPLEMENTED.into_response()
    }
}

#[derive(serde::Deserialize)]
struct ShotName {
    name: String,
}

/// Saves a chart image (PNG) to the user's Downloads folder.
async fn screenshot(axum::extract::Query(q): axum::extract::Query<ShotName>, body: axum::body::Bytes) -> Response {
    if !body.starts_with(b"\x89PNG") {
        return (StatusCode::BAD_REQUEST, "not a PNG").into_response();
    }
    let safe: String = q
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '_' })
        .take(120)
        .collect();
    let safe = if safe.ends_with(".png") { safe } else { format!("{safe}.png") };
    let dir = directories::UserDirs::new()
        .and_then(|d| {
            d.download_dir()
                .map(|p| p.to_path_buf())
                .or_else(|| Some(d.home_dir().to_path_buf()))
        })
        .unwrap_or_else(std::env::temp_dir);
    let path = dir.join(safe.trim_start_matches('.'));
    match tokio::fs::write(&path, &body).await {
        Ok(()) => axum::Json(serde_json::json!({ "path": path.display().to_string() })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn static_file(uri: Uri) -> Response {
    let decoded = percent_decode(uri.path());
    let path = decoded.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if path.split('/').any(|seg| seg == "..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match Assets::get(path) {
        Some(file) => {
            let mime = if path.ends_with(".mjs") || path.ends_with(".js") {
                "text/javascript; charset=utf-8".to_string()
            } else {
                file.metadata.mimetype().to_string()
            };
            (
                [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache".to_string())],
                file.data,
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Decodes `%XX` escapes in a URL path (e.g. `Bollinger%20Bands.js`).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Rejects requests that don't come from our own page:
/// - Host must be localhost (unless the user deliberately listens on a public address),
///   which defeats DNS rebinding;
/// - state-changing requests and WebSockets must be same-origin, which stops other
///   websites open in your browser from talking to this server.
async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if st.loopback_only && !is_loopback_host(host) {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    let sensitive = !matches!(*req.method(), Method::GET | Method::HEAD) || req.uri().path() == "/ws";
    if sensitive && !same_origin(headers) {
        return (StatusCode::FORBIDDEN, "cross-origin request rejected").into_response();
    }
    next.run(req).await
}

fn is_loopback_host(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.rsplit_once(':').map_or(host, |(h, _)| h)
    };
    matches!(name, "localhost" | "127.0.0.1" | "::1")
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true; // not a browser cross-site request
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) == Some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths() {
        assert_eq!(
            percent_decode("/scripts/builtin/Bollinger%20Bands.js"),
            "/scripts/builtin/Bollinger Bands.js"
        );
        assert_eq!(percent_decode("/a%2"), "/a%2");
        assert_eq!(percent_decode("/%E6%97%A5"), "/日");
    }

    #[test]
    fn loopback_hosts() {
        for h in ["localhost:8088", "127.0.0.1:8088", "[::1]:8088", "localhost"] {
            assert!(is_loopback_host(h), "{h}");
        }
        for h in ["evil.com:8088", "127.0.0.1.evil.com", "", "192.168.1.5:8088"] {
            assert!(!is_loopback_host(h), "{h}");
        }
    }
}
