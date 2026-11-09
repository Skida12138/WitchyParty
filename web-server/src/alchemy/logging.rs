//! Local diagnostics use a bounded queue and one writer. Recording never waits
//! for the filesystem; shutdown can explicitly flush accepted events.
use regex::Regex;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot},
};

const QUEUE_CAPACITY: usize = 256;

pub(super) struct RoomLogger {
    sender: Option<mpsc::Sender<Command>>,
    warned: Arc<AtomicBool>,
}

enum Command {
    Record { trace: Value, event: Value },
    Flush(oneshot::Sender<()>),
}

struct Writer {
    directory: PathBuf,
    secrets: Vec<String>,
    bearer: Regex,
    credentials: Regex,
}

fn warn_once(warned: &AtomicBool) {
    if !warned.swap(true, Ordering::Relaxed) {
        tracing::warn!("房间调用日志暂时无法完整记录；游戏继续运行。");
    }
}

impl RoomLogger {
    pub fn from_env(root: &Path, api_key: String) -> Self {
        if std::env::var("ROOM_LOG_ENABLED").as_deref() == Ok("0") {
            return Self {
                sender: None,
                warned: Arc::new(AtomicBool::new(false)),
            };
        }
        let mut secrets = vec![api_key];
        if let Ok(invite) = std::env::var("INVITE_CODE_SHA256") {
            secrets.extend([invite.to_lowercase(), invite]);
        }
        let directory =
            root.join(std::env::var("ROOM_LOG_DIR").unwrap_or_else(|_| "logs/rooms".into()));
        Self::start(directory, secrets)
    }

    fn start(directory: PathBuf, secrets: Vec<String>) -> Self {
        let (sender, mut receiver) = mpsc::channel(QUEUE_CAPACITY);
        let warned = Arc::new(AtomicBool::new(false));
        let worker_warning = warned.clone();
        let writer = Writer::new(directory, secrets);
        tokio::spawn(async move {
            // Dropping all logger handles closes the channel. The worker still
            // drains accepted events, unless the runtime itself is shut down.
            while let Some(command) = receiver.recv().await {
                match command {
                    Command::Record { trace, event } => {
                        if writer.write(&trace, event).await.is_err() {
                            warn_once(&worker_warning);
                        }
                    }
                    Command::Flush(done) => {
                        // A dropped flush waiter does not cancel earlier writes.
                        let _ = done.send(());
                    }
                }
            }
        });
        Self {
            sender: Some(sender),
            warned,
        }
    }

    /// Best-effort diagnostics. A slow writer cannot delay a game operation or
    /// grow an unbounded backlog; a full queue drops the new event.
    pub fn record(&self, trace: &Value, mut event: Value) {
        let Some(sender) = &self.sender else { return };
        if !event.is_object() || !trace["roomId"].is_string() || !trace["roomSessionId"].is_string()
        {
            return;
        }
        let permit = match sender.try_reserve() {
            Ok(permit) => permit,
            Err(_) => {
                warn_once(&self.warned);
                return;
            }
        };
        event["recordedAt"] = json!(chrono::Utc::now().to_rfc3339());
        permit.send(Command::Record {
            trace: trace.clone(),
            event,
        });
    }

    /// Wait until every previously accepted event has been written or reported
    /// as a write failure. Only shutdown/explicit flush callers wait on disk.
    pub async fn flush(&self) {
        let Some(sender) = &self.sender else { return };
        let (done, received) = oneshot::channel();
        if sender.send(Command::Flush(done)).await.is_err() || received.await.is_err() {
            warn_once(&self.warned);
        }
    }
}

impl Writer {
    fn new(directory: PathBuf, mut secrets: Vec<String>) -> Self {
        secrets.retain(|s| !s.is_empty());
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Self {
            directory,
            secrets,
            bearer: Regex::new(r"(?i)\bBearer\s+[a-zA-Z0-9._~+/\-]+=*").unwrap(),
            credentials: Regex::new(r#"(?i)"(?:authorization|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret)"\s*:\s*"(?:\\.|[^"\\])*""#).unwrap(),
        }
    }

    fn text(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for secret in &self.secrets {
            text = text.replace(secret, "[REDACTED]");
        }
        self.credentials
            .replace_all(
                &self.bearer.replace_all(&text, "Bearer [REDACTED]"),
                "\"[credential]\":\"[REDACTED]\"",
            )
            .into_owned()
    }

    fn sanitize(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => json!(self.text(s)),
            Value::Array(items) => {
                json!(items.iter().map(|v| self.sanitize(v)).collect::<Vec<_>>())
            }
            Value::Object(fields) => {
                let mut out = serde_json::Map::new();
                for (key, value) in fields {
                    let normalized = key
                        .chars()
                        .filter(|c| c.is_ascii_alphabetic())
                        .collect::<String>()
                        .to_lowercase();
                    if [
                        "authorization",
                        "apikey",
                        "token",
                        "accesstoken",
                        "refreshtoken",
                        "password",
                        "secret",
                    ]
                    .contains(&normalized.as_str())
                    {
                        continue;
                    }
                    out.insert(self.text(key), self.sanitize(value));
                }
                Value::Object(out)
            }
            _ => value.clone(),
        }
    }

    async fn write(&self, trace: &Value, mut event: Value) -> std::io::Result<()> {
        let room = trace["roomId"].as_str().expect("validated log trace");
        let session = trace["roomSessionId"]
            .as_str()
            .expect("validated log trace");
        event["roomId"] = json!(room);
        event["roomSessionId"] = json!(session);
        event["round"] = trace["round"].clone();
        event["lap"] = trace["lap"].clone();
        event["triggeredBy"] = trace["player"].clone();
        event["actor"] = match event["operation"].as_str() {
            Some("imagine") => {
                json!({"kind":"bot","label":format!("AI 女巫（{}）",trace["player"]["name"].as_str().unwrap_or("未指定")),"playerId":trace["player"]["id"]})
            }
            Some("price") => json!({"kind":"system","label":"定价系统"}),
            Some("synthesize") => json!({"kind":"system","label":"合成系统"}),
            _ => json!({"kind":"system","label":"房间系统"}),
        };
        let entry = self.sanitize(&event);
        let safe = |s: &str| {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .take(90)
                .collect::<String>()
        };
        let basename = format!("{}-{}", safe(room), safe(session));
        let json_line = format!("{entry}\n");
        let readable = format!(
            "=== {} | {} | {} | {} ===\n{}\n\n",
            entry["recordedAt"].as_str().unwrap_or_default(),
            entry["actor"]["label"].as_str().unwrap_or_default(),
            entry["operation"].as_str().unwrap_or_default(),
            entry["status"].as_str().unwrap_or_default(),
            serde_json::to_string_pretty(&entry).unwrap_or_default()
        );
        tokio::fs::create_dir_all(&self.directory).await?;
        for (ext, data) in [("jsonl", json_line), ("log", readable)] {
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.directory.join(format!("{basename}.{ext}")))
                .await?;
            file.write_all(data.as_bytes()).await?;
            // Tokio files may retain an in-flight blocking write after
            // write_all; flush makes the subsequent queue barrier observable.
            file.flush().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace() -> Value {
        json!({"roomId":"ROOM","roomSessionId":"SESSION","round":1,"lap":1,"player":{"id":"bot","name":"女巫"}})
    }

    #[test]
    fn full_or_closed_queue_does_not_wait_for_a_writer() {
        // No writer or runtime exists: all calls must return synchronously.
        let (sender, mut receiver) = mpsc::channel(2);
        let logger = RoomLogger {
            sender: Some(sender),
            warned: Arc::new(AtomicBool::new(false)),
        };
        for index in 0..20 {
            logger.record(&trace(), json!({"index":index}));
        }
        assert_eq!(receiver.len(), 2);
        assert!(logger.warned.load(Ordering::Relaxed));
        let Command::Record { event, .. } = receiver.try_recv().unwrap() else {
            panic!("expected an event")
        };
        assert_eq!(event["index"], 0);
        drop(receiver);
        logger.record(&trace(), json!({"index":20}));
    }

    #[tokio::test]
    async fn flush_waits_for_both_outputs_and_preserves_order_and_redaction() {
        let directory = std::env::temp_dir().join(format!("witchy-logs-{}", uuid::Uuid::new_v4()));
        let logger = RoomLogger::start(directory.clone(), vec!["private-api-key".into()]);
        logger.record(
            &trace(),
            json!({"type":"started","operation":"price","request":{"apiKey":"private-api-key","name":"花","detail":"Bearer another-credential private-api-key"}}),
        );
        logger.record(
            &trace(),
            json!({"type":"completed","operation":"price","response":{"price":10}}),
        );
        logger.flush().await;
        let jsonl = tokio::fs::read_to_string(directory.join("ROOM-SESSION.jsonl"))
            .await
            .unwrap();
        let readable = tokio::fs::read_to_string(directory.join("ROOM-SESSION.log"))
            .await
            .unwrap();
        let entries: Vec<Value> = jsonl
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["type"], "started");
        assert_eq!(entries[1]["type"], "completed");
        assert_eq!(entries[0]["round"], 1);
        assert_eq!(entries[0]["actor"]["label"], "定价系统");
        assert!(entries[0]["request"].get("apiKey").is_none());
        for text in [&jsonl, &readable] {
            assert!(!text.contains("private-api-key"));
            assert!(!text.contains("another-credential"));
            assert!(text.contains("[REDACTED]"));
        }
        assert!(readable.contains("completed"));
        drop(logger);
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
