use super::{
    Contribution, GameError, Material, PotMaterial, Quote, RandomSource, Resolution, Result,
    max_players, max_quotes, now_ms, price_cache, rules, starting_coins, uid,
    validate_material_name, validate_price,
};
use rand::Rng;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Lobby,
    Preparing,
    Resolving,
    Performing,
    RoundEnd,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerStatus {
    Active,
    Eliminated,
}

#[derive(Debug, Clone)]
pub struct BotSnapshot {
    pub room_session_id: String,
    pub player_id: String,
    pub round: u64,
    pub total_rounds: u64,
    pub phase: Phase,
    pub coins: i64,
    pub quotes: Vec<Quote>,
    pub prepared_quote_id: Option<String>,
    pub players: Vec<BotPlayerSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BotPlayerSnapshot {
    pub id: String,
    pub name: String,
    pub bot: bool,
    pub connected: bool,
    pub status: PlayerStatus,
    pub score: i64,
    pub ready: bool,
}

#[derive(Debug, Clone)]
pub struct Timing {
    pub deposit_ms: u64,
    pub reaction_ms: u64,
    pub hold_ms: u64,
    pub chain_hold_ms: u64,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            deposit_ms: rules()["depositMs"].as_u64().unwrap(),
            reaction_ms: rules()["reactionMs"].as_u64().unwrap(),
            hold_ms: rules()["holdMs"].as_u64().unwrap(),
            chain_hold_ms: rules()["chainHoldMs"]
                .as_u64()
                .unwrap()
                .min(rules()["holdMs"].as_u64().unwrap()),
        }
    }
}
#[derive(Debug, Clone)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub bot: bool,
    pub connected: bool,
    pub departure_pending: bool,
    pub departure_reason: Option<String>,
    pub status: PlayerStatus,
    pub coins: i64,
    pub quotes: Vec<Quote>,
    pub prepared_quote_id: Option<String>,
    pub quote_busy: bool,
    quote_request_id: Option<String>,
    round_before: i64,
    round_cost: i64,
}
impl Player {
    fn stop_preparing(&mut self) {
        self.quotes.clear();
        self.prepared_quote_id = None;
        self.quote_busy = false;
        self.quote_request_id = None;
    }
}
#[derive(Debug, Clone)]
pub struct QuoteTicket {
    pub player_id: String,
    pub round: u64,
    pub request_id: String,
    pub name: String,
    pub context: Value,
    pub cached: Option<Material>,
}
#[derive(Debug, Clone)]
pub struct GameRoom {
    id: String,
    room_session_id: String,
    total_rounds: u64,
    ai_ready: bool,
    phase: Phase,
    round: u64,
    host_id: Option<String>,
    players: Vec<Player>,
    disposed: bool,
    round_result: Option<Value>,
    processing_error: Option<String>,
    busy: bool,
    turn_player_id: Option<String>,
    price_cache: BTreeMap<String, Material>,
    timing: Timing,
    seed: String,
    random: RandomSource,
    turn_order: Vec<String>,
    departed_players: Vec<Value>,
    pot: Vec<PotMaterial>,
    contributions: Vec<Contribution>,
    log: Vec<Value>,
    finish_reason: Option<String>,
    match_winner_ids: Vec<String>,
    deadline: Option<u64>,
    resolving_started_at: Option<u64>,
    presentation: Option<Value>,
    resolution: Option<Resolution>,
    frame_index: usize,
}
impl GameRoom {
    pub fn new(id: String, rounds: u32, ai_ready: bool, timing: Timing) -> Result<Self> {
        if !rules()["allowedRounds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_u64() == Some(rounds as u64))
        {
            let allowed = rules()["allowedRounds"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("、");
            return Err(GameError::new(format!("比赛轮数只能是 {allowed} 轮")));
        }
        let seed: [u8; 32] = rand::thread_rng().r#gen();
        Ok(Self {
            id,
            room_session_id: uid(),
            total_rounds: rounds as u64,
            ai_ready,
            timing,
            seed: seed.iter().map(|b| format!("{b:02x}")).collect(),
            random: RandomSource::default(),
            phase: Phase::Lobby,
            round: 0,
            host_id: None,
            players: vec![],
            disposed: false,
            round_result: None,
            processing_error: None,
            busy: false,
            turn_player_id: None,
            price_cache: BTreeMap::new(),
            turn_order: vec![],
            departed_players: vec![],
            pot: vec![],
            contributions: vec![],
            log: vec![],
            finish_reason: None,
            match_winner_ids: vec![],
            deadline: None,
            resolving_started_at: None,
            presentation: None,
            resolution: None,
            frame_index: 0,
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn room_session_id(&self) -> &str {
        &self.room_session_id
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn round(&self) -> u64 {
        self.round
    }
    pub fn host_id(&self) -> Option<&str> {
        self.host_id.as_deref()
    }
    pub fn players(&self) -> &[Player] {
        &self.players
    }
    pub fn round_result(&self) -> Option<&Value> {
        self.round_result.as_ref()
    }

    pub fn can_prepare(&self, id: &str) -> bool {
        !self.disposed
            && self.phase == Phase::Preparing
            && self.player(id).is_ok_and(|player| {
                player.status == PlayerStatus::Active
                    && player.connected
                    && !player.departure_pending
                    && player.prepared_quote_id.is_none()
                    && !player.quote_busy
            })
    }

    pub fn bot_snapshot(&self, id: &str) -> Result<BotSnapshot> {
        self.require_preparation(id)?;
        let player = self.player(id)?;
        let players = self
            .ordered_players()
            .into_iter()
            .map(|player| BotPlayerSnapshot {
                id: player.id.clone(),
                name: player.name.clone(),
                bot: player.bot,
                connected: player.connected,
                status: player.status,
                score: player.coins,
                ready: player.prepared_quote_id.is_some(),
            })
            .collect();
        Ok(BotSnapshot {
            room_session_id: self.room_session_id.clone(),
            player_id: player.id.clone(),
            round: self.round,
            total_rounds: self.total_rounds,
            phase: self.phase,
            coins: player.coins,
            quotes: player.quotes.clone(),
            prepared_quote_id: player.prepared_quote_id.clone(),
            players,
        })
    }

    /// Inject a source before starting a room, for reproducible simulations.
    pub fn set_random_source(&mut self, source: RandomSource) {
        self.random = source;
    }
    pub fn player(&self, id: &str) -> Result<&Player> {
        self.players
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| GameError::new("你不在这个房间里"))
    }
    fn player_mut(&mut self, id: &str) -> Result<&mut Player> {
        self.players
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| GameError::new("你不在这个房间里"))
    }
    fn active(&self) -> Vec<&Player> {
        self.players
            .iter()
            .filter(|p| p.status == PlayerStatus::Active && !p.departure_pending)
            .collect()
    }
    fn check_player(&self, id: &str) -> Result<()> {
        if self.disposed {
            return Err(GameError::new("房间已经关闭"));
        }
        if self.player(id)?.departure_pending {
            return Err(GameError::new("该玩家已确认离场"));
        }
        Ok(())
    }
    fn require_preparation(&self, id: &str) -> Result<()> {
        self.check_player(id)?;
        if self.phase != Phase::Preparing || self.player(id)?.status != PlayerStatus::Active {
            return Err(GameError::new("现在不是你的备料时间"));
        }
        Ok(())
    }
    fn log(&mut self, text: String) {
        self.log.push(json!({"id":uid(),"text":text}));
        if self.log.len() > 60 {
            self.log.remove(0);
        }
    }
    pub fn add_player(&mut self, name: &str, bot: bool) -> Result<String> {
        if self.phase != Phase::Lobby {
            return Err(GameError::new("比赛已经开始，暂时不能加入"));
        }
        if bot && !self.ai_ready {
            return Err(GameError::new(
                "服务器尚未配置 DeepSeek 密钥，暂时无法添加 AI 女巫，请设置 DEEPSEEK_API_KEY 后重启服务",
            ));
        }
        if self.players.len() >= max_players() {
            return Err(GameError::new(format!(
                "房间已满（最多 {} 人）",
                max_players()
            )));
        }
        if self.players.iter().any(|p| p.name == name) {
            return Err(GameError::new("房间内已有这个昵称"));
        }
        let id = uid();
        self.players.push(Player {
            id: id.clone(),
            name: name.to_owned(),
            bot,
            connected: true,
            departure_pending: false,
            departure_reason: None,
            status: PlayerStatus::Active,
            coins: starting_coins(),
            quotes: vec![],
            prepared_quote_id: None,
            quote_busy: false,
            quote_request_id: None,
            round_before: starting_coins(),
            round_cost: 0,
        });
        if !bot && self.host_id.is_none() {
            self.host_id = Some(id.clone());
        }
        self.log(format!("{name} 来到了下午茶聚会"));
        Ok(id)
    }
    pub fn start(&mut self, id: &str) -> Result<()> {
        self.check_player(id)?;
        if self.host_id.as_deref() != Some(id) {
            return Err(GameError::new("只有房主可以开始比赛"));
        }
        if self.phase != Phase::Lobby {
            return Err(GameError::new("比赛已经开始"));
        }
        if !self.ai_ready {
            return Err(GameError::new(
                "服务器尚未配置 DeepSeek 密钥，暂时无法开始比赛，请设置 DEEPSEEK_API_KEY 后重启服务",
            ));
        }
        if self.active().len() < 2 {
            return Err(GameError::new("至少需要两位女巫才能开始"));
        }
        self.begin_round();
        Ok(())
    }
    pub fn next_round(&mut self, id: &str) -> Result<()> {
        self.check_player(id)?;
        if self.host_id.as_deref() != Some(id) {
            return Err(GameError::new("只有房主可以开始下一轮"));
        }
        if self.phase != Phase::RoundEnd {
            return Err(GameError::new("当前还不能开始下一轮"));
        }
        if self.active().len() < 2 {
            return Err(GameError::new("至少需要两位仍在场的女巫才能开始下一轮"));
        }
        self.begin_round();
        Ok(())
    }
    fn begin_round(&mut self) {
        self.round += 1;
        self.phase = Phase::Preparing;
        self.deadline = None;
        self.resolving_started_at = None;
        self.presentation = None;
        self.turn_player_id = None;
        self.pot.clear();
        self.contributions.clear();
        self.round_result = None;
        self.processing_error = None;
        self.resolution = None;
        self.busy = false;
        self.price_cache = price_cache();
        self.frame_index = 0;
        for p in &mut self.players {
            p.round_before = p.coins;
            p.round_cost = 0;
            p.stop_preparing();
        }
        self.turn_order = self.active().iter().map(|p| p.id.clone()).collect();
        for index in (1..self.turn_order.len()).rev() {
            let other = self.random.index(index + 1);
            self.turn_order.swap(index, other);
        }
        self.log(format!("第 {} 轮开始，女巫们各自构想一份材料", self.round));
    }
    pub fn begin_quote(&mut self, id: &str, name: &str) -> Result<QuoteTicket> {
        self.require_preparation(id)?;
        let p = self.player(id)?;
        if p.quote_busy {
            return Err(GameError::new("材料召唤正在处理中，请稍候"));
        }
        if p.prepared_quote_id.is_some() {
            return Err(GameError::new("你已经准备完成，请先取消准备再构想材料"));
        }
        if p.quotes.len() >= max_quotes() {
            return Err(GameError::new(format!(
                "本轮已经用完 {} 次材料构想，请选择已有备选材料",
                max_quotes(),
            )));
        }
        let name = validate_material_name(name)?;
        let request_id = uid();
        let p = self.player_mut(id)?;
        p.quote_busy = true;
        p.quote_request_id = Some(request_id.clone());
        let context = super::resolution::context(&self.price_cache, &BTreeMap::new());
        let cached = self.price_cache.get(&name).cloned().map(|mut material| {
            material.source = Some("cache".to_owned());
            material
        });
        Ok(QuoteTicket {
            player_id: id.to_owned(),
            round: self.round,
            request_id,
            name,
            context,
            cached,
        })
    }
    pub fn finish_quote(&mut self, ticket: &QuoteTicket, result: Result<Value>) -> Result<Quote> {
        let current = !self.disposed
            && self.round == ticket.round
            && self.phase == Phase::Preparing
            && self.players.iter().any(|p| {
                p.id == ticket.player_id
                    && !p.departure_pending
                    && p.status == PlayerStatus::Active
                    && p.quote_request_id.as_deref() == Some(&ticket.request_id)
            });
        if let Ok(p) = self.player_mut(&ticket.player_id)
            && p.quote_request_id.as_deref() == Some(&ticket.request_id)
        {
            p.quote_busy = false;
            p.quote_request_id = None;
        }
        if !current {
            return Err(GameError::new("本次材料召唤已过期，请重新构想"));
        }
        let result = result?;
        let price = validate_price(&result, None)?;
        let source = result["source"].as_str().unwrap_or("deepseek").to_owned();
        let mut material = self
            .price_cache
            .entry(ticket.name.clone())
            .or_insert_with(|| {
                let mut material = Material::new(ticket.name.clone(), price);
                material.source = Some(source.clone());
                material
            })
            .clone();
        material.source = Some(source);
        let quote = Quote {
            id: uid(),
            material,
        };
        self.player_mut(&ticket.player_id)?
            .quotes
            .push(quote.clone());
        Ok(quote)
    }
    pub fn commit(&mut self, id: &str, quote_id: &str) -> Result<()> {
        self.require_preparation(id)?;
        let p = self.player_mut(id)?;
        if p.quote_busy {
            return Err(GameError::new("材料召唤尚未完成，请稍候"));
        }
        if p.prepared_quote_id.is_some() {
            return Err(GameError::new("你已经准备完成，请先取消准备再选择材料"));
        }
        if !p.quotes.iter().any(|q| q.id == quote_id) {
            return Err(GameError::new("请选择本轮已召唤的备选材料"));
        }
        p.prepared_quote_id = Some(quote_id.to_owned());
        if self.active().iter().all(|p| p.prepared_quote_id.is_some()) {
            self.start_resolution();
        }
        Ok(())
    }
    pub fn unready(&mut self, id: &str) -> Result<()> {
        self.require_preparation(id)?;
        let p = self.player_mut(id)?;
        if p.quote_busy {
            return Err(GameError::new("材料召唤尚未完成，请稍候"));
        }
        p.prepared_quote_id = None;
        Ok(())
    }
    fn start_resolution(&mut self) {
        if self.disposed || self.phase != Phase::Preparing {
            return;
        }
        if self.active().len() <= 1 {
            self.finish_without_contributions();
            return;
        }
        if !self.active().iter().all(|p| p.prepared_quote_id.is_some()) {
            return;
        }
        self.contributions = self
            .turn_order
            .iter()
            .enumerate()
            .map(|(order, id)| {
                let player = self.player(id).expect("turn order contains active players");
                let quote = player
                    .quotes
                    .iter()
                    .find(|quote| Some(quote.id.as_str()) == player.prepared_quote_id.as_deref())
                    .expect("ready player has a selected quote");
                Contribution {
                    id: uid(),
                    owner_id: id.clone(),
                    owner_name: player.name.clone(),
                    material: quote.material.without_source(),
                    order,
                }
            })
            .collect();
        for contribution in &self.contributions {
            let player = self
                .players
                .iter_mut()
                .find(|player| player.id == contribution.owner_id)
                .expect("contributor is in this room");
            player.round_cost = contribution.material.price;
            player.coins -= contribution.material.price;
        }
        self.resolution = Some(Resolution::new(
            self.round,
            self.room_session_id.clone(),
            self.contributions.clone(),
            self.price_cache.clone(),
            self.seed.clone(),
            self.timing.clone(),
            self.random.clone(),
        ));
        self.phase = Phase::Resolving;
        self.resolving_started_at = Some(now_ms());
        self.deadline = None;
        self.pot.clear();
        self.turn_player_id = self
            .resolution
            .as_ref()
            .and_then(Resolution::current_player_id);
    }
    pub fn take_resolution(&mut self) -> Option<Resolution> {
        if self.disposed
            || self.phase != Phase::Resolving
            || self.busy
            || self.processing_error.is_some()
        {
            return None;
        }
        let resolution = self.resolution.clone()?;
        self.busy = true;
        Some(resolution)
    }
    pub fn update_resolution_progress(&mut self, resolution: &Resolution) {
        if !self.disposed
            && self.phase == Phase::Resolving
            && self.round == resolution.round
            && self.room_session_id == resolution.room_session_id
            && self.busy
        {
            self.turn_player_id = resolution.current_player_id();
            self.resolution = Some(resolution.clone());
        }
    }
    pub fn apply_resolution(&mut self, resolution: Resolution, result: Result<()>) {
        if self.disposed
            || self.phase != Phase::Resolving
            || self.round != resolution.round
            || self.room_session_id != resolution.room_session_id
        {
            return;
        }
        self.busy = false;
        self.turn_player_id = resolution.current_player_id();
        self.resolution = Some(resolution);
        if let Err(error) = result {
            self.processing_error = Some(error.message);
            return;
        }
        if self.resolution.as_ref().unwrap().completed != self.contributions.len() {
            return;
        }
        self.processing_error = None;
        self.phase = Phase::Performing;
        self.frame_index = 0;
        self.pot.clear();
        self.play_frame(now_ms());
    }
    pub fn retry_commit(&mut self, id: &str) -> Result<()> {
        self.check_player(id)?;
        if self.phase != Phase::Resolving || self.processing_error.is_none() || self.busy {
            return Err(GameError::new("当前没有需要重试的炼金"));
        }
        if self.host_id.as_deref() != Some(id) && self.turn_player_id.as_deref() != Some(id) {
            return Err(GameError::new("只有房主或当前投料的女巫可以重试"));
        }
        self.processing_error = None;
        Ok(())
    }
    pub fn next_deadline(&self) -> Option<u64> {
        self.deadline
    }
    pub fn advance_performance(&mut self, now: u64) -> bool {
        if self.disposed
            || self.phase != Phase::Performing
            || self.deadline.is_none_or(|deadline| now < deadline)
        {
            return false;
        }
        if let Some(frame) = self
            .resolution
            .as_ref()
            .and_then(|work| work.frames.get(self.frame_index))
        {
            self.pot = frame.pot_after.clone();
        }
        self.frame_index += 1;
        self.play_frame(now);
        true
    }
    fn play_frame(&mut self, now: u64) {
        let Some(resolution) = self.resolution.as_ref() else {
            return;
        };
        if let Some(frame) = resolution.frames.get(self.frame_index) {
            self.pot = frame.pot_before.clone();
            self.turn_player_id = Some(frame.player_id.clone());
            self.deadline = Some(now + frame.duration_ms);
            let mut presentation = json!(frame);
            presentation["index"] = json!(self.frame_index);
            presentation["total"] = json!(resolution.frames.len());
            presentation["startedAt"] = json!(now);
            self.presentation = Some(presentation);
        } else {
            self.finish_round(now);
        }
    }
    fn settle_players(&mut self, winner: Option<&str>, pot_value: i64) -> Vec<Value> {
        self.players
            .iter_mut()
            .map(|player| {
                let winnings = if Some(player.id.as_str()) == winner {
                    pot_value
                } else {
                    0
                };
                let raw_balance = player.round_before - player.round_cost + winnings;
                let balance = raw_balance.max(0);
                player.coins = balance;
                if raw_balance <= 0 {
                    player.status = PlayerStatus::Eliminated;
                }
                player.stop_preparing();
                json!({
                    "id": player.id,
                    "name": player.name,
                    "before": player.round_before,
                    "cost": player.round_cost,
                    "winnings": winnings,
                    "rawBalance": raw_balance,
                    "balance": balance,
                    "delta": balance - player.round_before,
                    "eliminated": player.status == PlayerStatus::Eliminated
                })
            })
            .collect()
    }
    fn finish_round(&mut self, now: u64) {
        let resolution = self.resolution.as_ref().unwrap().clone();
        self.pot = resolution.pot;
        self.price_cache = resolution.prices;
        let greatest = self
            .contributions
            .iter()
            .map(|contribution| contribution.material.price)
            .max()
            .unwrap_or(0);
        let tied: Vec<_> = self
            .contributions
            .iter()
            .filter(|contribution| contribution.material.price == greatest)
            .collect();
        let winner = tied[if tied.len() == 1 {
            0
        } else {
            self.random.index(tied.len())
        }]
        .clone();
        let winner_id = winner.owner_id.clone();
        let pot_value = self.pot.iter().map(|item| item.material.price).sum::<i64>();
        let celebration = json!({
            "id": uid(),
            "startedAt": now,
            "animationMs": rules()["winnerAnimationMs"],
            "winner": {
                "id": winner_id,
                "name": winner.owner_name,
                "bot": self.player(&winner_id).is_ok_and(|player| player.bot),
                "avatarIndex": self.turn_order.iter().position(|id| id == &winner_id)
            },
            "material": {
                "name": winner.material.name,
                "price": winner.material.price,
                "tier": winner.material.tier,
                "ownerId": winner_id
            },
            "backdrop": self.presentation
        });
        let rows = self.settle_players(Some(&winner_id), pot_value);
        self.round_result = Some(json!({
            "round": self.round,
            "winnerId": winner_id,
            "potValue": pot_value,
            "reason": "highest-contribution",
            "contributions": self.contributions,
            "products": resolution.products,
            "winnerCelebration": celebration,
            "players": rows
        }));
        self.log(format!(
            "{} 以最高原始投料赢得 {} 金币",
            winner.owner_name, pot_value
        ));
        self.complete_round_boundary();
    }
    fn finish_without_contributions(&mut self) {
        let winner = self.active().first().map(|p| p.id.clone());
        let rows = self.settle_players(None, 0);
        self.round_result = Some(json!({
            "round": self.round,
            "winnerId": winner,
            "potValue": 0,
            "reason": if winner.is_some() { "last-standing" } else { "no-contenders" },
            "contributions": [],
            "products": [],
            "players": rows
        }));
        self.complete_round_boundary();
    }
    fn complete_round_boundary(&mut self) {
        self.deadline = None;
        self.turn_player_id = None;
        self.presentation = None;
        self.resolution = None;
        self.busy = false;
        self.processing_error = None;
        self.phase = Phase::RoundEnd;
        self.remove_departed();
    }
    fn update_match_outcome(&mut self) {
        let active = self.active();
        let (reason, winners) = if active.len() <= 1 {
            (
                Some(if active.is_empty() {
                    "no-contenders"
                } else {
                    "last-standing"
                }),
                active.iter().map(|p| p.id.clone()).collect(),
            )
        } else if self.round >= self.total_rounds {
            let max = active.iter().map(|p| p.coins).max().unwrap();
            (
                Some("round-limit"),
                active
                    .iter()
                    .filter(|p| p.coins == max)
                    .map(|p| p.id.clone())
                    .collect(),
            )
        } else {
            (None, vec![])
        };
        self.finish_reason = reason.map(str::to_owned);
        self.match_winner_ids = winners;
        if self.finish_reason.is_some() {
            self.phase = Phase::Finished;
        }
    }
    fn ensure_host(&mut self) {
        if self.players.iter().any(|p| {
            Some(p.id.as_str()) == self.host_id.as_deref() && !p.bot && !p.departure_pending
        }) {
            return;
        }
        self.host_id = self
            .players
            .iter()
            .find(|p| !p.bot && p.connected && !p.departure_pending)
            .map(|p| p.id.clone());
    }
    pub fn set_connected(&mut self, id: &str, connected: bool) -> Result<()> {
        let p = self.player_mut(id)?;
        if connected && p.departure_pending {
            return Err(GameError::new("该玩家已确认离场"));
        }
        p.connected = connected;
        if connected && self.host_id.is_none() {
            self.ensure_host();
        }
        Ok(())
    }
    pub fn mark_departing(&mut self, id: &str, reason: &str) -> bool {
        if self.disposed {
            return false;
        }
        let Ok(p) = self.player_mut(id) else {
            return false;
        };
        if p.departure_pending {
            return false;
        }
        p.connected = false;
        p.departure_pending = true;
        p.departure_reason = Some(reason.into());
        self.ensure_host();
        match self.phase {
            Phase::Lobby | Phase::RoundEnd | Phase::Finished => self.remove_departed(),
            Phase::Preparing => {
                self.player_mut(id).unwrap().stop_preparing();
                self.turn_order.retain(|i| i != id);
                if self.active().len() <= 1 {
                    self.finish_without_contributions();
                } else if self.active().iter().all(|p| p.prepared_quote_id.is_some()) {
                    self.start_resolution();
                }
            }
            _ => {}
        }
        true
    }
    fn remove_departed(&mut self) {
        for p in self.players.iter().filter(|p| p.departure_pending) {
            if self.round > 0 {
                self.departed_players.push(json!({
                    "id": p.id,
                    "name": p.name,
                    "bot": p.bot,
                    "connected": false,
                    "departurePending": true,
                    "status": "departed",
                    "score": p.coins,
                    "coins": p.coins
                }));
            }
        }
        self.players.retain(|p| !p.departure_pending);
        self.turn_order
            .retain(|id| self.players.iter().any(|p| &p.id == id));
        self.ensure_host();
        if self.phase == Phase::RoundEnd {
            self.update_match_outcome();
        }
    }
    fn ordered_players(&self) -> Vec<&Player> {
        let mut players: Vec<_> = self.players.iter().collect();
        players.sort_by_key(|player| {
            self.turn_order
                .iter()
                .position(|id| id == &player.id)
                .unwrap_or(usize::MAX)
        });
        players
    }

    pub fn view(&self, id: &str) -> Result<Value> {
        let player = self.player(id)?;
        let players: Vec<_> = self
            .ordered_players()
            .into_iter()
            .map(|player| {
                json!({
                    "id": player.id,
                    "name": player.name,
                    "bot": player.bot,
                    "connected": player.connected,
                    "departurePending": player.departure_pending,
                    "status": player.status,
                    "coins": player.coins,
                    "score": player.coins,
                    "isHost": Some(&player.id) == self.host_id.as_ref(),
                    "ready": player.prepared_quote_id.is_some()
                })
            })
            .collect();
        let pot: Vec<_> = self
            .pot
            .iter()
            .map(|item| {
                let mut material = json!(item);
                material["own"] = json!(item.owner_id.as_deref() == Some(id));
                material
            })
            .collect();
        let round_result = if matches!(self.phase, Phase::RoundEnd | Phase::Finished) {
            self.round_result.as_ref()
        } else {
            None
        };
        Ok(json!({
            "id": self.id,
            "phase": self.phase,
            "round": self.round,
            "totalRounds": self.total_rounds,
            "finishReason": self.finish_reason,
            "matchWinnerId": self.match_winner_ids.first(),
            "matchWinnerIds": self.match_winner_ids,
            "hostId": self.host_id,
            "turnPlayerId": self.turn_player_id,
            "turnOrder": self.turn_order,
            "deadline": self.deadline,
            "serverTime": now_ms(),
            "resolvingStartedAt": self.resolving_started_at,
            "mode": "deepseek",
            "aiReady": self.ai_ready,
            "busy": self.busy,
            "processingError": self.processing_error,
            "resolutionProgress": self.resolution.as_ref().map(|resolution| json!({
                "completed": resolution.completed,
                "total": resolution.contributions.len()
            })),
            "players": players,
            "departedPlayers": self.departed_players,
            "me": {
                "id": player.id,
                "coins": player.coins,
                "score": player.coins,
                "quotes": player.quotes,
                "quotesRemaining": max_quotes().saturating_sub(player.quotes.len()),
                "preparedQuoteId": player.prepared_quote_id,
                "quoteBusy": player.quote_busy
            },
            "contributions": self.contributions,
            "presentation": self.presentation,
            "pot": pot,
            "roundResult": round_result,
            "log": self.log,
            "rules": {
                "maxQuotes": max_quotes(),
                "startingCoins": starting_coins(),
                "depositMs": self.timing.deposit_ms,
                "reactionMs": self.timing.reaction_ms,
                "holdMs": self.timing.hold_ms,
                "chainHoldMs": self.timing.chain_hold_ms
            }
        }))
    }
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.deadline = None;
        self.resolution = None;
    }
}
