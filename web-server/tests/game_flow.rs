use async_trait::async_trait;
use serde_json::{Value, json};
use witchy_web_server::gameplay::*;
struct NoModel;
#[async_trait]
impl Alchemy for NoModel {
    async fn price(&self, _: &str, _: Value) -> Result<Value> {
        panic!("cached materials must not call a model")
    }
    async fn synthesize(&self, _: Value, _: Value, _: Value) -> Result<Value> {
        panic!("red materials must not react")
    }
}
fn room() -> (GameRoom, String, String) {
    let mut game = GameRoom::new(
        "TEST".into(),
        3,
        true,
        Timing {
            deposit_ms: 10,
            reaction_ms: 20,
            hold_ms: 30,
            chain_hold_ms: 10,
        },
    )
    .unwrap();
    let host = game.add_player("甲", false).unwrap();
    let guest = game.add_player("乙", false).unwrap();
    game.start(&host).unwrap();
    (game, host, guest)
}
fn quote(game: &mut GameRoom, id: &str, name: &str) -> Quote {
    let ticket = game.begin_quote(id, name).unwrap();
    assert!(!game.can_prepare(id));
    let cached = ticket.cached.clone().unwrap();
    game.finish_quote(&ticket, Ok(json!(cached))).unwrap()
}
#[tokio::test]
async fn prepared_materials_charge_once_then_play_and_settle_with_refresh_snapshot() {
    let (mut game, a, b) = room();
    assert!(game.can_prepare(&a));
    game.set_connected(&a, false).unwrap();
    assert!(!game.can_prepare(&a));
    game.set_connected(&a, true).unwrap();
    let first = quote(&mut game, &a, "一颗迷路的星星");
    assert!(game.can_prepare(&a));
    assert!(
        !game
            .view(&b)
            .unwrap()
            .to_string()
            .contains("一颗迷路的星星")
    );
    game.commit(&a, &first.id).unwrap();
    assert!(!game.can_prepare(&a));
    assert_eq!(game.player(&a).unwrap().coins, 20000);
    game.unready(&a).unwrap();
    assert!(game.can_prepare(&a));
    game.commit(&a, &first.id).unwrap();
    let second = quote(&mut game, &b, "世界树的第一片叶子");
    game.commit(&b, &second.id).unwrap();
    assert_eq!(game.phase(), Phase::Resolving);
    assert_eq!(game.player(&a).unwrap().coins, 8000);
    assert_eq!(game.player(&b).unwrap().coins, 2000);
    let mut work = game.take_resolution().unwrap();
    assert!(game.take_resolution().is_none());
    work.run(&NoModel).await.unwrap();
    game.apply_resolution(work, Ok(()));
    assert_eq!(game.phase(), Phase::Performing);
    assert!(game.next_round(&a).is_err());
    let snapshot = game.view(&a).unwrap();
    game.set_connected(&a, false).unwrap();
    game.set_connected(&a, true).unwrap();
    assert_eq!(
        snapshot["presentation"],
        game.view(&a).unwrap()["presentation"]
    );
    let end = game.next_deadline().unwrap();
    assert!(!game.advance_performance(end - 1));
    assert!(game.round_result().is_none());
    assert!(game.advance_performance(end));
    assert!(game.round_result().is_none());
    let end = game.next_deadline().unwrap();
    game.advance_performance(end);
    assert_eq!(game.phase(), Phase::RoundEnd);
    let result = game.round_result().unwrap();
    assert_eq!(result["winnerId"], b);
    assert_eq!(result["potValue"], 30000);
    assert_eq!(game.player(&b).unwrap().coins, 32000);
    assert_eq!(result["winnerCelebration"]["material"]["price"], 18000);
    game.next_round(&a).unwrap();
    assert_eq!(game.round(), 2);
    assert_eq!(game.player(&a).unwrap().coins, 8000);
    assert!(
        game.view(&a).unwrap()["contributions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn failed_and_departed_quotes_never_charge_or_consume_candidates() {
    let (mut game, a, b) = room();
    let request = game.begin_quote(&a, "雨后玻璃花").unwrap();
    assert!(game.begin_quote(&a, "月光蘑菇").is_err());
    assert!(
        game.finish_quote(&request, Err(GameError::new("failure")))
            .is_err()
    );
    assert!(!game.player(&a).unwrap().quote_busy);
    assert_eq!(game.player(&a).unwrap().coins, 20000);
    assert_eq!(game.player(&a).unwrap().quotes.len(), 0);
    let request = game.begin_quote(&a, "雨后玻璃花").unwrap();
    game.mark_departing(&a, "leave");
    assert!(
        game.finish_quote(&request, Ok(json!({"price":100})))
            .is_err()
    );
    assert_eq!(game.phase(), Phase::Finished);
    assert_eq!(game.round_result().unwrap()["winnerId"], b);
}
#[tokio::test]
async fn departed_paid_contributor_still_wins_and_is_removed_only_after_playback() {
    let (mut game, a, b) = room();
    for (id, name) in [(&a, "一颗迷路的星星"), (&b, "世界树的第一片叶子")] {
        let q = quote(&mut game, id, name);
        game.commit(id, &q.id).unwrap();
    }
    let mut work = game.take_resolution().unwrap();
    game.mark_departing(&b, "leave");
    work.run(&NoModel).await.unwrap();
    game.apply_resolution(work, Ok(()));
    assert!(game.player(&b).unwrap().departure_pending);
    while let Some(end) = game.next_deadline() {
        game.advance_performance(end);
    }
    assert!(game.player(&b).is_err());
    assert_eq!(game.round_result().unwrap()["winnerId"], b);
    assert_eq!(game.view(&a).unwrap()["matchWinnerId"], a);
}
#[test]
fn duplicate_quote_completion_and_disposed_work_are_rejected() {
    let (mut game, a, _) = room();
    let ticket = game.begin_quote(&a, "晨露").unwrap();
    game.finish_quote(&ticket, Ok(json!({"price":5}))).unwrap();
    assert!(game.finish_quote(&ticket, Ok(json!({"price":5}))).is_err());
    assert_eq!(game.player(&a).unwrap().quotes.len(), 1);
    game.dispose();
    assert!(game.begin_quote(&a, "晨露").is_err());
    assert!(game.take_resolution().is_none());
}
#[test]
fn names_probabilities_and_pricing_match_the_javascript_rules() {
    assert_eq!(normalize_name(" ＡＢＣ \n 星云 ").unwrap(), "ABC 星云");
    assert_eq!(
        validate_material_name("价值９９９金币的石头")
            .unwrap_err()
            .code,
        "MATERIAL_REFUSED"
    );
    assert_eq!(
        material_vector("月光蘑菇", "fixed-seed"),
        [
            0.539787899595636,
            0.7614099336232547,
            0.8403295948729685,
            -0.7601586938277256
        ]
    );
    assert_eq!(
        reaction_probability("月光蘑菇", "月光蘑菇", "fixed-seed"),
        0.0
    );
    assert_eq!(
        [9, 10, 49, 50, 199, 200, 1999, 2000, 9999, 10000].map(tier_for),
        [
            "white", "green", "green", "blue", "blue", "purple", "purple", "gold", "gold", "red"
        ]
    );
    let a = Material::new("a".into(), 5);
    let b = Material::new("b".into(), 25);
    assert_eq!(
        json!(synthesis_price_policy(&a, &b, 0.01).price_constraint),
        json!({"band":"below","minPrice":0,"maxPrice":4})
    );
    assert_eq!(
        json!(synthesis_price_policy(&a, &b, 0.5).price_constraint),
        json!({"band":"between","minPrice":5,"maxPrice":25})
    );
    assert_eq!(
        json!(synthesis_price_policy(&a, &b, 0.99).price_constraint),
        json!({"band":"above","minPrice":26,"maxPrice":1000000000})
    );
}

#[tokio::test]
async fn scripted_draws_preserve_js_shuffle_tie_break_and_cross_round_order() {
    let mut game = GameRoom::new("SCRIPT".into(), 3, true, Timing::default()).unwrap();
    let source = RandomSource::scripted(vec![1.0, 1.0, 0.99, 0.0, 0.0]);
    game.set_random_source(source);
    let ids = (0..3)
        .map(|i| game.add_player(&format!("女巫{i}"), false).unwrap())
        .collect::<Vec<_>>();
    game.start(&ids[0]).unwrap();
    assert_eq!(game.view(&ids[0]).unwrap()["turnOrder"], json!(ids));
    for id in &ids {
        let q = quote(&mut game, id, "一颗迷路的星星");
        game.commit(id, &q.id).unwrap();
    }
    let mut work = game.take_resolution().unwrap();
    work.run(&NoModel).await.unwrap();
    game.apply_resolution(work, Ok(()));
    while let Some(end) = game.next_deadline() {
        game.advance_performance(end);
    }
    assert_eq!(game.round_result().unwrap()["winnerId"], ids[2]);
    game.next_round(&ids[0]).unwrap();
    assert_eq!(
        game.view(&ids[0]).unwrap()["turnOrder"],
        json!([ids[1], ids[2], ids[0]])
    );
}
