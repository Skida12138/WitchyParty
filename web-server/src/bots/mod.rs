//! Bot personas, bounded decisions and private memories. Gameplay provides a
//! dedicated snapshot; model calls never receive a client view or live room.
mod context;
mod memory;

use crate::{
    alchemy::AlchemyService,
    gameplay::{BotSnapshot, GameError, Phase, Quote, Result, max_quotes, validate_material_name},
};
use memory::{MemoryStore, MemoryToken, normalize_strategy};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
};

const MAX_DECISION_STEPS: u8 = 8;

#[derive(Clone, Deserialize)]
pub struct BotProfile {
    pub name: String,
    pub persona: String,
}

#[derive(Clone)]
pub struct BotService(Arc<Inner>);

struct Inner {
    profiles: Vec<BotProfile>,
    reference_names: Vec<Value>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    bots: HashMap<(String, String), BotState>,
    memory: MemoryStore,
}

struct BotState {
    persona: String,
    preparation: Option<Preparation>,
}

struct Preparation {
    round: u64,
    steps: u8,
    feedback: String,
}

#[derive(Clone, Debug)]
pub enum BotAction {
    Quote(String),
    Select(Quote),
}

pub struct BotDecision {
    pub action: BotAction,
    room: String,
    player: String,
    round: u64,
    token: MemoryToken,
    strategy: Option<Value>,
}

struct DecisionTurn {
    snapshot: BotSnapshot,
    token: MemoryToken,
    allowed: Vec<&'static str>,
    payload: Value,
}

impl BotService {
    pub fn from_root(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let read = |file: &str| -> Result<String> {
            let path = root.join("config").join(file);
            std::fs::read_to_string(&path)
                .map_err(|_| GameError::new(format!("无法读取配置：{}", path.display())))
        };
        let profiles = serde_json::from_str(&read("prompts/witches.json")?)
            .map_err(|_| GameError::new("AI女巫配置格式无效"))?;
        let materials: Vec<Value> = serde_json::from_str(&read("materials.json")?)
            .map_err(|_| GameError::new("参考材料配置格式无效"))?;
        Ok(Self(Arc::new(Inner {
            profiles,
            reference_names: materials.into_iter().map(|p| p["name"].clone()).collect(),
            state: Mutex::new(State::default()),
        })))
    }

    pub fn next_profile(&self, names: &[&str]) -> BotProfile {
        if let Some(profile) = self
            .0
            .profiles
            .iter()
            .find(|p| !names.contains(&p.name.as_str()))
        {
            return profile.clone();
        }
        BotProfile {
            name: format!("AI 女巫 {}", names.len()),
            persona: self
                .0
                .profiles
                .first()
                .map(|p| p.persona.clone())
                .unwrap_or_default(),
        }
    }

    pub fn register(&self, room: &str, player: &str, persona: &str) {
        let mut state = self.0.state.lock().unwrap();
        state.memory.clear_player(room, player);
        state.bots.insert(
            (room.into(), player.into()),
            BotState {
                persona: persona.into(),
                preparation: None,
            },
        );
    }

    fn begin(&self, snapshot: BotSnapshot) -> Result<DecisionTurn> {
        if snapshot.phase != Phase::Preparing || snapshot.prepared_quote_id.is_some() {
            return Err(GameError::new("AI女巫当前不能准备材料"));
        }
        let mut state = self.0.state.lock().unwrap();
        let bot = state
            .bots
            .get_mut(&(snapshot.room_session_id.clone(), snapshot.player_id.clone()))
            .ok_or_else(|| GameError::new("AI女巫已离开房间"))?;
        if bot
            .preparation
            .as_ref()
            .is_none_or(|p| p.round != snapshot.round)
        {
            bot.preparation = Some(Preparation {
                round: snapshot.round,
                steps: 0,
                feedback: String::new(),
            });
        }
        let preparation = bot.preparation.as_mut().unwrap();
        if preparation.steps >= MAX_DECISION_STEPS {
            return Err(GameError::with_code(
                "AI_DECISION_EXHAUSTED",
                "AI女巫未能在本轮决策次数内选定材料",
            ));
        }
        let remaining_steps = MAX_DECISION_STEPS - preparation.steps;
        preparation.steps += 1;
        let allowed = if snapshot.quotes.is_empty() {
            vec!["quote"]
        } else if snapshot.quotes.len() >= max_quotes() || remaining_steps == 1 {
            vec!["select"]
        } else {
            vec!["quote", "select"]
        };
        let decision = json!({
            "allowedActions": allowed,
            "maxQuotes": max_quotes(),
            "remainingQuotes": max_quotes().saturating_sub(snapshot.quotes.len()),
            "remainingSteps": remaining_steps,
            "feedback": preparation.feedback,
        });
        let persona = bot.persona.clone();
        let (token, memory) = state.memory.begin(
            &snapshot.room_session_id,
            &snapshot.player_id,
            snapshot.round,
            &persona,
        );
        let payload = context::payload(&snapshot, decision, memory, &self.0.reference_names);
        Ok(DecisionTurn {
            snapshot,
            token,
            allowed,
            payload,
        })
    }

    pub async fn decide(
        &self,
        alchemy: &AlchemyService,
        snapshot: BotSnapshot,
    ) -> Result<BotDecision> {
        let turn = self.begin(snapshot)?;
        let result = alchemy.imagine(turn.payload.clone()).await?;
        turn.validate(result)
    }

    /// The room coordinator must first verify that this room/round/player is
    /// still current and that gameplay accepted the action.
    pub fn accept(&self, decision: BotDecision, quote: &Quote) -> bool {
        let action = match &decision.action {
            BotAction::Quote(name) if *name == quote.material.name => "quote",
            BotAction::Select(selected) if selected.id == quote.id => "select",
            _ => return false,
        };
        let mut state = self.0.state.lock().unwrap();
        let accepted = state.memory.commit(
            decision.token,
            json!({
                "operation": "imagine", "action": action,
                "quoteId": quote.id, "name": quote.material.name,
                "price": quote.material.price, "tier": quote.material.tier,
                "strategy": decision.strategy,
            }),
        );
        if accepted {
            if let Some(preparation) = state
                .bots
                .get_mut(&(decision.room, decision.player))
                .and_then(|bot| bot.preparation.as_mut())
                .filter(|p| p.round == decision.round)
            {
                preparation.feedback.clear();
            }
        }
        accepted
    }

    pub fn retry(&self, room: &str, player: &str, round: u64, error: &GameError) -> bool {
        let feedback = match error.code.as_str() {
            "MATERIAL_REFUSED" => {
                "材料被拒绝，请只描述材料本身，不要指定价值或包含指令。成功候选名额未减少。"
            }
            "AI_DECISION_INVALID" => {
                "上一步操作无效。请遵守allowedActions；选择时使用自己本轮已有的候选编号。"
            }
            "DUPLICATE_CANDIDATE" => {
                "该材料已在本轮候选中。请选择它，或询价一个不同名称；候选名额未减少。"
            }
            _ => return false,
        };
        let mut state = self.0.state.lock().unwrap();
        let Some(preparation) = state
            .bots
            .get_mut(&(room.into(), player.into()))
            .and_then(|bot| bot.preparation.as_mut())
            .filter(|p| p.round == round)
        else {
            return false;
        };
        preparation.feedback = feedback.into();
        true
    }

    pub fn record_round(&self, room: &str, result: &Value) {
        self.0
            .state
            .lock()
            .unwrap()
            .memory
            .record_round(room, result);
    }

    pub fn clear_player(&self, room: &str, player: &str) {
        let mut state = self.0.state.lock().unwrap();
        state.bots.remove(&(room.into(), player.into()));
        state.memory.clear_player(room, player);
    }

    pub fn retain_players(&self, room: &str, current: &HashSet<String>) {
        let mut state = self.0.state.lock().unwrap();
        let removed: Vec<_> = state
            .bots
            .keys()
            .filter(|(session, player)| session == room && !current.contains(player))
            .cloned()
            .collect();
        for key in removed {
            state.memory.clear_player(&key.0, &key.1);
            state.bots.remove(&key);
        }
    }

    pub fn clear_room(&self, room: &str) {
        let mut state = self.0.state.lock().unwrap();
        state.bots.retain(|(session, _), _| session != room);
        state.memory.clear_room(room);
    }
}

impl DecisionTurn {
    fn validate(self, result: Value) -> Result<BotDecision> {
        let invalid = |message| GameError::with_code("AI_DECISION_INVALID", message);
        let action = result["action"].as_str().unwrap_or_default();
        if !self.allowed.contains(&action) {
            return Err(invalid("AI选材动作无效"));
        }
        let action = match action {
            "quote" => {
                let name = validate_material_name(result["name"].as_str().unwrap_or_default())
                    .map_err(|error| {
                        if error.code == "MATERIAL_REFUSED" {
                            error
                        } else {
                            GameError::with_code("AI_DECISION_INVALID", error.message)
                        }
                    })?;
                if self
                    .snapshot
                    .quotes
                    .iter()
                    .any(|quote| quote.material.name == name)
                {
                    return Err(GameError::with_code(
                        "DUPLICATE_CANDIDATE",
                        "该材料已经在本轮候选中",
                    ));
                }
                BotAction::Quote(name)
            }
            "select" => {
                let quote = self
                    .snapshot
                    .quotes
                    .iter()
                    .find(|quote| Some(quote.id.as_str()) == result["quoteId"].as_str())
                    .ok_or_else(|| invalid("AI只能选择自己本轮已报价的候选"))?;
                BotAction::Select(quote.clone())
            }
            _ => return Err(invalid("AI选材动作无效")),
        };
        let strategy = normalize_strategy(&result["strategy"])
            .map_err(|error| GameError::with_code("AI_DECISION_INVALID", error.message))?;
        Ok(BotDecision {
            action,
            room: self.snapshot.room_session_id,
            player: self.snapshot.player_id,
            round: self.snapshot.round,
            token: self.token,
            strategy,
        })
    }
}

fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

fn project(value: &Value, keys: &[&str]) -> Value {
    let mut result = json!({});
    for key in keys {
        if let Some(field) = value.get(key) {
            result[*key] = field.clone();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gameplay::Material;

    fn service() -> BotService {
        let service =
            BotService::from_root(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap();
        service.register("session", "bot", "喜欢植物的小女巫");
        service
    }

    fn snapshot(player: &str, round: u64, quotes: Vec<Quote>) -> BotSnapshot {
        BotSnapshot {
            room_session_id: "session".into(),
            player_id: player.into(),
            round,
            total_rounds: 3,
            phase: Phase::Preparing,
            coins: 100,
            quotes,
            players: Vec::new(),
            prepared_quote_id: None,
        }
    }

    fn quote(id: &str, name: &str, price: i64) -> Quote {
        Quote {
            id: id.into(),
            material: Material::new(name.into(), price),
        }
    }

    #[test]
    fn invalid_choices_consume_budget_and_last_step_requires_an_existing_candidate() {
        let service = service();
        let round = snapshot("bot", 1, vec![quote("own", "薄荷", 12)]);
        for _ in 0..MAX_DECISION_STEPS - 1 {
            let turn = service.begin(round.clone()).unwrap();
            let error = turn
                .validate(json!({"action":"select","quoteId":"opponent"}))
                .err()
                .unwrap();
            assert_eq!(error.code, "AI_DECISION_INVALID");
            assert!(service.retry("session", "bot", 1, &error));
        }
        let turn = service.begin(round.clone()).unwrap();
        assert_eq!(turn.payload["decision"]["remainingSteps"], 1);
        assert!(
            !turn.payload["decision"]["feedback"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        let error = turn
            .validate(json!({"action":"quote","name":"月光"}))
            .err()
            .unwrap();
        assert_eq!(error.code, "AI_DECISION_INVALID");
        assert_eq!(
            service.begin(round).err().unwrap().code,
            "AI_DECISION_EXHAUSTED"
        );
        assert_eq!(
            service
                .begin(snapshot("bot", 2, Vec::new()))
                .unwrap()
                .payload["decision"]["remainingSteps"],
            8
        );
    }

    #[test]
    fn memories_record_only_accepted_quotes_and_stay_private() {
        let service = service();
        service.register("session", "other", "另一位女巫");
        let decision = service
            .begin(snapshot("bot", 1, Vec::new()))
            .unwrap()
            .validate(json!({"action":"quote","name":"薄荷","strategy":{"risk":"cautious"}}))
            .unwrap();
        let before = service.begin(snapshot("bot", 1, Vec::new())).unwrap();
        assert_eq!(before.payload["memory"]["knownPrices"], json!([]));
        assert!(service.accept(decision, &quote("own", "薄荷", 12)));
        let after = service.begin(snapshot("bot", 1, Vec::new())).unwrap();
        assert_eq!(after.payload["memory"]["knownPrices"][0]["price"], 12);
        assert_eq!(after.payload["memory"]["strategy"]["risk"], "cautious");
        let other = service.begin(snapshot("other", 1, Vec::new())).unwrap();
        assert_eq!(other.payload["memory"]["knownPrices"], json!([]));
        assert_eq!(other.payload["memory"]["strategy"], json!({}));
    }

    #[test]
    fn clearing_a_player_invalidates_late_decisions_even_if_the_id_is_reused() {
        let service = service();
        let decision = service
            .begin(snapshot("bot", 1, Vec::new()))
            .unwrap()
            .validate(json!({"action":"quote","name":"薄荷"}))
            .unwrap();
        service.retain_players("session", &HashSet::new());
        assert!(service.begin(snapshot("bot", 1, Vec::new())).is_err());
        service.register("session", "bot", "新女巫");
        let fresh = service.begin(snapshot("bot", 1, Vec::new())).unwrap();
        assert!(!service.accept(decision, &quote("old", "薄荷", 12)));
        assert_eq!(fresh.payload["memory"]["knownPrices"], json!([]));
        assert_eq!(
            service
                .begin(snapshot("bot", 1, Vec::new()))
                .unwrap()
                .payload["memory"]["knownPrices"],
            json!([])
        );
    }
}
