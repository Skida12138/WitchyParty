//! Game state and alchemy planning, independent of HTTP and WebSocket transport.
mod game;
mod material;
mod random;
mod resolution;
mod rules;
pub use game::{
    BotPlayerSnapshot, BotSnapshot, GameRoom, Phase, Player, PlayerStatus, QuoteTicket, Timing,
};
use material::{Contribution, PotMaterial};
pub use material::{Material, Quote};
pub use random::RandomSource;
pub use resolution::{Alchemy, Resolution};
pub use rules::*;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct GameError {
    pub code: String,
    pub message: String,
}
impl GameError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::with_code("ACTION_FAILED", message)
    }
    pub fn with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, GameError>;
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}
