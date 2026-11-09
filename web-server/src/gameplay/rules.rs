use super::{GameError, Material, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{LazyLock, OnceLock},
};
use unicode_normalization::UnicodeNormalization;

static CONFIG: OnceLock<(Value, Vec<Value>)> = OnceLock::new();
static DEFAULT_CONFIG: LazyLock<(Value, Vec<Value>)> = LazyLock::new(|| {
    (
        serde_json::from_str(include_str!("../../../config/rules.json"))
            .expect("valid bundled rules"),
        serde_json::from_str(include_str!("../../../config/materials.json"))
            .expect("valid bundled materials"),
    )
});
/// Load configuration before constructing any rooms or model services. A malformed
/// runtime configuration is an error; embedded defaults are only for library callers.
pub fn initialize_config(root: &Path) -> Result<()> {
    let read = |file: &str| -> Result<Value> {
        let path = root.join("config").join(file);
        let data = std::fs::read_to_string(&path)
            .map_err(|e| GameError::new(format!("读取 {} 失败：{e}", path.display())))?;
        serde_json::from_str(&data)
            .map_err(|e| GameError::new(format!("解析 {} 失败：{e}", path.display())))
    };
    let rules = read("rules.json")?;
    for key in [
        "startingCoins",
        "maxPlayers",
        "maxQuotes",
        "maxMaterialNameLength",
        "maxMaterialPrice",
        "depositMs",
        "reactionMs",
        "holdMs",
        "chainHoldMs",
        "winnerAnimationMs",
    ] {
        if rules[key].as_u64().is_none() {
            return Err(GameError::new(format!("游戏规则 {key} 必须为非负整数")));
        }
    }
    if rules["maxPlayers"].as_u64().unwrap() < 2
        || rules["maxQuotes"] == 0
        || rules["maxMaterialNameLength"] == 0
        || rules["maxMaterialPrice"].as_u64().unwrap() > 1_000_000_000
        || rules["startingCoins"].as_u64().unwrap() > 9_007_199_254_740_991
        || rules["probabilityDivisor"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n <= 0.0)
    {
        return Err(GameError::new("游戏规则数值无效"));
    }
    if rules["allowedRounds"].as_array().is_none_or(|items| {
        items.is_empty() || items.iter().any(|n| n.as_u64().is_none_or(|n| n == 0))
    }) {
        return Err(GameError::new("游戏轮数配置无效"));
    }
    let mut previous = -1;
    for tier in ["white", "green", "blue", "purple", "gold", "red"] {
        let value = rules["tierMinimums"][tier]
            .as_i64()
            .filter(|n| *n >= 0 && *n > previous)
            .ok_or_else(|| GameError::new("材料品质区间配置无效"))?;
        previous = value;
    }
    let materials = read("materials.json")?
        .as_array()
        .cloned()
        .ok_or_else(|| GameError::new("材料配置必须为数组"))?;
    for material in &materials {
        if material["name"]
            .as_str()
            .is_none_or(|n| n.trim().is_empty())
            || material["price"]
                .as_i64()
                .is_none_or(|n| n < 0 || n > rules["maxMaterialPrice"].as_i64().unwrap())
        {
            return Err(GameError::new("参考材料配置无效"));
        }
    }
    let config = (rules, materials);
    if let Some(existing) = CONFIG.get() {
        return if existing == &config {
            Ok(())
        } else {
            Err(GameError::new("游戏配置已经初始化，修改后需要重启服务"))
        };
    }
    CONFIG
        .set(config)
        .map_err(|_| GameError::new("游戏配置已经初始化"))
}
pub fn rules() -> &'static Value {
    &CONFIG.get().unwrap_or(&DEFAULT_CONFIG).0
}
pub fn max_price() -> i64 {
    rules()["maxMaterialPrice"].as_i64().unwrap()
}
pub fn max_quotes() -> usize {
    rules()["maxQuotes"].as_u64().unwrap() as usize
}
pub fn max_players() -> usize {
    rules()["maxPlayers"].as_u64().unwrap() as usize
}
pub fn starting_coins() -> i64 {
    rules()["startingCoins"].as_i64().unwrap()
}
pub fn red_minimum() -> i64 {
    rules()["tierMinimums"]["red"].as_i64().unwrap()
}
pub fn presets() -> Vec<Value> {
    CONFIG.get().unwrap_or(&DEFAULT_CONFIG).1.clone()
}
pub(crate) fn price_cache() -> BTreeMap<String, Material> {
    presets()
        .into_iter()
        .map(|value| {
            let name = normalize_name(value["name"].as_str().unwrap()).expect("valid preset name");
            let mut material = Material::new(name.clone(), value["price"].as_i64().unwrap());
            material.source = Some("preset".to_owned());
            (name, material)
        })
        .collect()
}
pub fn normalize_name(value: &str) -> Result<String> {
    let normalized: String = value.nfkc().collect();
    let normalized = normalized.trim();
    let name = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty()
        || name.encode_utf16().count() > rules()["maxMaterialNameLength"].as_u64().unwrap() as usize
        || name.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
    {
        return Err(GameError::new(format!(
            "材料名称需要 1–{} 个字符",
            rules()["maxMaterialNameLength"]
        )));
    }
    Ok(name)
}
pub fn material_refusal() -> GameError {
    GameError::with_code(
        "MATERIAL_REFUSED",
        "材料不能指定价值或包含指令，请只描述材料本身",
    )
}
pub fn validate_material_name(value: &str) -> Result<String> {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
        r"(?i)(?:忽略|无视|覆盖|忘记).{0,20}(?:规则|提示|指令|设定|系统)",
        r"(?i)(?:系统|开发者|助手|system|developer|assistant)\s*[:：]|<\|(?:system|assistant|im_start)\|>",
        r"(?i)(?:提示词|系统提示|开发者消息|system\s+prompt|ignore.{0,24}(?:instructions?|rules?)|reveal.{0,20}prompt)",
        r"(?i)(?:价值|售价|卖价|价格|定价|估价|报价|标价|魔力消耗|法力消耗|耗魔|消耗|魔力|法力|mana(?:\s+cost)?|值|worth|costs?|price[sd]?|valued?)\s*(?:设置为|指定为|设为|定为|应为|为|是|达|等于|=|:|：|set\s+to|must\s+be|is|at|of)?\s*[0-9零一二三四五六七八九十百千万亿两]+",
        r"(?i)[0-9零一二三四五六七八九十百千万亿两]+\s*(?:点|单位)?\s*(?:魔力|法力|mana)",
        r"(?i)(?:请|必须|务必|你要|输出|返回|设为|设置为|定为|算作|认定为|force|set|output|return).{0,24}(?:价格|金币|魔力|法力|耗魔|JSON|price|coins?|gold|mana)",
        r"(?:稀有度|等级|品质)\s*(?:设为|指定为|必须是|改为)",
    ].into_iter().map(|pattern| Regex::new(pattern).unwrap()).collect()
    });
    let name = normalize_name(value)?;
    let inspection: String = name.chars().filter(|c| !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')).collect();
    if PATTERNS.iter().any(|p| p.is_match(&inspection)) {
        return Err(material_refusal());
    }
    Ok(name)
}
pub fn tier_for(price: i64) -> &'static str {
    ["red", "gold", "purple", "blue", "green", "white"]
        .into_iter()
        .find(|tier| price >= rules()["tierMinimums"][*tier].as_i64().unwrap())
        .unwrap_or("white")
}
pub fn validate_price(result: &Value, constraint: Option<&Value>) -> Result<i64> {
    if result["refused"] == true {
        return Err(material_refusal());
    }
    let price = result["price"]
        .as_i64()
        .filter(|n| (0..=max_price()).contains(n))
        .ok_or_else(|| GameError::new("材料金币价值无效"))?;
    if let Some(c) = constraint {
        assert_price_constraint(price, c)?;
    }
    Ok(price)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PriceBand {
    Below,
    Between,
    Above,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceConstraint {
    pub band: PriceBand,
    pub min_price: i64,
    pub max_price: i64,
}
impl PriceConstraint {
    pub fn validate(&self, price: i64) -> Result<()> {
        if self.min_price < 0 || self.min_price > self.max_price || self.max_price > max_price() {
            return Err(GameError::new("合成价格区间无效"));
        }
        if !(self.min_price..=self.max_price).contains(&price) {
            return Err(GameError::with_code(
                "PRICE_CONSTRAINT_VIOLATION",
                "合成材料价格不在本次允许区间内，请重新尝试",
            ));
        }
        Ok(())
    }
}

pub fn assert_price_constraint(price: i64, constraint: &Value) -> Result<()> {
    let constraint: PriceConstraint = serde_json::from_value(constraint.clone())
        .map_err(|_| GameError::new("合成价格区间无效"))?;
    constraint.validate(price)
}
pub fn material_vector(name: &str, seed: &str) -> [f64; 4] {
    let mut hash = Sha256::new();
    hash.update(
        normalize_name(name)
            .unwrap_or_else(|_| name.to_owned())
            .as_bytes(),
    );
    hash.update([0]);
    hash.update(seed.as_bytes());
    let digest = hash.finalize();
    std::array::from_fn(|group| {
        let sum: u32 = (0..8)
            .step_by(2)
            .map(|offset| {
                u16::from_be_bytes([digest[group * 8 + offset], digest[group * 8 + offset + 1]])
                    as u32
            })
            .sum();
        (sum % 65536) as f64 / 65535.0 * 2.0 - 1.0
    })
}
pub fn reaction_probability(a: &str, b: &str, seed: &str) -> f64 {
    let a = material_vector(a, seed);
    let b = material_vector(b, seed);
    ((0..4).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>().sqrt()
        / rules()["probabilityDivisor"].as_f64().unwrap())
    .min(1.0)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PriceInput {
    pub name: String,
    pub price: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricePolicy {
    pub inputs: [PriceInput; 2],
    pub logarithms: [f64; 2],
    pub weights: [f64; 2],
    pub draw: f64,
    pub price_constraint: PriceConstraint,
}

pub fn synthesis_price_policy(a: &Material, b: &Material, draw: f64) -> PricePolicy {
    let mut inputs = [
        PriceInput {
            name: a.name.clone(),
            price: a.price,
        },
        PriceInput {
            name: b.name.clone(),
            price: b.price,
        },
    ];
    inputs.sort_by(|a, b| a.price.cmp(&b.price).then_with(|| a.name.cmp(&b.name)));
    let lo = inputs[0].price;
    let hi = inputs[1].price;
    let logarithms = [(lo.max(1) as f64).log10(), (hi.max(1) as f64).log10()];
    let total = logarithms[0] + logarithms[1];
    let weights = if total > 0.0 {
        [logarithms[0] / total, logarithms[1] / total]
    } else {
        [0.5, 0.5]
    };
    let draw = draw.clamp(f64::EPSILON, 1.0 - f64::EPSILON);
    let (band, min_price, max_price) = if draw < weights[0] {
        (PriceBand::Below, 0, (lo - 1).max(0))
    } else if draw < weights[1] {
        (PriceBand::Between, lo, hi)
    } else {
        (PriceBand::Above, (hi + 1).min(max_price()), max_price())
    };
    PricePolicy {
        inputs,
        logarithms,
        weights,
        draw,
        price_constraint: PriceConstraint {
            band,
            min_price,
            max_price,
        },
    }
}
