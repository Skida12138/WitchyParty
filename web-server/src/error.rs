use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

/// Shared errors retain the existing HTTP and WebSocket wire shapes.
#[derive(Debug, Clone)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub status: StatusCode,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: StatusCode::BAD_REQUEST,
        }
    }

    pub fn action(message: impl Into<String>) -> Self {
        Self::new("ACTION_FAILED", message)
    }

    pub fn with_status(mut self, status: StatusCode) -> Self {
        self.status = status;
        self
    }

    pub fn socket_message(&self, request_id: Value) -> Value {
        json!({"type":"error", "requestId":request_id, "code":self.code, "message":self.message})
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"ok":false, "code":self.code, "message":self.message})),
        )
            .into_response()
    }
}

impl From<crate::gameplay::GameError> for AppError {
    fn from(error: crate::gameplay::GameError) -> Self {
        Self::new(error.code, error.message)
    }
}
