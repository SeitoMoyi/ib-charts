//! Gateway control API used by the Gateway settings dialog.
//!
//! The password can be written here but is never returned.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::AppState;
use crate::gateway::{Gateway, Settings, install};

pub async fn get(State(st): State<AppState>) -> Response {
    let gw = &st.gateway;
    let settings = gw.settings().await;
    let user = settings.username.clone();
    let has_password = tokio::task::spawn_blocking(move || Gateway::has_password(&user))
        .await
        .unwrap_or(false);
    let installs = tokio::task::spawn_blocking(install::find_gateways).await.unwrap_or_default();
    Json(json!({
        "settings": settings,
        "hasPassword": has_password,
        "status": gw.status(),
        "installs": installs,
        "ibcVersion": gw.ibc_version(),
        "platform": std::env::consts::OS,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct Update {
    settings: Settings,
    #[serde(default)]
    password: Option<String>,
}

pub async fn put_settings(State(st): State<AppState>, Json(u): Json<Update>) -> Response {
    match st.gateway.update(u.settings, u.password).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, format!("{e:#}")).into_response(),
    }
}

pub async fn action(State(st): State<AppState>, Path(action): Path<String>) -> Response {
    let gw = &st.gateway;
    match action.as_str() {
        "start" => gw.start().await,
        "stop" => gw.stop().await,
        "restart" => gw.restart().await,
        "install-ibc" => {
            return match gw.install_ibc().await {
                Ok(v) => Json(json!({ "ibcVersion": v })).into_response(),
                Err(e) => (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
            };
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn log(State(st): State<AppState>) -> Response {
    Json(st.gateway.log_lines()).into_response()
}
