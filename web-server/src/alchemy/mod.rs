//! Model operations use alaya-agent's capability and protocol layers. No game
//! state is passed by reference across a model await.
mod logging;

use crate::gameplay::{
    GameError, assert_price_constraint, max_price, normalize_name, validate_material_name,
    validate_price,
};
use alaya_agent::{
    Message,
    capability::{ChatCapability, ChatRequest, ModelError},
    protocols::openai::OpenAiCompatible,
    providers::Provider,
    transport::{HttpTransport, TransportError},
};
use logging::RoomLogger;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct AlchemyService {
    inner: Arc<Inner>,
    trace: Value,
}
struct Inner {
    chat: OpenAiCompatible,
    ready: bool,
    model: String,
    bot_thinking: bool,
    prompts: PathBuf,
    presets: Vec<Value>,
    logger: RoomLogger,
}

fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
impl AlchemyService {
    pub fn from_env(root: impl AsRef<Path>) -> Result<Self, GameError> {
        let root = root.as_ref();
        let key = std::env::var("DEEPSEEK_API_KEY")
            .unwrap_or_default()
            .trim()
            .to_owned();
        if key.chars().any(|c| c.is_control()) {
            return Err(GameError::new("DEEPSEEK_API_KEY 格式无效"));
        }
        let ready = !key.is_empty();
        let transport = HttpTransport::new().with_timeout(Duration::from_secs(25));
        let provider = Provider::new(
            Arc::new(transport),
            "deepseek",
            std::env::var("DEEPSEEK_BASE_URL")
                .unwrap_or_else(|_| "https://api.deepseek.com".into()),
        )
        .with_bearer(&key);
        let read_json = |path: &Path| -> Result<Vec<Value>, GameError> {
            let text = std::fs::read_to_string(path)
                .map_err(|_| GameError::new(format!("无法读取配置：{}", path.display())))?;
            serde_json::from_str(&text)
                .map_err(|_| GameError::new(format!("配置格式无效：{}", path.display())))
        };
        Ok(Self {
            inner: Arc::new(Inner {
                chat: OpenAiCompatible::new(provider),
                ready,
                model: std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-flash".into()),
                bot_thinking: std::env::var("DEEPSEEK_BOT_THINKING").as_deref() != Ok("disabled"),
                prompts: root.join("config/prompts"),
                presets: read_json(&root.join("config/materials.json"))?,
                logger: RoomLogger::from_env(root, key),
            }),
            trace: Value::Null,
        })
    }

    pub fn ready(&self) -> bool {
        self.inner.ready
    }
    pub fn with_trace(&self, trace: Value) -> Self {
        Self {
            inner: self.inner.clone(),
            trace,
        }
    }
    pub fn record_event(&self, event: Value) {
        self.inner.logger.record(&self.trace, event);
    }

    pub async fn flush_logs(&self) {
        self.inner.logger.flush().await;
    }

    fn messages(&self, operation: &str, data: &Value) -> Result<Vec<Message>, GameError> {
        let read = |file: &str| -> Result<String, GameError> {
            let text = std::fs::read_to_string(self.inner.prompts.join(file))
                .map_err(|_| GameError::new(format!("无法读取提示词：{file}")))?;
            let text = text.trim();
            if text.is_empty()
                || [
                    "【任务背景】",
                    "【角色设定】",
                    "【任务描述】",
                    "【输出约束】",
                ]
                .iter()
                .any(|marker| text.contains(marker))
            {
                return Err(GameError::new(format!("提示词文件格式无效：{file}")));
            }
            Ok(text.into())
        };
        let character = if operation == "imagine" {
            "character-witch.txt"
        } else {
            "character-alchemy.txt"
        };
        let sections = [
            read("background.txt")?,
            read(character)?,
            read(&format!("task-{operation}.txt"))?,
            format!(
                "{}\n{}",
                read("output-format.txt")?,
                read(&format!("output-format-{operation}.txt"))?
            ),
        ];
        let system = ["任务背景", "角色设定", "任务描述", "输出约束"]
            .iter()
            .zip(sections)
            .map(|(name, value)| format!("【{name}】\n{value}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(vec![
            Message::system(system),
            Message::user(data.to_string()),
        ])
    }

    async fn request(
        &self,
        operation: &str,
        data: Value,
        context: &Value,
    ) -> Result<Value, GameError> {
        let started = Instant::now();
        let thinking = operation == "imagine" && self.inner.bot_thinking;
        let common = json!({"operation":operation,"requestId":uuid::Uuid::new_v4().to_string(),
            "startedAt":chrono::Utc::now().to_rfc3339(),"model":self.inner.model,
            "thinking":{"type":if thinking {"enabled"} else {"disabled"}},
            "reasoningEffort":if thinking {Some("low")} else {None},
            "maxTokens":if thinking {4096} else {512},"request":data});
        let mut first = common.clone();
        first["type"] = json!("started");
        first["status"] = json!("started");
        self.record_event(first);
        let mut response_log = Value::Null;
        let mut private_error = None;
        let result = async {
            if !self.ready() {
                return Err(GameError::new(
                    "服务器尚未配置 DeepSeek 密钥，请设置 DEEPSEEK_API_KEY 后重启服务",
                ));
            }
            let mut request = ChatRequest::new(&self.inner.model, self.messages(operation, &data)?)
                .with_response_format_json()
                .with_thinking(thinking)
                .with_max_tokens(if thinking { 4096 } else { 512 });
            if thinking {
                request = request.with_reasoning_effort("low");
            } else {
                request = request.with_temperature(0.65);
            }
            let reply =
                match tokio::time::timeout(Duration::from_secs(25), self.inner.chat.chat(request))
                    .await
                {
                    Ok(Ok(reply)) => reply,
                    Ok(Err(error)) => {
                        private_error = Some(error.to_string());
                        return Err(match error {
                            ModelError::Transport(TransportError::Api { status, .. }) => {
                                GameError::new(format!(
                                    "炼金顾问请求失败（{status}），请检查服务器的 DeepSeek 配置"
                                ))
                            }
                            ModelError::Decode(_)
                            | ModelError::Transport(TransportError::Serialization(_))
                            | ModelError::NoResponse => GameError::with_code(
                                if operation == "imagine" {
                                    "AI_DECISION_INVALID"
                                } else {
                                    "ACTION_FAILED"
                                },
                                "炼金顾问返回了无效结果，请重新尝试",
                            ),
                            _ => GameError::new(
                                "炼金顾问暂时不可用，请稍后重试；本次不消耗构想次数或金币",
                            ),
                        });
                    }
                    Err(_) => {
                        return Err(GameError::new(
                            "炼金顾问暂时不可用，请稍后重试；本次不消耗构想次数或金币",
                        ));
                    }
                };
            response_log =
                json!({"content":reply.content(),"reasoningContent":reply.reasoning_content()});
            let parsed: Value = serde_json::from_str(reply.content()).map_err(|_| {
                GameError::with_code(
                    if operation == "imagine" {
                        "AI_DECISION_INVALID"
                    } else {
                        "ACTION_FAILED"
                    },
                    "炼金顾问返回了无效结果，请重新尝试",
                )
            })?;
            if !parsed.is_object() {
                return Err(GameError::with_code(
                    if operation == "imagine" {
                        "AI_DECISION_INVALID"
                    } else {
                        "ACTION_FAILED"
                    },
                    "炼金顾问返回了无效结果，请重新尝试",
                ));
            }
            response_log["parsed"] = parsed.clone();
            let result = self.validate(operation, &parsed, context)?;
            if operation != "imagine" {
                response_log["validated"] = result.clone();
            }
            Ok(result)
        }
        .await;
        let mut event = common;
        event["type"] = json!("completed");
        event["status"] = json!(match &result {
            Ok(_) => "success",
            Err(error) => error.code.as_str(),
        });
        event["completedAt"] = json!(chrono::Utc::now().to_rfc3339());
        event["durationMs"] = json!(started.elapsed().as_millis() as u64);
        event["response"] = response_log;
        if let Err(error) = &result {
            event["error"] = json!(private_error.as_deref().unwrap_or(&error.message));
        }
        self.record_event(event);
        result
    }

    fn validate(
        &self,
        operation: &str,
        result: &Value,
        context: &Value,
    ) -> Result<Value, GameError> {
        if result["refused"] == true {
            return Err(crate::gameplay::material_refusal());
        }
        let constraint = context.get("priceConstraint").filter(|v| !v.is_null());
        match operation {
            "price" => Ok(json!({"price":validate_price(result, constraint)?})),
            "synthesize" => {
                let name = validate_material_name(result["name"].as_str().unwrap_or_default())?;
                if name.chars().count() > 40 {
                    return Err(GameError::new("AI材料名称需要 1–40 个字符"));
                }
                if let Some(constraint) = constraint {
                    for item in self.prices(context) {
                        if normalize_name(item["name"].as_str().unwrap_or_default())
                            .ok()
                            .as_deref()
                            == Some(&name)
                        {
                            validate_price(&item, Some(constraint))?;
                        }
                    }
                }
                Ok(json!({"name":name}))
            }
            "imagine" => Ok(result.clone()),
            _ => Err(GameError::new("未知的AI任务")),
        }
    }

    fn prices(&self, context: &Value) -> Vec<Value> {
        context
            .get("prices")
            .map(array)
            .unwrap_or_else(|| self.inner.presets.clone())
    }

    pub async fn price(&self, raw_name: &str, context: Value) -> Result<Value, GameError> {
        let name = validate_material_name(raw_name)?;
        let constraint = context.get("priceConstraint").filter(|v| !v.is_null());
        validate_constraint(constraint)?;
        let prices = self.prices(&context);
        for item in &prices {
            if normalize_name(item["name"].as_str().unwrap_or_default())
                .ok()
                .as_deref()
                == Some(&name)
            {
                let price = validate_price(item, constraint)?;
                let value = json!({"name":name,"price":price,"source":"cache"});
                self.record_event(json!({"type":"cache_hit","operation":"price","status":"cache","request":{"material":name},"response":{"parsed":value}}));
                return Ok(value);
            }
        }
        let mut data =
            json!({"material":name,"prices":prices,"synthesisHistory":array(&context["history"])});
        if let Some(inputs) = context.get("synthesisInputs") {
            let inputs = synthesis_inputs(inputs)?;
            data["source"] = json!("synthesis");
            data["inputTotal"] = json!(
                inputs
                    .iter()
                    .filter_map(|v| v["price"].as_i64())
                    .sum::<i64>()
            );
            data["synthesisInputs"] = json!(inputs);
        }
        if let Some(c) = constraint {
            data["priceConstraint"] = c.clone();
        }
        let value = self.request("price", data, &context).await?;
        Ok(json!({"name":name,"price":value["price"],"source":"deepseek"}))
    }

    pub async fn synthesize(&self, a: Value, b: Value, context: Value) -> Result<Value, GameError> {
        let inputs = synthesis_inputs(&json!([a, b]))?;
        let constraint = context.get("priceConstraint").filter(|v| !v.is_null());
        validate_constraint(constraint)?;
        let mut data = json!({"ingredients":inputs,"inputTotal":inputs.iter().filter_map(|v|v["price"].as_i64()).sum::<i64>(),
            "synthesisHistory":array(&context["history"]),"prices":self.prices(&context)});
        if let Some(c) = constraint {
            data["priceConstraint"] = c.clone();
        }
        let value = self.request("synthesize", data, &context).await?;
        Ok(json!({"name":value["name"],"source":"deepseek"}))
    }

    /// Run a prepared bot prompt. Candidate rules and private state belong to bots.
    pub async fn imagine(&self, payload: Value) -> Result<Value, GameError> {
        self.request("imagine", payload, &Value::Null).await
    }
}

fn validate_constraint(constraint: Option<&Value>) -> Result<(), GameError> {
    if let Some(c) = constraint {
        assert_price_constraint(c["minPrice"].as_i64().unwrap_or(-1), c)?;
    }
    Ok(())
}
fn synthesis_inputs(inputs: &Value) -> Result<Vec<Value>, GameError> {
    let inputs = inputs
        .as_array()
        .filter(|v| v.len() == 2)
        .ok_or_else(|| GameError::new("合成原料信息无效"))?;
    inputs
        .iter()
        .map(|item| {
            let price = item["price"]
                .as_i64()
                .filter(|n| (0..=max_price()).contains(n))
                .ok_or_else(|| GameError::new("合成原料信息无效"))?;
            let name = normalize_name(item["name"].as_str().unwrap_or_default())?;
            Ok(json!({"name":name,"price":price}))
        })
        .collect()
}

#[async_trait::async_trait]
impl crate::gameplay::Alchemy for AlchemyService {
    async fn price(&self, name: &str, context: Value) -> crate::gameplay::Result<Value> {
        AlchemyService::price(self, name, context).await
    }
    async fn synthesize(
        &self,
        a: Value,
        b: Value,
        context: Value,
    ) -> crate::gameplay::Result<Value> {
        AlchemyService::synthesize(self, a, b, context).await
    }
}
