//! Shared invitation access for HTTP and WebSocket messages.

use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use subtle::ConstantTimeEq;
use url::Url;

use crate::{app::AppState, error::AppError};

pub const INVITE_PROTOCOL: &str = "witchy-v1";

#[derive(Clone)]
pub struct InviteAccess {
    expected: Option<[u8; 32]>,
}

impl InviteAccess {
    pub fn new(configured_hash: Option<&str>) -> Self {
        Self {
            expected: configured_hash.and_then(decode_hash),
        }
    }

    pub fn assert_hash(&self, candidate: Option<&str>) -> Result<(), AppError> {
        let expected = self.expected.as_ref().ok_or_else(|| {
            AppError::new("INVITE_NOT_CONFIGURED", "邀请码尚未配置，请联系房主。")
                .with_status(StatusCode::SERVICE_UNAVAILABLE)
        })?;
        let valid = candidate
            .and_then(decode_hash)
            .is_some_and(|candidate| bool::from(expected.ct_eq(&candidate)));
        if valid {
            Ok(())
        } else {
            Err(AppError::new("INVITE_INVALID", "邀请码无效，请重新输入。")
                .with_status(StatusCode::UNAUTHORIZED))
        }
    }
}

fn decode_hash(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

pub fn invite_hash_from_protocols(header: Option<&str>) -> Option<&str> {
    let protocols: Vec<_> = header?.split(',').map(str::trim).collect();
    if protocols.len() != 2 || !protocols.contains(&INVITE_PROTOCOL) {
        return None;
    }
    let hash = protocols
        .iter()
        .find_map(|protocol| protocol.strip_prefix("invite."))?;
    decode_hash(hash).map(|_| hash)
}

pub fn allowed_socket_origin(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(host) = host else {
        return false;
    };
    let (Ok(source), Ok(target)) = (Url::parse(origin), Url::parse(&format!("http://{host}")))
    else {
        return false;
    };
    if !matches!(source.scheme(), "http" | "https")
        || !source.username().is_empty()
        || source.password().is_some()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return false;
    }
    let (Some(source), Some(target)) = (source.host_str(), target.host_str()) else {
        return false;
    };
    let loopback = |host: &str| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    source == target || (loopback(source) && loopback(target))
}

pub async fn authenticate_api(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let is_api = path == "/api" || path.starts_with("/api/");
    if is_api {
        let hash = request
            .headers()
            .get("x-invite-hash")
            .and_then(|value| value.to_str().ok());
        if let Err(error) = state.access.assert_hash(hash) {
            return error.into_response();
        }
    }
    let mut response = next.run(request).await;
    if is_api {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}
