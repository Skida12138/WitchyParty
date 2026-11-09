//! Compose domain routes and the existing frontend's static assets.

use std::path::Path;

use axum::{Json, Router, extract::State, middleware, routing::get};
use serde_json::{Value, json};
use tower_http::services::ServeDir;

use crate::{access, app::AppState, rooms};

pub fn build_router(state: AppState, root: &Path) -> Router {
    Router::new()
        .route("/api/access", get(|| async { Json(json!({"ok":true})) }))
        .route("/api/health", get(health))
        .route("/ws", get(rooms::api::upgrade))
        .fallback_service(ServeDir::new(root.join("dist")))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access::authenticate_api,
        ))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"ok":true, "mode":"deepseek", "aiReady":state.ai_ready, "version":"0.1.0"}))
}
