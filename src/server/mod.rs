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
        .route("/ws", get(stream::ws_upgrade))
        .fallback(static_file)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
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
    fn loopback_hosts() {
        for h in ["localhost:8088", "127.0.0.1:8088", "[::1]:8088", "localhost"] {
            assert!(is_loopback_host(h), "{h}");
        }
        for h in ["evil.com:8088", "127.0.0.1.evil.com", "", "192.168.1.5:8088"] {
            assert!(!is_loopback_host(h), "{h}");
        }
    }
}
