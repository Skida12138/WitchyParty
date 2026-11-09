use crate::gameplay::{BotSnapshot, max_quotes, starting_coins};
use serde_json::{Value, json};

pub(super) fn payload(
    snapshot: &BotSnapshot,
    decision: Value,
    memory: Value,
    reference_names: &[Value],
) -> Value {
    let quotes: Vec<_> = snapshot
        .quotes
        .iter()
        .map(|quote| {
            json!({
                "id": quote.id,
                "name": quote.material.name,
                "price": quote.material.price,
                "tier": quote.material.tier,
            })
        })
        .collect();
    json!({
        "decision": decision,
        "game": {
            "round": snapshot.round,
            "totalRounds": snapshot.total_rounds,
            "phase": snapshot.phase,
            "rules": {
                "startingCoins": starting_coins(), "maxQuotes": max_quotes(),
                "allowOverdraft": true, "carryCoinsBetweenRounds": true, "scoreEqualsCoins": true,
                "eliminationAfterSettlement": "coins<=0", "reward": "highest-original-contribution",
            },
            "me": {
                "id": snapshot.player_id,
                "coins": snapshot.coins,
                "quotes": quotes,
                "preparedQuoteId": snapshot.prepared_quote_id,
            },
            "players": snapshot.players,
            "contributions": [], "pot": [], "completedRounds": [],
        },
        "memory": memory,
        "referenceNames": reference_names,
    })
}
