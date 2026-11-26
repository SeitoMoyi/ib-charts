//! REST access to the on-disk store: `/api/store/{namespace}[/{key}]`.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::AppState;
use crate::store::MAX_VALUE_BYTES;

fn err(e: anyhow::Error) -> Response {
    (StatusCode::BAD_REQUEST, format!("{e:#}")).into_response()
}

pub async fn list(State(st): State<AppState>, Path(ns): Path<String>) -> Response {
    match st.store.list(&ns).await {
        Ok(keys) => Json(keys).into_response(),
        Err(e) => err(e),
    }
}

pub async fn get(State(st): State<AppState>, Path((ns, key)): Path<(String, String)>) -> Response {
    match st.store.get(&ns, &key).await {
        Ok(Some(v)) => {
            let ct = if ns == "scripts" {
                "text/plain; charset=utf-8"
            } else {
                "application/json"
            };
            ([(header::CONTENT_TYPE, ct)], v).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub async fn put(State(st): State<AppState>, Path((ns, key)): Path<(String, String)>, body: Bytes) -> Response {
    if body.len() > MAX_VALUE_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    if ns != "scripts" && serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, "body must be JSON").into_response();
    }
    match st.store.put(&ns, &key, &body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(e),
    }
}

pub async fn delete(State(st): State<AppState>, Path((ns, key)): Path<(String, String)>) -> Response {
    match st.store.delete(&ns, &key).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(e),
    }
}
