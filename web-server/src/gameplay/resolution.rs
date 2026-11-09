use super::{
    Contribution, GameError, Material, PotMaterial, PriceConstraint, PricePolicy, RandomSource,
    Result, Timing, material_refusal, reaction_probability, red_minimum, synthesis_price_policy,
    uid, validate_material_name, validate_price,
};
use async_trait::async_trait;
use rand::Rng;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[async_trait]
pub trait Alchemy: Send + Sync {
    async fn price(&self, name: &str, context: Value) -> Result<Value>;
    async fn synthesize(&self, a: Value, b: Value, context: Value) -> Result<Value>;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recipe {
    ingredients: [String; 2],
    name: String,
    price_constraint: PriceConstraint,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum FrameAction {
    Deposit {
        material: PotMaterial,
    },
    Reaction {
        ingredients: [PotMaterial; 2],
        product: PotMaterial,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    id: String,
    pub player_id: String,
    player_name: String,
    pub animation_ms: u64,
    hold_ms: u64,
    pub duration_ms: u64,
    pub pot_before: Vec<PotMaterial>,
    pub pot_after: Vec<PotMaterial>,
    #[serde(flatten)]
    action: FrameAction,
}

#[derive(Clone, Debug)]
struct Pending {
    pot: Vec<PotMaterial>,
    prices: BTreeMap<String, Material>,
    recipes: BTreeMap<String, Recipe>,
    rolls: Vec<f64>,
    policies: Vec<PricePolicy>,
    product_ids: Vec<String>,
    frame_ids: Vec<String>,
}

/// An owned, resumable computation. Network awaits never hold a room mutex.
#[derive(Clone, Debug)]
pub struct Resolution {
    pub round: u64,
    pub room_session_id: String,
    pub completed: usize,
    pub(crate) contributions: Vec<Contribution>,
    pub(crate) frames: Vec<Frame>,
    pub(crate) products: Vec<Material>,
    pub(crate) pot: Vec<PotMaterial>,
    pub(crate) prices: BTreeMap<String, Material>,
    recipes: BTreeMap<String, Recipe>,
    seed: String,
    timing: Timing,
    random: RandomSource,
    pending: Option<Pending>,
}
impl Resolution {
    pub(crate) fn new(
        round: u64,
        room_session_id: String,
        contributions: Vec<Contribution>,
        prices: BTreeMap<String, Material>,
        seed: String,
        timing: Timing,
        random: RandomSource,
    ) -> Self {
        Self {
            round,
            room_session_id,
            contributions,
            prices,
            seed,
            timing,
            random,
            completed: 0,
            frames: vec![],
            products: vec![],
            pot: vec![],
            recipes: BTreeMap::new(),
            pending: None,
        }
    }
    pub async fn run(&mut self, alchemy: &dyn Alchemy) -> Result<()> {
        while !self.run_next(alchemy).await? {}
        Ok(())
    }
    /// Resolves one contributor. The caller may publish progress between awaits.
    /// Returns true when every contributor has been computed.
    pub async fn run_next(&mut self, alchemy: &dyn Alchemy) -> Result<bool> {
        if self.completed >= self.contributions.len() {
            return Ok(true);
        }
        let contribution = &self.contributions[self.completed];
        let pending = self.pending.get_or_insert_with(|| Pending {
            pot: self.pot.clone(),
            prices: self.prices.clone(),
            recipes: self.recipes.clone(),
            rolls: vec![],
            policies: vec![],
            product_ids: vec![],
            frame_ids: vec![],
        });
        let (frames, products, pot) = compute(
            pending,
            contribution,
            &self.seed,
            &self.timing,
            &self.random,
            alchemy,
        )
        .await?;
        self.frames.extend(frames);
        self.products.extend(products);
        self.pot = pot;
        self.prices = pending.prices.clone();
        self.recipes = pending.recipes.clone();
        self.pending = None;
        self.completed += 1;
        Ok(self.completed == self.contributions.len())
    }
    pub fn current_player_id(&self) -> Option<String> {
        self.contributions
            .get(self.completed)
            .map(|c| c.owner_id.clone())
    }
}

pub(crate) fn context(
    prices: &BTreeMap<String, Material>,
    recipes: &BTreeMap<String, Recipe>,
) -> Value {
    json!({
        "prices": prices.values().map(|material| {
            json!({"name": material.name, "price": material.price})
        }).collect::<Vec<_>>(),
        "history": recipes.values().collect::<Vec<_>>()
    })
}

fn stable_id(ids: &mut Vec<String>, index: usize) -> String {
    if ids.len() == index {
        ids.push(uid());
    }
    ids[index].clone()
}

fn push_frame(pending: &mut Pending, frames: &mut Vec<Frame>, mut frame: Frame, timing: &Timing) {
    if matches!(frame.action, FrameAction::Reaction { .. })
        && let Some(previous) = frames.last_mut()
    {
        previous.hold_ms = timing.chain_hold_ms;
        previous.duration_ms = previous.animation_ms + timing.chain_hold_ms;
    }
    frame.id = stable_id(&mut pending.frame_ids, frames.len());
    frames.push(frame);
}

async fn compute(
    pending: &mut Pending,
    contribution: &Contribution,
    seed: &str,
    timing: &Timing,
    random: &RandomSource,
    alchemy: &dyn Alchemy,
) -> Result<(Vec<Frame>, Vec<Material>, Vec<PotMaterial>)> {
    let mut incoming = PotMaterial::from(contribution);
    let mut pot = pending.pot.clone();
    pot.push(incoming.clone());
    pot.sort_by_key(|material| material.order);
    let mut frames = vec![];
    let mut products = vec![];
    let mut roll_index = 0;
    push_frame(
        pending,
        &mut frames,
        Frame {
            id: String::new(),
            player_id: contribution.owner_id.clone(),
            player_name: contribution.owner_name.clone(),
            animation_ms: timing.deposit_ms,
            hold_ms: timing.hold_ms,
            duration_ms: timing.deposit_ms + timing.hold_ms,
            pot_before: pending.pot.clone(),
            pot_after: pot.clone(),
            action: FrameAction::Deposit {
                material: incoming.clone(),
            },
        },
        timing,
    );
    while pot.len() > 1 && incoming.material.price < red_minimum() {
        let mut candidates: Vec<_> = pot
            .iter()
            .filter(|item| item.id != incoming.id && item.material.price < red_minimum())
            .cloned()
            .collect();
        candidates.sort_by_key(|item| (item.material.price, item.order));
        let mut partner = None;
        for candidate in candidates {
            if pending.rolls.len() == roll_index {
                pending.rolls.push(random.draw());
            }
            let roll = pending.rolls[roll_index];
            roll_index += 1;
            if roll < reaction_probability(&incoming.material.name, &candidate.material.name, seed)
            {
                partner = Some(candidate);
                break;
            }
        }
        let Some(partner) = partner else { break };
        let index = products.len();
        if pending.policies.len() == index {
            pending.policies.push(synthesis_price_policy(
                &incoming.material,
                &partner.material,
                rand::thread_rng().r#gen(),
            ));
        }
        let policy = pending.policies[index].clone();
        let constraint = &policy.price_constraint;
        let mut pair = policy.inputs.clone();
        pair.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.price.cmp(&b.price)));
        let key = serde_json::to_string(&(&pair, constraint)).expect("serializable recipe key");
        if let Some(recipe) = pending.recipes.get(&key)
            && let Some(known) = pending.prices.get(&recipe.name)
            && constraint.validate(known.price).is_err()
        {
            pending.recipes.remove(&key);
        }
        let recipe = if let Some(recipe) = pending.recipes.get(&key) {
            recipe.clone()
        } else {
            let mut ctx = context(&pending.prices, &pending.recipes);
            ctx["priceConstraint"] = json!(constraint);
            let product = alchemy
                .synthesize(json!(policy.inputs[0]), json!(policy.inputs[1]), ctx)
                .await?;
            if product["refused"] == true {
                return Err(material_refusal());
            }
            let name = validate_material_name(
                product["name"]
                    .as_str()
                    .ok_or_else(|| GameError::new("合成材料名称无效"))?,
            )?;
            if let Some(known) = pending.prices.get(&name) {
                constraint.validate(known.price)?;
            }
            let mut ingredients = [policy.inputs[0].name.clone(), policy.inputs[1].name.clone()];
            ingredients.sort();
            let recipe = Recipe {
                ingredients,
                name,
                price_constraint: constraint.clone(),
            };
            pending.recipes.insert(key, recipe.clone());
            recipe
        };
        let material = if let Some(known) = pending.prices.get(&recipe.name) {
            constraint.validate(known.price)?;
            known.without_source()
        } else {
            let mut ctx = context(&pending.prices, &pending.recipes);
            ctx["synthesisInputs"] = json!(policy.inputs);
            ctx["priceConstraint"] = json!(constraint);
            let result = alchemy.price(&recipe.name, ctx).await?;
            let price = validate_price(&result, None)?;
            constraint.validate(price)?;
            let material = Material::new(recipe.name, price);
            let mut cached = material.clone();
            cached.source = Some("deepseek".to_owned());
            pending.prices.insert(cached.name.clone(), cached);
            material
        };
        let ingredients = [incoming.clone(), partner.clone()];
        let before = pot.clone();
        let order = incoming.order.min(partner.order);
        pot.retain(|item| item.id != incoming.id && item.id != partner.id);
        incoming = PotMaterial {
            id: stable_id(&mut pending.product_ids, index),
            owner_id: None,
            owner_name: None,
            material: material.clone(),
            order,
        };
        pot.push(incoming.clone());
        pot.sort_by_key(|item| item.order);
        products.push(material);
        push_frame(
            pending,
            &mut frames,
            Frame {
                id: String::new(),
                player_id: contribution.owner_id.clone(),
                player_name: contribution.owner_name.clone(),
                animation_ms: timing.reaction_ms,
                hold_ms: timing.hold_ms,
                duration_ms: timing.reaction_ms + timing.hold_ms,
                pot_before: before,
                pot_after: pot.clone(),
                action: FrameAction::Reaction {
                    ingredients,
                    product: incoming.clone(),
                },
            },
            timing,
        );
    }
    Ok((frames, products, pot))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    struct RetryModel {
        names: AtomicUsize,
        prices: AtomicUsize,
        constraints: Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl Alchemy for RetryModel {
        async fn synthesize(&self, _: Value, _: Value, ctx: Value) -> Result<Value> {
            self.names.fetch_add(1, Ordering::SeqCst);
            self.constraints
                .lock()
                .unwrap()
                .push(ctx["priceConstraint"].clone());
            Ok(json!({"name":"晨光茶晶"}))
        }
        async fn price(&self, _: &str, ctx: Value) -> Result<Value> {
            self.constraints
                .lock()
                .unwrap()
                .push(ctx["priceConstraint"].clone());
            let call = self.prices.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"price":if call==0 {0} else {300}}))
        }
    }
    #[tokio::test]
    async fn retry_keeps_the_price_draw_recipe_and_frame_ids() {
        let first = Contribution {
            id: "a".into(),
            owner_id: "A".into(),
            owner_name: "甲".into(),
            material: Material::new("晨露".into(), 5),
            order: 0,
        };
        let second = Contribution {
            id: "b".into(),
            owner_id: "B".into(),
            owner_name: "乙".into(),
            material: Material::new("月光蘑菇".into(), 25),
            order: 1,
        };
        assert_eq!(reaction_probability("晨露", "月光蘑菇", "fixed-seed"), 1.0);
        let mut pending = Pending {
            pot: vec![PotMaterial::from(&first)],
            prices: super::super::price_cache(),
            recipes: BTreeMap::new(),
            rolls: vec![0.5],
            policies: vec![synthesis_price_policy(
                &first.material,
                &second.material,
                0.99,
            )],
            product_ids: vec![],
            frame_ids: vec![],
        };
        let model = RetryModel {
            names: AtomicUsize::new(0),
            prices: AtomicUsize::new(0),
            constraints: Mutex::new(vec![]),
        };
        let timing = Timing::default();
        assert_eq!(
            compute(
                &mut pending,
                &second,
                "fixed-seed",
                &timing,
                &RandomSource::default(),
                &model
            )
            .await
            .unwrap_err()
            .code,
            "PRICE_CONSTRAINT_VIOLATION"
        );
        let frame_id = pending.frame_ids[0].clone();
        let policy = pending.policies[0].clone();
        let (frames, products, pot) = compute(
            &mut pending,
            &second,
            "fixed-seed",
            &timing,
            &RandomSource::default(),
            &model,
        )
        .await
        .unwrap();
        assert_eq!(pending.policies[0], policy);
        assert_eq!(frames[0].id, frame_id);
        assert_eq!(frames[0].hold_ms, timing.chain_hold_ms);
        assert_eq!(frames[1].hold_ms, timing.hold_ms);
        assert_eq!(products[0].price, 300);
        assert_eq!(pot.len(), 1);
        assert_eq!(model.names.load(Ordering::SeqCst), 1);
        assert_eq!(model.prices.load(Ordering::SeqCst), 2);
        let constraints = model.constraints.lock().unwrap();
        assert!(
            constraints
                .iter()
                .all(|c| c == &json!(policy.price_constraint))
        );
    }
}
