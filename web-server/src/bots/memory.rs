//! Private, bounded memories. Tokens are consumed on commit and validate the
//! generation/revision so a late response cannot revive removed players.
use super::{array, project};
use crate::gameplay::GameError;
use serde_json::{Value, json};
use std::collections::HashMap;

fn text(value: &Value, limit: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(limit)
        .collect()
}
pub fn normalize_strategy(value: &Value) -> Result<Option<Value>, GameError> {
    if value.is_null() {
        return Ok(None);
    }
    let invalid = || GameError::new("AI返回了无效的策略记录");
    if !value.is_object() {
        return Err(invalid());
    }
    let mut result = json!({});
    for key in ["goal", "budgetPlan"] {
        if let Some(v) = value.get(key) {
            if v.as_str().is_none_or(|s| s.chars().count() > 200) {
                return Err(invalid());
            }
            result[key] = json!(text(v, 200));
        }
    }
    if let Some(risk) = value.get("risk") {
        if !matches!(risk.as_str(), Some("cautious" | "balanced" | "bold")) {
            return Err(invalid());
        }
        result["risk"] = risk.clone();
    }
    if let Some(notes) = value.get("notes") {
        let notes = notes
            .as_array()
            .filter(|v| v.len() <= 4)
            .ok_or_else(invalid)?;
        if notes
            .iter()
            .any(|v| v.as_str().is_none_or(|s| s.chars().count() > 200))
        {
            return Err(invalid());
        }
        result["notes"] = json!(notes.iter().map(|v| text(v, 200)).collect::<Vec<_>>());
    }
    Ok(Some(result))
}
pub fn public_round_summary(result: &Value) -> Option<Value> {
    if result["round"].as_u64().unwrap_or(0) == 0 {
        return None;
    }
    Some(
        json!({"round":result["round"],"winnerId":result["winnerId"],"potValue":result["potValue"],
            "contributions":array(&result["contributions"]).iter().take(8).map(|v|project(v,&["ownerId","name","price","tier","order"])).collect::<Vec<_>>(),
            "products":array(&result["products"]).iter().take(256).map(|v|project(v,&["name","price","tier"])).collect::<Vec<_>>(),
            "players":array(&result["players"]).iter().take(8).map(|v|project(v,&["id","name","before","cost","winnings","rawBalance","balance","delta","eliminated"])).collect::<Vec<_>>()
        }),
    )
}
fn price_ledger(values: Vec<Value>) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    for entry in values {
        if !matches!(
            entry["source"].as_str(),
            Some("own-quote" | "public-contribution" | "public-product")
        ) || entry["round"].as_u64().unwrap_or(0) == 0
        {
            continue;
        }
        let Some(price) = entry["price"]
            .as_i64()
            .filter(|v| (0..=1_000_000_000).contains(v))
        else {
            continue;
        };
        let Ok(name) = crate::gameplay::normalize_name(entry["name"].as_str().unwrap_or_default())
        else {
            continue;
        };
        let value = json!({"name":name,"price":price,"tier":entry["tier"],"round":entry["round"],"source":entry["source"]});
        if let Some(old) = entries.iter_mut().find(|v| {
            v["round"] == value["round"]
                && v["source"] == value["source"]
                && v["name"] == value["name"]
        }) {
            *old = value;
        } else {
            entries.push(value);
        }
    }
    entries.sort_by_key(|v| v["round"].as_u64());
    if entries.len() > 256 {
        entries.drain(..entries.len() - 256);
    }
    entries
}
pub fn private_memory_context(value: &Value) -> Value {
    let turns: Vec<_> = array(&value["recentTurns"])
        .into_iter()
        .filter(|v| v["operation"] == "imagine")
        .map(|v| {
            project(
                &v,
                &[
                    "operation",
                    "round",
                    "action",
                    "quoteId",
                    "name",
                    "price",
                    "tier",
                ],
            )
        })
        .collect();
    json!({"persona":text(&value["persona"],600),"strategy":normalize_strategy(&value["strategy"]).ok().flatten().unwrap_or(json!({})),
        "summary":text(&value["summary"],1800),
        "recentTurns":turns.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
        "roundSummaries":array(&value["roundSummaries"]).iter().rev().take(10).collect::<Vec<_>>().into_iter().rev().filter_map(|v|public_round_summary(v)).collect::<Vec<_>>(),
        "knownPrices":price_ledger(array(&value["knownPrices"]))})
}

#[derive(Default)]
pub struct MemoryStore {
    rooms: HashMap<String, HashMap<String, Entry>>,
}
struct Entry {
    generation: uuid::Uuid,
    revision: u64,
    value: Value,
}
// Deliberately not Clone: ownership makes a token usable only once.
pub struct MemoryToken {
    room: String,
    player: String,
    round: u64,
    generation: uuid::Uuid,
    revision: u64,
}

impl MemoryStore {
    pub fn begin(
        &mut self,
        room: &str,
        player: &str,
        round: u64,
        persona: &str,
    ) -> (MemoryToken, Value) {
        let entry = self
            .rooms
            .entry(room.into())
            .or_default()
            .entry(player.into())
            .or_insert_with(|| Entry {
                generation: uuid::Uuid::new_v4(),
                revision: 0,
                value: private_memory_context(&json!({"persona":persona})),
            });
        (
            MemoryToken {
                room: room.into(),
                player: player.into(),
                round,
                generation: entry.generation,
                revision: entry.revision,
            },
            entry.value.clone(),
        )
    }
    /// Caller must verify the current room/round/player before committing.
    pub fn commit(&mut self, token: MemoryToken, result: Value) -> bool {
        let Some(entry) = self
            .rooms
            .get_mut(&token.room)
            .and_then(|r| r.get_mut(&token.player))
        else {
            return false;
        };
        if entry.generation != token.generation || entry.revision != token.revision {
            return false;
        }
        if result["operation"] != "imagine"
            || !matches!(result["action"].as_str(), Some("quote" | "select"))
            || result["quoteId"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 100)
            || result["name"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 80)
            || result["price"]
                .as_i64()
                .is_none_or(|p| !(0..=1_000_000_000).contains(&p))
        {
            return false;
        }
        let Ok(strategy) = normalize_strategy(&result["strategy"]) else {
            return false;
        };
        if let Some(strategy) = strategy {
            for (key, value) in strategy.as_object().unwrap() {
                entry.value["strategy"][key] = value.clone();
            }
        }
        let mut turn = project(
            &result,
            &["operation", "action", "quoteId", "name", "price", "tier"],
        );
        turn["round"] = json!(token.round);
        if turn["action"] == "quote" {
            let mut price = turn.clone();
            price["source"] = json!("own-quote");
            let mut prices = array(&entry.value["knownPrices"]);
            prices.push(price);
            entry.value["knownPrices"] = json!(price_ledger(prices));
        }
        let mut turns = array(&entry.value["recentTurns"]);
        turns.push(turn);
        if turns.len() > 12 {
            turns.drain(..turns.len() - 12);
        }
        entry.value["recentTurns"] = json!(turns);
        entry.revision += 1;
        true
    }
    pub fn record_round(&mut self, room: &str, result: &Value) {
        let Some(summary) = public_round_summary(result) else {
            return;
        };
        let Some(room) = self.rooms.get_mut(room) else {
            return;
        };
        for entry in room.values_mut() {
            let mut summaries = array(&entry.value["roundSummaries"]);
            if summaries.iter().any(|s| s["round"] == summary["round"]) {
                continue;
            }
            summaries.push(summary.clone());
            summaries.sort_by_key(|s| s["round"].as_u64());
            if summaries.len() > 10 {
                summaries.drain(..summaries.len() - 10);
            }
            let mut prices = array(&entry.value["knownPrices"]);
            for (key, source) in [
                ("contributions", "public-contribution"),
                ("products", "public-product"),
            ] {
                for mut material in array(&summary[key]) {
                    material["round"] = summary["round"].clone();
                    material["source"] = json!(source);
                    prices.push(material);
                }
            }
            entry.value["knownPrices"] = json!(price_ledger(prices));
            let summary_text = summaries
                .iter()
                .map(|s| {
                    format!(
                        "第{}轮：奖励{}金币，获得者{}；{}",
                        s["round"],
                        s["potValue"],
                        s["winnerId"].as_str().unwrap_or("无"),
                        array(&s["players"])
                            .iter()
                            .map(|p| format!(
                                "{}结余{}{}",
                                p["name"].as_str().unwrap_or_default(),
                                p["balance"],
                                if p["eliminated"] == true {
                                    "（失败旁观）"
                                } else {
                                    ""
                                }
                            ))
                            .collect::<Vec<_>>()
                            .join("，")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            entry.value["summary"] = json!(
                summary_text
                    .chars()
                    .rev()
                    .take(1800)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<String>()
            );
            entry.value["roundSummaries"] = json!(summaries);
            entry.revision += 1;
        }
    }
    pub fn clear_player(&mut self, room: &str, player: &str) {
        if let Some(players) = self.rooms.get_mut(room) {
            players.remove(player);
            if players.is_empty() {
                self.rooms.remove(room);
            }
        }
    }
    pub fn clear_room(&mut self, room: &str) {
        self.rooms.remove(room);
    }
}
