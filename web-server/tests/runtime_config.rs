use serde_json::{Value, json};
use witchy_web_server::gameplay::*;

#[test]
fn runtime_files_control_materials_balances_limits_tiers_and_timing() {
    let root =
        std::env::temp_dir().join(format!("witchy-gameplay-config-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(root.join("config/rules.json"), "{}").unwrap();
    std::fs::write(root.join("config/materials.json"), "[]").unwrap();
    assert!(initialize_config(&root).is_err());
    let mut config: Value = serde_json::from_str(include_str!("../../config/rules.json")).unwrap();
    config["startingCoins"] = json!(50000);
    config["maxQuotes"] = json!(4);
    config["allowedRounds"] = json!([2, 4]);
    config["depositMs"] = json!(777);
    config["tierMinimums"]["red"] = json!(20000);
    std::fs::write(root.join("config/rules.json"), config.to_string()).unwrap();
    std::fs::write(
        root.join("config/materials.json"),
        json!([{"name":"新月花","price":123}]).to_string(),
    )
    .unwrap();
    initialize_config(&root).unwrap();
    initialize_config(&root).unwrap();
    let error = GameRoom::new("CONFIG".into(), 3, true, Timing::default()).unwrap_err();
    assert_eq!(error.message, "比赛轮数只能是 2、4 轮");
    let mut game = GameRoom::new("CONFIG".into(), 2, true, Timing::default()).unwrap();
    let a = game.add_player("甲", false).unwrap();
    game.add_player("乙", false).unwrap();
    game.start(&a).unwrap();
    let ticket = game.begin_quote(&a, "新月花").unwrap();
    assert_eq!(ticket.cached.as_ref().unwrap().price, 123);
    game.finish_quote(&ticket, Ok(json!(ticket.cached.as_ref().unwrap())))
        .unwrap();
    let view = game.view(&a).unwrap();
    assert_eq!(view["me"]["coins"], 50000);
    assert_eq!(view["me"]["quotesRemaining"], 3);
    assert_eq!(view["rules"]["depositMs"], 777);
    assert_eq!(tier_for(15000), "gold");
    std::fs::remove_dir_all(root).unwrap();
}
