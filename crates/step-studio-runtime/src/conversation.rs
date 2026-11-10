//! Step RPC events onto Studio conversation events.
//!
//! Pure functions over JSON: no sockets, no threads. That is what makes the
//! mapping testable with the exact event vectors the real CLI emits, which is
//! the same discipline the TypeScript adapter uses.

use serde_json::{json, Value};

/// Studio block types the conversation contract accepts.
fn block_type_of(event_type: &str) -> Option<&'static str> {
    if event_type.starts_with("thinking") {
        Some("thinking")
    } else if event_type.starts_with("text") {
        Some("text")
    } else {
        None
    }
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Step timestamps are epoch milliseconds on live messages and ISO strings on
/// persisted entries. `Number()` of an ISO string is NaN in TypeScript and
/// `new Date(NaN)` throws, which is a bug the Rust port must not reintroduce.
pub fn to_iso(value: &Value) -> String {
    if let Some(millis) = value.as_i64() {
        if let Some(datetime) = chrono_free_from_millis(millis) {
            return datetime;
        }
    }
    if let Some(text) = value.as_str() {
        if !text.is_empty() {
            return text.to_string();
        }
    }
    "1970-01-01T00:00:00.000Z".to_string()
}

/// Minimal epoch-millis to ISO-8601, so the port needs no date dependency.
fn chrono_free_from_millis(millis: i64) -> Option<String> {
    let days = millis.div_euclid(86_400_000);
    let rem = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days)?;
    let hour = rem / 3_600_000;
    let minute = (rem % 3_600_000) / 60_000;
    let second = (rem % 60_000) / 1000;
    let milli = rem % 1000;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z"
    ))
}

/// Howard Hinnant's days-from-civil, inverted.
fn civil_from_days(days: i64) -> Option<(i64, u32, u32)> {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    Some((year, month, day))
}

/// One mapped event plus whether it advances the persisted state version.
///
/// The contract is explicit: a pure `conversation.message.delta` advances
/// eventSeq only, while message/tool/turn/compaction completions advance
/// stateVersion because persisted authority changed.
pub struct Mapped {
    pub event: Value,
    pub advances_state: bool,
}

/// Map one Step event. Returns `None` for events with no Studio counterpart.
pub fn map_event(event: &Value, context: &MapContext) -> Option<Mapped> {
    let kind = event.get("type")?.as_str()?;
    match kind {
        "agent_start" => {
            context.begin_turn();
            None
        }
        "message_start" | "message_end" => {
            let message = event.get("message")?;
            let role = str_field(message, "role");
            // `custom` entries (runtime-context reminders, activity
            // capabilities) are ignored by the contract; tool results have no
            // public role.
            if role != "user" && role != "assistant" {
                return None;
            }
            let created = to_iso(message.get("timestamp").unwrap_or(&Value::Null));

            if kind == "message_start" {
                let id = context.open_message(role.clone());
                return Some(Mapped {
                    event: json!({
                        "kind": "conversation.message.started",
                        "sessionId": context.session_id,
                        "turnId": context.turn_id(),
                        "messageId": id,
                        "role": role,
                        "createdAt": created,
                    }),
                    advances_state: false,
                });
            }

            let id = context.close_message()?;
            let stop_reason = str_field(message, "stopReason");
            let error_message = message.get("errorMessage").and_then(|v| v.as_str());
            let failed = error_message.is_some() && stop_reason != "stop";
            let mut event = json!({
                "kind": "conversation.message.completed",
                "sessionId": context.session_id,
                "turnId": context.turn_id(),
                "messageId": id,
                "item": {
                    "kind": "message",
                    "itemId": id,
                    "parentId": null,
                    "createdAt": created,
                    "role": role,
                    "content": to_studio_blocks(message.get("content")),
                },
            });
            // The failed assistant message is authoritative: the Host must not
            // wait for a retry the CLI may run for minutes afterwards.
            if failed {
                event["error"] = json!({
                    "message": error_message.unwrap_or(""),
                    "provider": non_empty(str_field(message, "provider")),
                    "model": non_empty(str_field(message, "model")),
                });
            }
            Some(Mapped { event, advances_state: true })
        }
        "message_update" => {
            let update = event.get("assistantMessageEvent")?;
            let update_type = update.get("type")?.as_str()?;
            let block_type = block_type_of(update_type)?;
            let delta = update.get("delta")?.as_str()?;
            if delta.is_empty() {
                return None;
            }
            let id = context.open_message_id()?;
            Some(Mapped {
                event: json!({
                    "kind": "conversation.message.delta",
                    "sessionId": context.session_id,
                    "turnId": context.turn_id(),
                    "messageId": id,
                    "blockId": format!("b{}", update.get("contentIndex").and_then(|v| v.as_i64()).unwrap_or(0)),
                    "blockType": block_type,
                    "delta": delta,
                }),
                advances_state: false,
            })
        }
        "tool_execution_start" => Some(Mapped {
            event: json!({
                "kind": "conversation.tool.started",
                "sessionId": context.session_id,
                "turnId": context.turn_id(),
                "messageId": context.open_message_id().unwrap_or_else(|| format!("m{}", context.message_seq())),
                "toolCallId": str_field(event, "toolCallId"),
                "toolName": str_field(event, "toolName"),
                "arguments": event.get("args").cloned().unwrap_or(json!({})),
                "startedAt": now_iso(),
            }),
            advances_state: false,
        }),
        "tool_execution_end" => {
            let result = event.get("result");
            let content = result
                .and_then(|r| r.get("content"))
                .and_then(|c| c.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            Some(Mapped {
                event: json!({
                    "kind": "conversation.tool.completed",
                    "sessionId": context.session_id,
                    "turnId": context.turn_id(),
                    "toolCallId": str_field(event, "toolCallId"),
                    "result": {
                        "type": "toolResult",
                        "toolCallId": str_field(event, "toolCallId"),
                        "toolName": str_field(event, "toolName"),
                        "output": content,
                        "isError": result.and_then(|r| r.get("isError")).and_then(|v| v.as_bool()).unwrap_or(false),
                    },
                    "completedAt": now_iso(),
                }),
                advances_state: true,
            })
        }
        "turn_end" => Some(Mapped {
            event: json!({
                "kind": "conversation.turn.completed",
                "sessionId": context.session_id,
                "turnId": context.turn_id(),
            }),
            advances_state: true,
        }),
        "compaction_start" => Some(Mapped {
            event: json!({
                "kind": "conversation.compaction.started",
                "sessionId": context.session_id,
                "action": non_empty(str_field(event, "reason")),
            }),
            advances_state: false,
        }),
        "compaction_end" => Some(Mapped {
            event: json!({
                "kind": "conversation.compaction.completed",
                "sessionId": context.session_id,
                "aborted": event.get("aborted").and_then(|v| v.as_bool()).unwrap_or(false),
            }),
            advances_state: true,
        }),
        _ => None,
    }
}

/// Step content blocks onto Studio content blocks.
pub fn to_studio_blocks(content: Option<&Value>) -> Vec<Value> {
    let Some(list) = content.and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    let mut blocks = Vec::new();
    for entry in list {
        match entry.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(text) = entry.get("text").and_then(|t| t.as_str()) {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
            }
            Some("thinking") => {
                if let Some(thinking) = entry.get("thinking").and_then(|t| t.as_str()) {
                    blocks.push(json!({ "type": "thinking", "text": thinking }));
                }
            }
            Some("toolCall") => {
                blocks.push(json!({
                    "type": "toolCall",
                    "toolCallId": str_field(entry, "id"),
                    "toolName": str_field(entry, "name"),
                    "arguments": entry.get("arguments").cloned().unwrap_or(json!({})),
                }));
            }
            _ => {}
        }
    }
    blocks
}

fn non_empty(value: String) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}

/// A wall-clock ISO stamp, without pulling in a time crate.
pub fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    chrono_free_from_millis(millis).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

/// Per-turn identity the mapper needs. The Studio contract requires the
/// `messageId` in `started` to be reused by `completed`, and a `delta` to
/// reference a message that has already started.
pub struct MapContext {
    pub session_id: String,
    turn_seq: std::sync::atomic::AtomicU64,
    message_seq_inner: std::sync::atomic::AtomicU64,
    open: std::sync::Mutex<Option<(String, String)>>,
}

impl MapContext {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            turn_seq: std::sync::atomic::AtomicU64::new(0),
            message_seq_inner: std::sync::atomic::AtomicU64::new(0),
            open: std::sync::Mutex::new(None),
        }
    }

    pub fn turn_id(&self) -> String {
        format!("t{}", self.turn_seq.load(std::sync::atomic::Ordering::SeqCst))
    }

    pub fn begin_turn(&self) {
        self.turn_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn message_seq(&self) -> u64 {
        self.message_seq_inner.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn open_message(&self, role: String) -> String {
        let id = format!("m{}", self.message_seq_inner.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1);
        if let Ok(mut guard) = self.open.lock() {
            *guard = Some((id.clone(), role));
        }
        id
    }

    fn open_message_id(&self) -> Option<String> {
        self.open.lock().ok().and_then(|guard| guard.as_ref().map(|(id, _)| id.clone()))
    }

    fn close_message(&self) -> Option<String> {
        self.open.lock().ok().and_then(|mut guard| guard.take().map(|(id, _)| id))
    }
}
