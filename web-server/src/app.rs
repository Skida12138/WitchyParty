//! Application assembly; each domain owns its service and transport entrypoints.

use crate::{access::InviteAccess, alchemy::AlchemyService, bots::BotService, rooms::RoomsService};

#[derive(Clone)]
pub struct AppState {
    pub rooms: RoomsService,
    pub access: InviteAccess,
    pub ai_ready: bool,
}

impl AppState {
    pub fn new(alchemy: AlchemyService, bots: BotService) -> Self {
        Self {
            ai_ready: alchemy.ready(),
            rooms: RoomsService::new(alchemy, bots),
            access: InviteAccess::new(std::env::var("INVITE_CODE_SHA256").ok().as_deref()),
        }
    }
}
