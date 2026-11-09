use serde_json::Value;

/// Only the connection task writes frames to the socket.
#[derive(Debug)]
pub enum Outbound {
    Json(Value),
    Close(u16, String),
}
