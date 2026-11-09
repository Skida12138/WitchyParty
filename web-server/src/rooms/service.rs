//! In-memory room orchestration. Locks protect short state transitions only;
//! model calls and WebSocket writes never hold the room registry lock.
use super::types::Outbound;
use crate::gameplay::{GameError, GameRoom, Phase, Quote, QuoteTicket, Timing};
use crate::{
    alchemy::AlchemyService,
    bots::{BotAction, BotService},
};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

type PriceFlight = Shared<BoxFuture<'static, Result<Value, GameError>>>;
struct QuoteWork {
    ticket: QuoteTicket,
    flight: PriceFlight,
    cancel: CancellationToken,
    _task: TaskTrackerToken,
}

#[derive(Clone)]
pub struct RoomsService(Arc<Inner>);
struct Inner {
    state: Mutex<State>,
    alchemy: AlchemyService,
    stop: CancellationToken,
    tasks: TaskTracker,
    grace_ms: u64,
    timing: Timing,
    bots: BotService,
    room_setup: fn(&mut GameRoom),
}
#[derive(Default)]
struct State {
    closing: bool,
    rooms: HashMap<String, Room>,
    connections: HashMap<Uuid, Connection>,
}
struct Connection {
    sender: UnboundedSender<Outbound>,
    seat: Option<(String, String)>,
}
struct Room {
    game: GameRoom,
    sockets: HashMap<String, Uuid>,
    tokens: HashMap<String, String>,
    disconnected: HashMap<String, u64>,
    empty_since: Option<u64>,
    cancel: CancellationToken,
    jobs: HashSet<String>,
    flights: HashMap<(u64, String), PriceFlight>,
    memory_round: Option<u64>,
    next_ai: u64,
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn setting(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 20)
        .unwrap_or(default)
}
fn timing() -> Timing {
    let read = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .map(|v| {
                v.parse::<f64>()
                    .ok()
                    .filter(|v| v.is_finite())
                    .unwrap_or(0.0)
                    .max(0.0) as u64
            })
            .unwrap_or(default)
    };
    let defaults = Timing::default();
    let hold_ms = read("HOLD_MS", defaults.hold_ms);
    Timing {
        deposit_ms: read("DEPOSIT_MS", defaults.deposit_ms),
        reaction_ms: read("REACTION_MS", defaults.reaction_ms),
        hold_ms,
        chain_hold_ms: read("CHAIN_HOLD_MS", hold_ms.min(defaults.chain_hold_ms)),
    }
}
fn token(bytes: usize) -> String {
    let mut data = vec![0; bytes];
    OsRng.fill_bytes(&mut data);
    data.iter().map(|v| format!("{v:02x}")).collect()
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn player_name(value: &Value) -> Result<String, GameError> {
    let Some(name) = value.as_str() else {
        return Err(GameError::new("请输入女巫昵称"));
    };
    let name = name.nfkc().collect::<String>().trim().to_owned();
    static INVISIBLE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{Cc}\p{Cf}]").unwrap());
    if name.is_empty() || name.chars().count() > 16 || INVISIBLE.is_match(&name) {
        return Err(GameError::new("昵称需要 1–16 个可见字符"));
    }
    Ok(name)
}
impl RoomsService {
    pub fn new(alchemy: AlchemyService, bots: BotService) -> Self {
        Self::with_room_setup(alchemy, bots, |_| {})
    }
    /// Embed the service with an explicit room initializer (used by protocol fixtures).
    /// The production entrypoint always uses `new` and has no random override.
    pub fn with_room_setup(
        alchemy: AlchemyService,
        bots: BotService,
        room_setup: fn(&mut GameRoom),
    ) -> Self {
        let service = Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            alchemy,
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
            grace_ms: setting("RECONNECT_GRACE_MS", 30000),
            timing: timing(),
            bots,
            room_setup,
        }));
        let runner = service.clone();
        service.0.tasks.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(
                (runner.0.grace_ms / 4).clamp(20, 100),
            ));
            loop {
                tokio::select! {_=runner.0.stop.cancelled()=>break,_=interval.tick()=>runner.maintain()}
            }
        });
        service
    }
    pub async fn register(&self, sender: UnboundedSender<Outbound>) -> Uuid {
        let id = Uuid::new_v4();
        let mut state = self.0.state.lock().unwrap();
        if state.closing {
            let _ = sender.send(Outbound::Close(1001, "服务器停止".into()));
        } else {
            state
                .connections
                .insert(id, Connection { sender, seat: None });
        }
        id
    }
    pub async fn handle(&self, id: Uuid, message: Value) -> Result<(), GameError> {
        let p = message.get("payload").cloned().unwrap_or(json!({}));
        if !p.is_object() {
            return Err(GameError::new("操作参数无效"));
        }
        let kind = text(&message, "type");
        if kind == "leave" {
            self.disconnect(id, true).await;
            return Ok(());
        }
        if kind == "chat" {
            return Err(GameError::with_code("CHAT_DISABLED", "房间聊天已关闭。"));
        }
        if kind == "action" {
            let (room, player) = {
                let state = self.0.state.lock().unwrap();
                state
                    .connections
                    .get(&id)
                    .and_then(|c| c.seat.clone())
                    .ok_or_else(|| GameError::new("请先加入房间"))?
            };
            return self.action(&room, &player, &p).await;
        }
        // Session failures may still remove an expired seat and start a round.
        // Finalize every touched room before returning either success or failure.
        let mut affected_room = None;
        let result = (|| {
            let mut state = self.0.state.lock().unwrap();
            if state.closing {
                return Err(GameError::new("服务器停止"));
            }
            if state
                .connections
                .get(&id)
                .is_none_or(|c| c.sender.is_closed())
            {
                return Err(GameError::new("连接已关闭"));
            }
            if state.connections[&id].seat.is_some() {
                return Err(GameError::new("你已在房间中，请先离开"));
            }
            match kind.as_str() {
                "create" => {
                    if p["demo"].as_bool() == Some(true) {
                        return Err(GameError::new(
                            "独立陪练房间已取消，请创建普通房间后添加 AI 女巫",
                        ));
                    }
                    if state.rooms.len() >= 100 {
                        return Err(GameError::new("房间暂时已满"));
                    }
                    let name = player_name(&p["name"])?;
                    let rounds = p["rounds"]
                        .as_u64()
                        .and_then(|v| u32::try_from(v).ok())
                        .ok_or_else(|| GameError::new("轮数必须是正整数"))?;
                    let code = loop {
                        let c = token(3).to_uppercase();
                        if !state.rooms.contains_key(&c) {
                            break c;
                        }
                    };
                    let mut game = GameRoom::new(
                        code.clone(),
                        rounds,
                        self.0.alchemy.ready(),
                        self.0.timing.clone(),
                    )?;
                    (self.0.room_setup)(&mut game);
                    let player = game.add_player(&name, false)?;
                    let mut room = Room {
                        game,
                        sockets: HashMap::new(),
                        tokens: HashMap::new(),
                        disconnected: HashMap::new(),
                        empty_since: None,
                        cancel: CancellationToken::new(),
                        jobs: HashSet::new(),
                        flights: HashMap::new(),
                        memory_round: None,
                        next_ai: now() + 700,
                    };
                    room.tokens.insert(player.clone(), token(32));
                    let logger = self.0.alchemy.with_trace(Self::trace(&room, None));
                    logger.record_event(
                        json!({"type":"room_created","status":"created","totalRounds":rounds}),
                    );
                    affected_room = Some(code.clone());
                    state.rooms.insert(code.clone(), room);
                    Self::bind(&mut state, id, &code, &player)?;
                    Ok(())
                }
                "join" | "resume" => {
                    let code = if kind == "join" {
                        text(&p, "roomId").trim().to_uppercase()
                    } else {
                        text(&p, "roomId")
                    };
                    affected_room = Some(code.clone());
                    self.expire_room(&mut state, &code);
                    let room = state.rooms.get_mut(&code).ok_or_else(|| {
                        if kind == "resume" {
                            GameError::with_code(
                                "ROOM_CLOSED",
                                "这场集会已关闭，请重新创建或加入房间。",
                            )
                        } else {
                            GameError::new("找不到这个房间，请检查房间码")
                        }
                    })?;
                    let player = if kind == "join" {
                        let name = player_name(&p["name"])?;
                        let player = room.game.add_player(&name, false)?;
                        room.tokens.insert(player.clone(), token(32));
                        player
                    } else {
                        let player = text(&p, "playerId");
                        let supplied = text(&p, "token");
                        let expected = room.tokens.get(&player).ok_or_else(|| {
                            GameError::with_code("SESSION_EXPIRED", "房间身份已失效，请返回大厅。")
                        })?;
                        if supplied.len() != expected.len()
                            || !bool::from(supplied.as_bytes().ct_eq(expected.as_bytes()))
                        {
                            return Err(GameError::with_code(
                                "SESSION_EXPIRED",
                                "房间身份已失效，请返回大厅。",
                            ));
                        }
                        if !room
                            .game
                            .players()
                            .iter()
                            .any(|p| p.id == player && !p.departure_pending)
                        {
                            return Err(GameError::with_code(
                                "PLAYER_REMOVED",
                                "你已离开这场集会，请返回大厅。",
                            ));
                        }
                        if room
                            .disconnected
                            .get(&player)
                            .is_some_and(|t| now().saturating_sub(*t) >= self.0.grace_ms)
                        {
                            room.game.mark_departing(&player, "disconnect");
                            return Err(GameError::with_code(
                                "PLAYER_REMOVED",
                                "重连时间已过，你已离开这场集会。",
                            ));
                        }
                        player
                    };
                    Self::bind(&mut state, id, &code, &player)?;
                    Ok(())
                }
                _ => return Err(GameError::new("不支持的消息")),
            }
        })();
        if let Some(code) = affected_room {
            self.changed(&code);
        }
        result
    }
    fn bind(state: &mut State, id: Uuid, room_id: &str, player_id: &str) -> Result<(), GameError> {
        let room = state.rooms.get_mut(room_id).unwrap();
        if let Some(previous) = room
            .sockets
            .insert(player_id.to_owned(), id)
            .filter(|p| *p != id)
        {
            if let Some(connection) = state.connections.remove(&previous) {
                let _ = connection
                    .sender
                    .send(Outbound::Close(4001, "已在另一窗口连接".into()));
            }
        }
        room.disconnected.remove(player_id);
        room.empty_since = None;
        room.game.set_connected(player_id, true)?;
        let connection = state
            .connections
            .get_mut(&id)
            .ok_or_else(|| GameError::new("连接已关闭"))?;
        connection.seat = Some((room_id.into(), player_id.into()));
        let _ = connection.sender.send(Outbound::Json(json!({
            "type": "session",
            "roomId": room_id,
            "playerId": player_id,
            "token": room.tokens[player_id],
        })));
        Ok(())
    }
    /// All room edits reconcile sessions, schedule newly available work and
    /// broadcast even when the operation returns an error after changing state.
    fn update_room<T>(
        &self,
        code: &str,
        change: impl FnOnce(&mut Room) -> Result<T, GameError>,
    ) -> Result<T, GameError> {
        let result = {
            let mut state = self.0.state.lock().unwrap();
            state
                .rooms
                .get_mut(code)
                .ok_or_else(|| GameError::with_code("ROOM_CLOSED", "房间已关闭"))
                .and_then(change)
        };
        self.changed(code);
        result
    }

    async fn action(&self, code: &str, player: &str, p: &Value) -> Result<(), GameError> {
        let action = text(p, "action");
        if action == "quote" {
            return self.quote(code, player, text(p, "name")).await.map(|_| ());
        }
        self.update_room(code, |room| match action.as_str() {
            "start" => room.game.start(player),
            "nextRound" => room.game.next_round(player),
            "commit" => room.game.commit(player, &text(p, "quoteId")),
            "unready" => room.game.unready(player),
            "retryCommit" => room.game.retry_commit(player),
            "addBot" => {
                if room.game.host_id() != Some(player) {
                    return Err(GameError::new("只有房主可以添加 AI 女巫"));
                }
                let names: Vec<_> = room
                    .game
                    .players()
                    .iter()
                    .map(|p| p.name.as_str())
                    .collect();
                let profile = self.0.bots.next_profile(&names);
                let id = room.game.add_player(&profile.name, true)?;
                self.0
                    .bots
                    .register(room.game.room_session_id(), &id, &profile.persona);
                Ok(())
            }
            _ => Err(GameError::new("不支持的操作")),
        })
    }
    fn begin_quote(
        &self,
        room: &mut Room,
        player: &str,
        name: &str,
    ) -> Result<QuoteWork, GameError> {
        let ticket = room.game.begin_quote(player, name)?;
        let key = (ticket.round, ticket.name.clone());
        let trace = Self::trace(room, Some(player));
        let flight = if let Some(cached) = ticket.cached.clone() {
            futures::future::ready(Ok(json!(cached))).boxed().shared()
        } else {
            room.flights
                .entry(key)
                .or_insert_with(|| {
                    let provider = self.0.alchemy.with_trace(trace);
                    let name = ticket.name.clone();
                    let context = ticket.context.clone();
                    async move { provider.price(&name, context).await }
                        .boxed()
                        .shared()
                })
                .clone()
        };
        Ok(QuoteWork {
            ticket,
            flight,
            cancel: room.cancel.clone(),
            _task: self.0.tasks.token(),
        })
    }

    async fn quote(&self, code: &str, player: &str, name: String) -> Result<Quote, GameError> {
        let work = self.update_room(code, |room| self.begin_quote(room, player, &name))?;
        self.finish_quote(code, work).await
    }

    async fn finish_quote(&self, code: &str, work: QuoteWork) -> Result<Quote, GameError> {
        let QuoteWork {
            ticket,
            flight,
            cancel,
            _task,
        } = work;
        let flight_identity = flight.clone();
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(GameError::with_code("ROOM_CLOSED", "房间已关闭")),
            result = flight => result,
        };
        self.update_room(code, |room| {
            let key = (ticket.round, ticket.name.clone());
            if room
                .flights
                .get(&key)
                .is_some_and(|current| current.ptr_eq(&flight_identity))
            {
                room.flights.remove(&key);
            }
            room.game.finish_quote(&ticket, result)
        })
    }
    pub async fn disconnect(&self, id: Uuid, explicit: bool) {
        let code = {
            let mut state = self.0.state.lock().unwrap();
            // Explicit leave retains the transport, so a client can create/join again.
            let seat = if explicit {
                state.connections.get_mut(&id).and_then(|c| c.seat.take())
            } else {
                state.connections.remove(&id).and_then(|c| c.seat)
            };
            let Some((code, player)) = seat else { return };
            let Some(room) = state.rooms.get_mut(&code) else {
                return;
            };
            if room.sockets.get(&player) != Some(&id) {
                return;
            }
            room.sockets.remove(&player);
            if explicit {
                room.tokens.remove(&player);
                room.disconnected.remove(&player);
                let _ = room.game.mark_departing(&player, "leave");
            } else {
                room.disconnected.insert(player.clone(), now());
                let _ = room.game.set_connected(&player, false);
            }
            code
        };
        self.changed(&code);
    }
    fn connected_humans(room: &Room) -> bool {
        room.game
            .players()
            .iter()
            .any(|p| !p.bot && !p.departure_pending && room.sockets.contains_key(&p.id))
    }
    fn activity(room: &mut Room) {
        if Self::connected_humans(room) {
            room.empty_since = None
        } else {
            room.empty_since.get_or_insert_with(now);
        }
    }
    fn expire_room(&self, state: &mut State, code: &str) {
        if state.rooms.get(code).is_some_and(|r| {
            !Self::connected_humans(r)
                && r.empty_since
                    .is_some_and(|t| now().saturating_sub(t) >= self.0.grace_ms)
        }) {
            self.destroy(state, code);
        }
    }
    fn destroy(&self, state: &mut State, code: &str) {
        if let Some(mut room) = state.rooms.remove(code) {
            room.cancel.cancel();
            room.game.dispose();
            self.0.bots.clear_room(room.game.room_session_id());
            for id in room.sockets.values() {
                if let Some(c) = state.connections.remove(id) {
                    let _ = c.sender.send(Outbound::Json(json!({
                        "type": "session_ended",
                        "code": "ROOM_CLOSED",
                        "message": "这场集会已结束，请重新创建房间。",
                    })));
                    let _ = c.sender.send(Outbound::Close(4003, "房间已关闭".into()));
                }
            }
        }
    }
    fn reconcile(&self, state: &mut State, code: &str) {
        let Some(room) = state.rooms.get_mut(code) else {
            return;
        };
        let current: HashSet<String> = room
            .game
            .players()
            .iter()
            .filter(|p| !p.departure_pending)
            .map(|p| p.id.clone())
            .collect();
        let removed: Vec<String> = room
            .tokens
            .keys()
            .filter(|id| !current.contains(*id))
            .cloned()
            .collect();
        for player in removed {
            room.tokens.remove(&player);
            room.disconnected.remove(&player);
            if let Some(id) = room.sockets.remove(&player) {
                if let Some(c) = state.connections.remove(&id) {
                    let _ = c.sender.send(Outbound::Json(json!({
                        "type": "session_ended",
                        "code": "PLAYER_REMOVED",
                        "message": "你已离开这场集会，请返回大厅。",
                    })));
                    let _ = c.sender.send(Outbound::Close(4003, "已离开集会".into()));
                }
            }
        }
        self.0
            .bots
            .retain_players(room.game.room_session_id(), &current);
        if let Some(result) = room.game.round_result() {
            let round = result["round"].as_u64();
            if round != room.memory_round {
                self.0
                    .bots
                    .record_round(room.game.room_session_id(), result);
                room.memory_round = round;
            }
        }
        Self::activity(room);
    }

    fn publish(&self, state: &State, code: &str) {
        let Some(room) = state.rooms.get(code) else {
            return;
        };
        for (player, id) in &room.sockets {
            if let (Some(connection), Ok(view)) =
                (state.connections.get(id), room.game.view(player))
            {
                let _ = connection
                    .sender
                    .send(Outbound::Json(json!({"type":"state","state":view})));
            }
        }
    }
    fn changed(&self, code: &str) {
        let work = {
            let mut state = self.0.state.lock().unwrap();
            self.reconcile(&mut state, code);
            let work = state.rooms.get_mut(code).and_then(|room| {
                room.game.take_resolution().map(|resolution| {
                    (
                        resolution,
                        room.cancel.clone(),
                        Self::trace(room, None),
                        self.0.tasks.token(),
                    )
                })
            });
            self.publish(&state, code);
            work
        };
        if let Some((mut resolution, cancel, trace, task)) = work {
            let service = self.clone();
            let code = code.to_owned();
            let provider = self.0.alchemy.with_trace(trace);
            tokio::spawn(async move {
                let _task = task;
                let result = loop {
                    {
                        let mut state = service.0.state.lock().unwrap();
                        if let Some(room) = state.rooms.get_mut(&code) {
                            room.game.update_resolution_progress(&resolution);
                        }
                        service.publish(&state, &code);
                    }
                    match tokio::select! {_=cancel.cancelled()=>return,result=resolution.run_next(&provider)=>result}
                    {
                        Ok(true) => break Ok(()),
                        Ok(false) => {}
                        Err(error) => break Err(error),
                    }
                };
                {
                    let mut state = service.0.state.lock().unwrap();
                    if let Some(room) = state.rooms.get_mut(&code) {
                        room.game.apply_resolution(resolution, result);
                    }
                }
                service.changed(&code);
            });
        }
    }
    fn trace(room: &Room, player: Option<&str>) -> Value {
        let player = player
            .and_then(|id| room.game.players().iter().find(|p| p.id == id))
            .map(|p| json!({"id":p.id,"name":p.name,"bot":p.bot}));
        json!({
            "roomId": room.game.id(),
            "roomSessionId": room.game.room_session_id(),
            "round": room.game.round(),
            "lap": 1,
            "phase": room.game.phase(),
            "player": player,
        })
    }
    fn maintain(&self) {
        let mut changed = Vec::new();
        let mut jobs = Vec::new();
        {
            let mut state = self.0.state.lock().unwrap();
            let codes: Vec<_> = state.rooms.keys().cloned().collect();
            for code in codes {
                self.expire_room(&mut state, &code);
                let Some(room) = state.rooms.get_mut(&code) else {
                    continue;
                };
                let timestamp = now();
                let mut dirty = room.game.advance_performance(timestamp);
                let expired: Vec<_> = room
                    .disconnected
                    .iter()
                    .filter(|(_, time)| timestamp.saturating_sub(**time) >= self.0.grace_ms)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in expired {
                    room.disconnected.remove(&id);
                    let _ = room.game.mark_departing(&id, "disconnect");
                    dirty = true;
                }
                if dirty {
                    changed.push(code.clone());
                }
                if room.game.phase() == Phase::Preparing
                    && Self::connected_humans(room)
                    && timestamp >= room.next_ai
                {
                    room.next_ai = timestamp + 700;
                    let players: Vec<_> = room
                        .game
                        .players()
                        .iter()
                        .filter(|p| p.bot && room.game.can_prepare(&p.id))
                        .map(|p| p.id.clone())
                        .collect();
                    for player in players {
                        if room.jobs.insert(player.clone()) {
                            jobs.push((
                                code.clone(),
                                player,
                                room.game.round(),
                                room.cancel.clone(),
                                self.0.tasks.token(),
                            ));
                        }
                    }
                }
            }
        }
        for code in changed {
            self.changed(&code)
        }
        for (code, player, round, cancel, task) in jobs {
            let service = self.clone();
            tokio::spawn(async move {
                let _task = task;
                let result = tokio::select! {_=cancel.cancelled()=>return,result=service.prepare_bot(&code,&player,round)=>result};
                {
                    let mut state = service.0.state.lock().unwrap();
                    if let Some(room) = state.rooms.get_mut(&code) {
                        room.jobs.remove(&player);
                        if let Err(error) = result {
                            if Self::bot_current(room, &player, round) {
                                let logger = service
                                    .0
                                    .alchemy
                                    .with_trace(Self::trace(room, Some(&player)));
                                logger.record_event(json!({"type":"player_disconnected","status":"ai_unavailable","error":error.message}));
                                let _ = room.game.mark_departing(&player, "ai-unavailable");
                            }
                        }
                    }
                }
                service.changed(&code);
            });
        }
    }
    fn bot_current(room: &Room, player: &str, round: u64) -> bool {
        room.game.round() == round && room.game.can_prepare(player)
    }

    async fn prepare_bot(&self, code: &str, player: &str, round: u64) -> Result<(), GameError> {
        loop {
            let (snapshot, trace) = {
                let state = self.0.state.lock().unwrap();
                let Some(room) = state.rooms.get(code) else {
                    return Ok(());
                };
                if !Self::bot_current(room, player, round) || !Self::connected_humans(room) {
                    return Ok(());
                }
                (
                    room.game.bot_snapshot(player)?,
                    Self::trace(room, Some(player)),
                )
            };
            let session = snapshot.room_session_id.clone();
            let provider = self.0.alchemy.with_trace(trace);
            let decision = self.0.bots.decide(&provider, snapshot).await;
            {
                let state = self.0.state.lock().unwrap();
                if !state.rooms.get(code).is_some_and(|r| {
                    r.game.room_session_id() == session
                        && Self::bot_current(r, player, round)
                        && Self::connected_humans(r)
                }) {
                    return Ok(());
                }
            }
            let outcome = match decision {
                Ok(decision) => match decision.action.clone() {
                    BotAction::Quote(name) => {
                        let work = self.update_room(code, |room| {
                            if room.game.room_session_id() != session
                                || !Self::bot_current(room, player, round)
                                || !Self::connected_humans(room)
                            {
                                return Ok(None);
                            }
                            self.begin_quote(room, player, &name).map(Some)
                        })?;
                        let Some(work) = work else {
                            return Ok(());
                        };
                        match self.finish_quote(code, work).await {
                            Ok(quote) => {
                                let state = self.0.state.lock().unwrap();
                                if !state.rooms.get(code).is_some_and(|r| {
                                    r.game.room_session_id() == session
                                        && Self::bot_current(r, player, round)
                                }) {
                                    return Ok(());
                                }
                                self.0.bots.accept(decision, &quote);
                                Ok(false)
                            }
                            Err(error) => Err(error),
                        }
                    }
                    BotAction::Select(quote) => self.update_room(code, |room| {
                        if room.game.room_session_id() != session
                            || !Self::bot_current(room, player, round)
                            || !Self::connected_humans(room)
                        {
                            return Ok(true);
                        }
                        room.game.commit(player, &quote.id)?;
                        self.0.bots.accept(decision, &quote);
                        Ok(true)
                    }),
                },
                Err(error) => Err(error),
            };
            match outcome {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) if self.0.bots.retry(&session, player, round, &error) => {}
                Err(error) => return Err(error),
            }
        }
    }
    /// Stop periodic sweeps without changing room state, e.g. before shutdown.
    pub fn stop_maintenance(&self) {
        self.0.stop.cancel();
    }
    pub fn close(&self) {
        self.stop_maintenance();
        {
            let mut state = self.0.state.lock().unwrap();
            state.closing = true;
            let rooms: Vec<_> = state.rooms.keys().cloned().collect();
            for code in rooms {
                self.destroy(&mut state, &code)
            }
            for (_, connection) in state.connections.drain() {
                let _ = connection
                    .sender
                    .send(Outbound::Close(1001, "服务器停止".into()));
            }
        }
        self.0.tasks.close();
    }

    pub async fn shutdown(&self) {
        self.close();
        self.0.tasks.wait().await;
        self.0.alchemy.flush_logs().await;
    }
}
