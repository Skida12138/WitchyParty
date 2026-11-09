//! Socket transport: authenticate, limit requests, and delegate room operations.

use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{sync::mpsc, time::Instant};

use crate::{
    access::{INVITE_PROTOCOL, allowed_socket_origin, invite_hash_from_protocols},
    app::AppState,
    error::AppError,
    rooms::types::Outbound,
};

pub async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let protocols = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    if let Err(error) = state
        .access
        .assert_hash(invite_hash_from_protocols(protocols))
    {
        return error.into_response();
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if (headers.contains_key(header::ORIGIN) && origin.is_none())
        || !allowed_socket_origin(origin, host)
    {
        return AppError::new("ORIGIN_INVALID", "来源不匹配")
            .with_status(StatusCode::FORBIDDEN)
            .into_response();
    }
    let mut response = ws
        .protocols([INVITE_PROTOCOL])
        .max_message_size(8192)
        .max_frame_size(8192)
        .on_upgrade(move |socket| connected(state, socket));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn interval_setting(name: &str, fallback: u64) -> Duration {
    let millis = std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 20.0)
        .map(|value| value as u64)
        .unwrap_or(fallback);
    Duration::from_millis(millis)
}

async fn connected(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (sender, mut outgoing) = mpsc::unbounded_channel();
    let connection_id = state.rooms.register(sender.clone()).await;
    let busy = Arc::new(AtomicBool::new(false));
    let mut recent = VecDeque::new();
    let heartbeat_interval = interval_setting("HEARTBEAT_INTERVAL_MS", 10_000);
    let heartbeat_timeout = interval_setting("HEARTBEAT_TIMEOUT_MS", 10_000);
    let mut heartbeat = tokio::time::interval(
        heartbeat_interval
            .min(heartbeat_timeout)
            .min(Duration::from_secs(1)),
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut next_ping = Instant::now() + heartbeat_interval;
    let mut awaiting_pong: Option<Instant> = None;

    loop {
        tokio::select! {
            outgoing = outgoing.recv() => {
                match outgoing {
                    Some(Outbound::Json(value)) => {
                        if sink.send(Message::Text(value.to_string().into())).await.is_err() { break; }
                    },
                    Some(Outbound::Close(code, reason)) => {
                        let _ = sink.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                        break;
                    },
                    None => break,
                }
            }
            incoming = stream.next() => {
                let bytes = match incoming {
                    Some(Ok(Message::Text(text))) => text.as_bytes().to_vec(),
                    Some(Ok(Message::Binary(bytes))) => bytes.to_vec(),
                    Some(Ok(Message::Pong(_))) => {
                        awaiting_pong = None;
                        next_ping = Instant::now() + heartbeat_interval;
                        continue;
                    },
                    Some(Ok(Message::Ping(bytes))) => {
                        if sink.send(Message::Pong(bytes)).await.is_err() { break; }
                        continue;
                    },
                    Some(Ok(Message::Close(frame))) => {
                        let _ = sink.send(Message::Close(frame)).await;
                        break;
                    },
                    Some(Err(_)) | None => break,
                };
                let mut message = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
                let request_id = message.get("requestId").cloned().unwrap_or(Value::Null);
                if let Err(error) = state.access.assert_hash(message.get("inviteHash").and_then(Value::as_str)) {
                    // Close before accepting another buffered command with a valid invitation.
                    let _ = sink.send(Message::Text(error.socket_message(request_id).to_string().into())).await;
                    let _ = sink.send(Message::Close(Some(CloseFrame { code: 4004, reason: "邀请码无效".into() }))).await;
                    break;
                }
                let now = Instant::now();
                while recent.front().is_some_and(|time| now.duration_since(*time) >= Duration::from_secs(10)) {
                    recent.pop_front();
                }
                let error = if !message.is_object() {
                    Some(AppError::action("消息格式无效"))
                } else if recent.len() >= 60 {
                    Some(AppError::action("操作太快，请稍后重试"))
                } else {
                    recent.push_back(now);
                    match message.get("payload") {
                        None | Some(Value::Null) | Some(Value::Bool(false)) => { message["payload"] = json!({}); None },
                        Some(value) if value == &json!(0) || value == &json!("") => { message["payload"] = json!({}); None },
                        Some(value) if !value.is_object() => Some(AppError::action("操作参数无效")),
                        _ => None,
                    }
                };
                if let Some(error) = error {
                    let _ = sender.send(Outbound::Json(error.socket_message(request_id)));
                    continue;
                }
                if message["type"] == "leave" {
                    // Leave bypasses a pending model call and invalidates its eventual writeback.
                    let reply = match state.rooms.handle(connection_id, message).await {
                        Ok(()) => json!({"type":"ack", "requestId":request_id}),
                        Err(error) => AppError::from(error).socket_message(request_id),
                    };
                    let _ = sender.send(Outbound::Json(reply));
                    continue;
                }
                if message["type"] == "chat" {
                    let _ = sender.send(Outbound::Json(AppError::new("CHAT_DISABLED", "房间聊天已关闭。").socket_message(request_id)));
                    continue;
                }
                if busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
                    let _ = sender.send(Outbound::Json(AppError::action("上一项操作仍在处理").socket_message(request_id)));
                    continue;
                }
                if message["type"] != "action" || message["payload"]["action"] != "quote" {
                    // Apply short state transitions in receive order. In particular,
                    // a following leave must see a create/join/resume that preceded it.
                    let result = state.rooms.handle(connection_id, message).await;
                    busy.store(false, Ordering::Release);
                    let reply = match result {
                        Ok(()) => json!({"type":"ack", "requestId":request_id}),
                        Err(error) => AppError::from(error).socket_message(request_id),
                    };
                    let _ = sender.send(Outbound::Json(reply));
                } else {
                    // Only quote waits on the model. Keep reading so leave and
                    // heartbeat messages can proceed during that request.
                    let rooms = state.rooms.clone();
                    let sender = sender.clone();
                    let busy = busy.clone();
                    tokio::spawn(async move {
                        let result = rooms.handle(connection_id, message).await;
                        busy.store(false, Ordering::Release);
                        let reply = match result {
                            Ok(()) => json!({"type":"ack", "requestId":request_id}),
                            Err(error) => AppError::from(error).socket_message(request_id),
                        };
                        let _ = sender.send(Outbound::Json(reply));
                    });
                }
            }
            _ = heartbeat.tick() => {
                let now = Instant::now();
                if let Some(sent) = awaiting_pong {
                    if now.duration_since(sent) >= heartbeat_timeout { break; }
                } else if now >= next_ping {
                    awaiting_pong = Some(now);
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
            }
        }
    }
    state.rooms.disconnect(connection_id, false).await;
}
