//! The Studio Bridge server side of the adapter.
//!
//! One connection at a time: a second connection means the previous Host is
//! stale, and a single event slot pointing at a closed socket would orphan
//! whichever client it belonged to.

use std::io::BufReader;
use step_studio_bridge::transport::{self, Accepted};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use step_studio_bridge::frame::{read_frame, write_frame, FrameError};
use step_studio_bridge::handshake::{challenge_proof, verify_hello, PROTOCOL_VERSION};

use crate::capabilities::capability_manifest;
use crate::conversation::{map_event, MapContext};
use crate::snapshot::build_snapshot;
use crate::step_rpc::{StepError, StepRpc};

/// Receipt statuses that settle a command.
const TERMINAL_STATUSES: [&str; 4] = ["completed", "failed", "rejected", "outcome_unknown"];

/// Terminal outcomes a reconnect may have missed.
const TERMINAL_HISTORY: usize = 64;

pub struct AdapterConfig {
    pub endpoint: String,
    pub token: String,
    pub runtime_epoch: u64,
    pub cwd: String,
    pub step_command: String,
    pub step_env: Vec<(String, String)>,
    /// Resume the previous session instead of starting a fresh one.
    pub continue_session: bool,
}

/// Everything one connection needs: the socket, the CLI, and the shared state
/// that must outlive a reconnect.
pub struct Runtime {
    config: AdapterConfig,
    terminal: Arc<Mutex<Vec<Value>>>,
}

impl Runtime {
    pub fn new(config: AdapterConfig) -> Self {
        Self {
            config,
            terminal: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Serve until the process is asked to shut down.
    pub fn serve(&self) -> Result<(), String> {
        let _ = std::fs::remove_file(&self.config.endpoint);
        // A Unix socket is a file, so a stale one has to go first; a Windows
        // pipe is named, and there is nothing to remove.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.config.endpoint);
        let bind_at = transport::endpoint_for_bind(&self.config.endpoint);
        let listener = transport::bind(&bind_at)
            .map_err(|e| format!("could not bind {}: {e}", self.config.endpoint))?;
        eprintln!("step-studio-runtime listening on {}", self.config.endpoint);

        // One connection at a time.
        //
        // On Unix the listener persists and `accept` blocks on it, so this loops
        // for as long as the process runs. On Windows a single-instance pipe
        // serves exactly one client, so `bind` has already waited by the time it
        // returns: the first connection is served, and each one after that is a
        // fresh `bind`.
        // `accept` blocks on a Unix listener, so the unix arm loops forever and
        // never reaches the tail; on Windows each connection needs a fresh bind,
        // so that arm returns when it can no longer make one.
        #[cfg(unix)]
        {
            // The listener is borrowed: it outlives every connection it accepts.
            loop {
                match transport::accept(listener.try_clone().expect("the listener duplicates")) {
                    Ok(connection) => serve_one(connection, &self.config, &self.terminal),
                    Err(error) => {
                        eprintln!("step-studio-runtime: accept failed: {error}");
                    }
                }
            }
            // Never reached: the loop above runs for the life of the process.
            #[allow(unreachable_code)]
            Ok(())
        }
        #[cfg(windows)]
        {
            // The listener is consumed: a single-instance pipe serves one client
            // and is then recreated for the next.
            let mut listener = listener;
            loop {
                let connection = match transport::accept(listener) {
                    Ok(connection) => connection,
                    Err(error) => {
                        eprintln!("step-studio-runtime: accept failed: {error}");
                        return Ok(());
                    }
                };
                listener = match transport::bind(&bind_at) {
                    Ok(next) => next,
                    Err(error) => {
                        eprintln!("step-studio-runtime: rebind failed: {error}");
                        return Ok(());
                    }
                };
                serve_one(connection, &self.config, &self.terminal);
            }
        }
    }
}

/// Hand one accepted connection to its own thread.
fn serve_one(
    connection: transport::Accepted,
    config: &AdapterConfig,
    terminal: &Arc<Mutex<Vec<Value>>>,
) {
    let config = AdapterConfig {
        endpoint: config.endpoint.clone(),
        token: config.token.clone(),
        runtime_epoch: config.runtime_epoch,
        cwd: config.cwd.clone(),
        step_command: config.step_command.clone(),
        step_env: config.step_env.clone(),
        continue_session: config.continue_session,
    };
    let terminal = Arc::clone(terminal);
    std::thread::spawn(move || {
        if let Err(error) = serve_connection(connection, config, terminal) {
            eprintln!("step-studio-runtime: connection ended: {error}");
        }
    });
}

/// The tail, not the head: a UUIDv7's first characters are its timestamp, so
/// two sessions minted seconds apart look identical there.
fn short(id: &str) -> &str {
    let start = id.len().saturating_sub(8);
    &id[start..]
}

/// A live session: the Host socket plus the CLI it drives.
struct Session {
    stream: transport::Accepted,
    step: StepRpc,
    epoch: u64,
    seq: u64,
    context: MapContext,
    session_id: String,
    terminal: Arc<Mutex<Vec<Value>>>,
    shutting_down: bool,
    turn_error: Option<String>,
    state_version: u64,
    command_manifest_hash: String,
    pending_prompt: Option<String>,
}

impl Session {
    fn send(&mut self, body: &Value) -> Result<(), FrameError> {
        write_frame(&mut self.stream, self.epoch, body)
    }

    /// Record a terminal outcome so a reconnect can recover it.
    fn terminal(&mut self, receipt: Value) {
        if let Ok(mut guard) = self.terminal.lock() {
            guard.push(receipt.clone());
            if guard.len() > TERMINAL_HISTORY {
                guard.remove(0);
            }
        }
        let _ = self.send(&receipt);
    }

    fn receipt(&mut self, request_id: &str, status: &str, result: Option<Value>) {
        self.receipt_with_error(request_id, status, result, None);
    }

    fn receipt_with_error(
        &mut self,
        request_id: &str,
        status: &str,
        result: Option<Value>,
        error: Option<String>,
    ) {
        // Built as a map because `json!` has no spread syntax and `result` is
        // only present on some statuses.
        let mut receipt = serde_json::Map::new();
        receipt.insert("type".to_string(), json!("studio.receipt"));
        receipt.insert("requestId".to_string(), json!(request_id));
        receipt.insert("commandId".to_string(), json!(format!("cmd-{request_id}")));
        receipt.insert("runtimeEpoch".to_string(), json!(self.epoch));
        receipt.insert("stateVersion".to_string(), json!(0));
        receipt.insert("status".to_string(), json!(status));
        if let Some(value) = result {
            receipt.insert("result".to_string(), value);
        }
        if let Some(message) = error {
            // The Host and the shell both read the reason off the receipt; a
            // bare `failed` tells the user nothing.
            receipt.insert(
                "error".to_string(),
                json!({ "code": "INTERNAL_ERROR", "message": message, "retryable": false }),
            );
        }
        let receipt = Value::Object(receipt);
        if TERMINAL_STATUSES.contains(&status) {
            self.terminal(receipt);
        } else {
            let _ = self.send(&receipt);
        }
    }

    fn failed(&mut self, request_id: &str, message: String) {
        // The error rides on the receipt, not the result.
        self.receipt_with_error(request_id, "failed", None, Some(message));
    }

    fn event(&mut self, event: Value, advances_state: bool) {
        self.seq += 1;
        let state_version = if advances_state {
            self.state_version += 1;
            self.state_version
        } else {
            self.state_version
        };
        let envelope = json!({
            "type": "studio.event",
            "runtimeEpoch": self.epoch,
            "eventSeq": self.seq,
            "stateVersion": state_version,
            "occurredAt": crate::conversation::now_iso(),
            "event": event,
        });
        let _ = self.send(&envelope);
    }

    fn dispatch(&mut self, body: &Value) {
        let Some(operation) = body.get("operation") else {
            return;
        };
        let request_id = body.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let kind = operation.get("kind").and_then(|v| v.as_str()).unwrap_or("");

        match kind {
            "core.prompt" => {
                let text = operation.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                    eprintln!("[runtime] prompt accepted, sending to cli");
                }
                self.receipt(&request_id, "accepted", None);
                self.pending_prompt = Some(request_id);
                if let Err(error) = self.step.send("prompt", json!({ "message": text })) {
                    self.settle_prompt(Some(format!("step runtime could not start: {error}")));
                }
            }
            "core.steer" | "core.followUp" => {
                let command = if kind == "core.steer" { "steer" } else { "follow_up" };
                let text = operation.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                // Queueing is synchronous upstream, so this answers `completed`;
                // only `core.prompt` outlives its reply.
                match self.step.request(command, json!({ "message": text }), std::time::Duration::from_secs(10)) {
                    Ok(_) => self.receipt(&request_id, "completed", Some(json!({ "queued": true }))),
                    Err(error) => self.failed(&request_id, error.to_string()),
                }
            }
            "core.abort" => {
                let _ = self.step.send("abort", json!({}));
                if let Some(previous) = self.pending_prompt.take() {
                    let turn = self.context.turn_id();
                    self.event(json!({ "kind": "conversation.turn.aborted", "sessionId": self.session_id, "turnId": turn }), true);
                    self.receipt(&previous, "completed", Some(json!({ "ok": true })));
                }
                self.receipt(&request_id, "completed", Some(json!({ "aborted": true })));
            }
            "runtime.snapshot" => {
                let snapshot = build_snapshot(&mut self.step, self.epoch, &self.session_id);
                let _ = self.send(&json!({
                    "type": "studio.snapshot",
                    "requestId": request_id,
                    "snapshot": snapshot,
                    "commandManifestHash": self.command_manifest_hash,
                    "capabilityHash": capability_manifest().hash,
                    // Reporting 0 here resets the Host's watermark and turns the
                    // next event into a gap, which drops every later event.
                    "lastEventSeq": self.seq,
                    "terminalReceipts": self.terminal.lock().map(|g| g.clone()).unwrap_or_default(),
                }));
            }
            "runtime.shutdown" => {
                self.receipt(&request_id, "completed", None);
                let _ = self.send(&json!({ "kind": "runtime.shutdownComplete" }));
                self.shutting_down = true;
            }
            "session.model.set" => {
                if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                    eprintln!("[runtime] model.set {}", operation.get("selector").and_then(|v| v.as_str()).unwrap_or("?"));
                }
                let selector = operation.get("selector").and_then(|v| v.as_str()).unwrap_or("").to_string();
                match resolve_and_set_model(&mut self.step, &selector) {
                    Ok(()) => {
                        self.refresh_state();
                        self.receipt(&request_id, "completed", Some(json!({ "ok": true })));
                    }
                    Err(error) => self.failed(&request_id, error),
                }
            }
            "session.thinking.set" => {
                let level = operation.get("level").and_then(|v| v.as_str()).unwrap_or("").to_string();
                match set_thinking(&mut self.step, &level) {
                    Ok(()) => {
                        self.refresh_state();
                        self.receipt(&request_id, "completed", Some(json!({ "ok": true })));
                    }
                    Err(error) => self.failed(&request_id, error),
                }
            }
            "session.new" => {
                // Step exposes this as `new_session`; it mints a fresh session
                // id and drops the transcript. The mapping state is reset with
                // it, so entry ids from the old session cannot leak into the
                // new one.
                if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                    eprintln!("[runtime] session.new requested");
                }
                match self.step.request("new_session", json!({}), std::time::Duration::from_secs(15)) {
                    Ok(_) => {
                        self.context = MapContext::new(String::new());
                        self.refresh_state();
                        self.receipt(&request_id, "completed", Some(json!({ "ok": true })));
                    }
                    Err(error) => self.failed(&request_id, error.to_string()),
                }
            }
            "session.fork" => match fork_session(&mut self.step) {
                Ok(()) => {
                    self.refresh_state();
                    self.receipt(&request_id, "completed", Some(json!({ "ok": true })));
                }
                Err(error) => self.failed(&request_id, error),
            },
            "session.models.list" => {
                match self.step.request("get_available_models", json!({}), std::time::Duration::from_secs(10)) {
                    Ok(catalog) => {
                        let models = catalog
                            .get("models")
                            .and_then(|m| m.as_array())
                            .map(|list| {
                                list.iter()
                                    .map(|entry| {
                                        let provider = entry.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                                        let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                        json!({
                                            "provider": provider,
                                            "id": id,
                                            "selector": format!("{provider}/{id}"),
                                            "name": entry.get("name").and_then(|v| v.as_str()),
                                            "reasoning": entry.get("reasoning").and_then(|v| v.as_bool()),
                                            "contextWindow": entry.get("contextWindow").and_then(|v| v.as_i64()),
                                            "maxTokens": entry.get("maxTokens").and_then(|v| v.as_i64()),
                                            "api": entry.get("api").and_then(|v| v.as_str()),
                                        })
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        self.receipt(&request_id, "completed", Some(json!({ "models": models })));
                    }
                    Err(error) => self.failed(&request_id, error.to_string()),
                }
            }
            "session.transcript.read" => {
                let cursor = operation.get("cursor").and_then(|v| v.as_str());
                match read_transcript(&mut self.step, cursor) {
                    Ok(page) => self.receipt(&request_id, "completed", Some(page)),
                    Err(error) => self.failed(&request_id, error),
                }
            }
            // `session.history` is the paged form of the transcript: Studio's
            // Renderer asks for it with a cursor, and this adapter has no
            // pagination upstream, so the whole branch is the page.
            "session.history" => {
                let cursor = operation.get("cursor").and_then(|v| v.as_str());
                match read_transcript(&mut self.step, cursor) {
                    Ok(page) => self.receipt(&request_id, "completed", Some(page)),
                    Err(error) => self.failed(&request_id, error),
                }
            }
            // The same branch, as one object rather than a page: what the shell
            // restores a resumed session from.
            "session.state" => {
                self.refresh_state();
                let snapshot = build_snapshot(&mut self.step, self.epoch, &self.session_id);
                self.receipt(&request_id, "completed", Some(json!({ "snapshot": snapshot })));
            }
            _ => self.receipt(&request_id, "rejected", None),
        }
    }

    fn refresh_state(&mut self) {
        if let Ok(state) = self.step.request("get_state", json!({}), std::time::Duration::from_secs(10)) {
            if let Some(id) = state.get("sessionId").and_then(|v| v.as_str()) {
                if !id.is_empty() && id != self.session_id {
                    if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                        eprintln!("[runtime] session {} -> {}", short(&self.session_id), short(id));
                    }
                    self.session_id = id.to_string();
                }
            }
        }
    }

    /// Pump CLI events into Studio events until the prompt settles.
    fn pump_events(&mut self, timeout: std::time::Duration) -> bool {
        let mut settled = false;
        while let Some(event) = self.step.wait_event(timeout) {
            let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                eprintln!("[runtime] cli event {kind} {}", serde_json::to_string(&event).unwrap_or_default().chars().take(300).collect::<String>());
            }
            if let Some(mapped) = map_event(&event, &self.context) {
                self.event(mapped.event, mapped.advances_state);
            }
            if kind == "agent_settled" {
                let error = self.turn_error.take();
                self.settle_prompt(error);
                settled = true;
                break;
            }
        }
        // The CLI can die mid-turn. Nothing will ever settle the prompt then,
        // so the Host would wait forever and the shell would sit on "streaming"
        // with a Stop button that talks to a dead process. The TypeScript
        // adapter settles on exit; this is the same guarantee.
        if !settled && self.step.closed() {
            self.settle_prompt(Some(
                "the Step CLI exited before the turn finished".to_string(),
            ));
            settled = true;
        }
        settled
    }

    fn settle_prompt(&mut self, error: Option<String>) {
        let Some(request_id) = self.pending_prompt.take() else {
            return;
        };
        match error {
            Some(message) => self.failed(&request_id, message),
            None => self.receipt(&request_id, "completed", Some(json!({ "ok": true }))),
        }
    }

}

/// Resolve a selector against the live catalog.
///
/// Step model ids routinely contain a slash of their own
/// (`zed/claude-haiku-5-5` under provider `local-gateway`), so splitting on
/// the first slash reads the provider as `zed`. Matching the whole selector
/// as an id first, then falling back to `provider/id`, accepts both forms.
fn resolve_and_set_model(step: &mut StepRpc, selector: &str) -> Result<(), String> {
    let catalog = step
        .request("get_available_models", json!({}), std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    let models = catalog.get("models").and_then(|m| m.as_array());

    if let Some(list) = models {
        if let Some(match_by_id) = list.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some(selector)) {
            let provider = match_by_id.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            return set_model(step, provider, selector);
        }
    }
    if let Some(slash) = selector.find('/') {
        let provider = &selector[..slash];
        let id = &selector[slash + 1..];
        if let Some(list) = models {
            let found = list.iter().any(|m| {
                m.get("provider").and_then(|v| v.as_str()) == Some(provider)
                    && m.get("id").and_then(|v| v.as_str()) == Some(id)
            });
            if found {
                return set_model(step, provider, id);
            }
        }
    }
    Err(format!("model not found: {selector}"))
}

fn set_model(step: &mut StepRpc, provider: &str, model_id: &str) -> Result<(), String> {
    step.request(
        "set_model",
        json!({ "provider": provider, "modelId": model_id }),
        std::time::Duration::from_secs(20),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn set_thinking(step: &mut StepRpc, level: &str) -> Result<(), String> {
    const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if !LEVELS.contains(&level) {
        if level != "auto" {
            return Err(format!("unsupported thinking level: {level}"));
        }
        // `auto` has no Step equivalent: take the model's first supported level.
        let catalog = step
            .request("get_available_thinking_levels", json!({}), std::time::Duration::from_secs(10))
            .map_err(|e| e.to_string())?;
        let levels = catalog.get("levels").and_then(|l| l.as_array());
        let first = levels
            .and_then(|list| list.first())
            .and_then(|v| v.as_str())
            .ok_or("model reports no thinking levels")?;
        return apply_thinking(step, first);
    }
    apply_thinking(step, level)
}

fn apply_thinking(step: &mut StepRpc, level: &str) -> Result<(), String> {
    step.request("set_thinking_level", json!({ "level": level }), std::time::Duration::from_secs(10))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn fork_session(step: &mut StepRpc) -> Result<(), String> {
    let entries = step
        .request("get_entries", json!({}), std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    let leaf = entries.get("leafId").and_then(|v| v.as_str()).unwrap_or("");
    if leaf.is_empty() {
        return Err("session has no entry to fork from".to_string());
    }
    step.request("fork", json!({ "entryId": leaf }), std::time::Duration::from_secs(20))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// One page of the active branch. Step exposes no pagination cursor, so the
/// head cursor is a generation token and any other cursor is stale.
fn read_transcript(step: &mut StepRpc, cursor: Option<&str>) -> Result<Value, String> {
    let entries = step
        .request("get_entries", json!({}), std::time::Duration::from_secs(15))
        .map_err(|e| e.to_string())?;
    let list = entries.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let leaf = entries.get("leafId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let head = format!("step-1:{}", if leaf.is_empty() { "empty" } else { &leaf });
    if let Some(cursor) = cursor {
        if !cursor.is_empty() && cursor != head {
            return Err("CURSOR_STALE: transcript cursor does not match the active session".to_string());
        }
    }
    let items: Vec<Value> = list
        .iter()
        .filter(|entry| entry.get("type").and_then(|v| v.as_str()) == Some("message"))
        .filter_map(|entry| {
            let message = entry.get("message")?;
            let role = message.get("role").and_then(|v| v.as_str())?;
            // `toolResult` is a message too, and dropping it left a restored
            // conversation showing tool calls with no output.
            if !matches!(role, "user" | "assistant" | "toolResult") {
                return None;
            }
            let mut item = json!({
                "kind": "message",
                "itemId": entry.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "parentId": entry.get("parentId").and_then(|v| v.as_str()),
                "createdAt": crate::conversation::to_iso(entry.get("timestamp").unwrap_or(&Value::Null)),
                "role": role,
                "content": crate::conversation::to_studio_blocks(Some(message.get("content").unwrap_or(&Value::Null))),
            });
            if role == "toolResult" {
                // Step pairs a result to its call by id, so the shell can match
                // it exactly rather than by position.
                if let Some(object) = item.as_object_mut() {
                    object.insert(
                        "toolCallId".to_string(),
                        json!(message.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("")),
                    );
                    object.insert(
                        "toolName".to_string(),
                        json!(message.get("toolName").and_then(|v| v.as_str()).unwrap_or("")),
                    );
                    object.insert(
                        "isError".to_string(),
                        json!(message.get("isError").and_then(|v| v.as_bool()).unwrap_or(false)),
                    );
                }
            }
            Some(item)
        })
        .collect();
    Ok(json!({
        "runtimeEpoch": step_epoch_placeholder(),
        "sessionId": "",
        "branchLeafId": if leaf.is_empty() { Value::Null } else { json!(leaf) },
        "items": items,
        "headCursor": head,
        "hasMoreBefore": false,
    }))
}

fn step_epoch_placeholder() -> Value {
    json!(0)
}

/// One decoded frame from the Host, or the reason the socket went away.
enum HostFrame {
    Body(Value),
    Closed,
}

fn serve_connection(
    stream: transport::Accepted,
    config: AdapterConfig,
    terminal: Arc<Mutex<Vec<Value>>>,
) -> Result<(), String> {
    let step = StepRpc::spawn(&crate::step_rpc::StepLaunch {
        command: config.step_command.clone(),
        cwd: config.cwd.clone(),
        env: config.step_env.clone(),
        continue_session: config.continue_session,
    })
    .map_err(|e| e.to_string())?;

    let manifest = capability_manifest();
    let command_hash = manifest.command_hash.clone();
    let mut session = Session {
        stream,
        step,
        epoch: config.runtime_epoch,
        seq: 0,
        context: MapContext::new(String::new()),
        session_id: String::new(),
        terminal,
        shutting_down: false,
        turn_error: None,
        state_version: 0,
        command_manifest_hash: command_hash,
        pending_prompt: None,
    };

    // Handshake: the runtime must prove it holds the token before anything else
    // is trusted. This one frame is read directly, before the reader thread
    // exists, so there is exactly one owner of the socket.
    let frame = {
        let mut hello_reader = BufReader::new(transport::handshake_reader(&mut session.stream));
        read_frame(&mut hello_reader)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "host closed before hello".to_string())?
    };
    let body = frame.body;
    if body.get("type").and_then(|v| v.as_str()) != Some("studio.hello") {
        return Err("first frame was not a studio.hello".to_string());
    }
    let challenge = body.get("challenge").and_then(|v| v.as_str()).unwrap_or("");
    let instance_id = format!("step-runtime-{}", std::process::id());
    let proof = challenge_proof(&config.token, challenge, &instance_id);
    let _ = verify_hello(&body, &config.token, challenge); // validation only
    session.send(&json!({
        "type": "studio.hello.result",
        "requestId": body.get("requestId"),
        "selectedProtocolVersion": PROTOCOL_VERSION,
        "runtimeVersion": manifest.runtime_version,
        "upstreamVersion": "step-code",
        "upstreamCommit": "0.1.7",
        "runtimeInstanceId": instance_id,
        "runtimeEpoch": session.epoch,
        "capabilityManifest": manifest.value,
        "commandManifestHash": manifest.command_hash,
        "stateVersion": 0,
        "challengeProof": proof,
    }))
    .map_err(|e| e.to_string())?;

    // The session id only exists once the CLI has created its session.
    session.refresh_state();
    if !session.session_id.is_empty() {
        session.context = MapContext::new(session.session_id.clone());
    }

    // A reader thread owns the Host socket for the same reason the CLI has one:
    // a blocking read here would stall the event pump while a turn streams.
    let (host_tx, host_rx) = std::sync::mpsc::channel::<HostFrame>();
    let reader_stream = stream_for_reader(&session)?;
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader_stream);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(frame)) => {
                    if host_tx.send(HostFrame::Body(frame.body)).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = host_tx.send(HostFrame::Closed);
                    return;
                }
                Err(_) => {
                    let _ = host_tx.send(HostFrame::Closed);
                    return;
                }
            }
        }
    });

    loop {
        if session.shutting_down {
            return Ok(());
        }
        // A streaming turn must keep flowing while the Host is idle, so the CLI
        // is polled first with a short budget rather than blocking on either.
        if session.pending_prompt.is_some()
            && session.pump_events(std::time::Duration::from_millis(50))
        {
            continue;
        }
        match host_rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(HostFrame::Body(body)) => {
                if body.get("type").and_then(|v| v.as_str()) == Some("studio.request") {
                    session.dispatch(&body);
                }
            }
            Ok(HostFrame::Closed) => return Ok(()),
            // A timeout is not a disconnect: the Host is simply idle while a
            // turn streams. Treating it as an ending dropped the session, which
            // killed the CLI mid-turn.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Ok(()),
        }
        if session.shutting_down {
            return Ok(());
        }
    }
}

/// A second handle on the Host socket for the reader thread.
#[cfg(unix)]
fn stream_for_reader(session: &Session) -> Result<Accepted, String> {
    // A UnixStream is duplicable, which is the only way to read and write one
    // concurrently.
    // The session holds an `Accepted`, whose stream arm is the Unix socket.
    match &session.stream {
        Accepted::Stream(stream) => transport::duplicate(stream).map(Accepted::Stream),
    }
    .map_err(|e| format!("could not duplicate the bridge socket: {e}"))
}

/// On Windows a pipe handle is one direction, so the reader takes the accepted
/// connection and the writer keeps a second one it opened itself.
#[cfg(windows)]
#[allow(unused_variables)]
fn stream_for_reader(session: &Session) -> Result<Accepted, String> {
    // The Host already holds the other end of the accepted pipe, and a pipe
    // handle is one direction: the reader keeps the connection it was handed and
    // the writer opens its own. Both ends name the same pipe.
    let endpoint = transport::endpoint_for_bind(
        &std::env::var("STEP_STUDIO_TRANSPORT_ENDPOINT").unwrap_or_default(),
    );
    transport::reopen(&endpoint)
        .map(Accepted::Stream)
        .map_err(|e| format!("could not open the bridge pipe: {e}"))
}

/// Errors from the CLI that must not crash the adapter.
pub fn describe_step_error(error: &StepError) -> String {
    error.to_string()
}
