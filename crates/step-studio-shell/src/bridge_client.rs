//! The shell's bridge session, driven from a background thread so the UI never
//! blocks on socket I/O.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::thread;

use step_studio_bridge::{AdapterLaunch, BridgeSession};

/// Opt-in diagnostics. A GUI app that writes to stderr unconditionally is just
/// noise; set `STEP_STUDIO_TRACE=1` when chasing a hang.
fn trace(message: &str) {
    if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
        eprintln!("[bridge] {message}");
    }
}

/// What the UI asks the runtime to do.
#[derive(Debug, Clone)]
pub enum Command {
    Prompt(String),
    /// Stop the turn in flight. Emits no events, so it does not compete with
    /// the turn for the session's shared event stream.
    Abort,
    /// Drop the transcript and start a fresh session.
    NewSession,
    SetModel(String),
    RefreshModels,
}

/// What the runtime tells the UI.
#[derive(Debug, Clone)]
pub enum Event {
    Ready {
        session_id: String,
        model: Option<String>,
    },
    Models(Vec<ModelRecord>),
    Thinking(String),
    Text(String),
    ToolStarted {
        call_id: String,
        name: String,
    },
    ToolCompleted {
        call_id: String,
        output: String,
        is_error: bool,
    },
    TurnCompleted,
    TurnFailed(String),
    /// The runtime started a fresh session; the transcript is gone.
    NewSession {
        session_id: String,
    },
    /// A transcript page, for restoring a resumed session into the view.
    Transcript {
        items: Vec<serde_json::Value>,
    },
    Disconnected(String),
}

#[derive(Debug, Clone)]
pub struct ModelRecord {
    pub selector: String,
    pub name: String,
    pub reasoning: bool,
}

/// The native runtime binary, or an empty command to fall back to Node.
fn native_runtime_command(repo_root: &std::path::Path) -> Vec<String> {
    for profile in ["release", "debug"] {
        let candidate = repo_root.join(format!("target/{profile}/step-studio-runtime"));
        if candidate.exists() {
            return vec![candidate.to_string_lossy().to_string()];
        }
    }
    Vec::new()
}

/// Spawn the session thread. Returns the control channels; the thread owns the
/// adapter process and dies with it.
pub fn spawn(repo_root: PathBuf, cwd: PathBuf, step_command: String) -> (Sender<Command>, Receiver<Event>) {
    let (to_bridge, from_ui) = std::sync::mpsc::channel::<Command>();
    let (to_ui, from_bridge) = std::sync::mpsc::channel::<Event>();

    thread::spawn(move || {
        let session_dir = cwd.join(".step-studio");
        let _ = std::fs::create_dir_all(&session_dir);
        let launch = AdapterLaunch {
            node: "node".to_string(),
            adapter_script: repo_root
                .join("packages/runtime-stepcode/dist/src/main.js")
                .to_string_lossy()
                .to_string(),
            socket_path: session_dir.join("bridge.sock").to_string_lossy().to_string(),
            token_file: session_dir.join("token").to_string_lossy().to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            runtime_epoch: 1,
            // Both names: the Rust adapter reads STEP_STUDIO_STEP_CMD, the
            // TypeScript fallback reads STEP_STUDIO_RUNTIME_CMD.
            env: vec![
                ("STEP_STUDIO_STEP_CMD".to_string(), step_command.clone()),
                ("STEP_STUDIO_RUNTIME_CMD".to_string(), step_command),
                // Resume the previous session: the shell rebuilds the view from
                // the transcript once it is ready.
                ("STEP_STUDIO_SESSION".to_string(), "continue".to_string()),
            ],
            // The shell launches the adapter, so it owns the token file.
            token: None,
            // Prefer the native Rust runtime: it is 1 MB against the Node
            // adapter's 64 MB, and speaks the same protocol. Fall back to the
            // TypeScript adapter when the binary has not been built.
            command: native_runtime_command(&repo_root),
        };

        // Name what actually runs: `command` wins over the Node script, and the
        // script path alone reads as if the native binary were ignored.
        let launched = if launch.command.is_empty() {
            format!("node {}", launch.adapter_script)
        } else {
            launch.command.join(" ")
        };
        trace(&format!("launching adapter: {launched}"));
        let session = match BridgeSession::connect(&launch) {
            Ok(session) => Arc::new(session),
            Err(error) => {
                trace(&format!("connect failed: {error}"));
                let _ = to_ui.send(Event::Disconnected(error.to_string()));
                return;
            }
        };
        trace(&format!("connected, epoch={}", session.epoch()));

        // The first snapshot establishes the session identity and the model in
        // play; without it the UI has nothing to render a header from.
        trace("requesting snapshot");
        let (session_id, model) = match session.snapshot() {
            Ok(snapshot) => {
                trace("snapshot ok");
                (
                    pointer_str(&snapshot, "/snapshot/sessionId").unwrap_or_default(),
                    pointer_str(&snapshot, "/snapshot/model/selector"),
                )
            }
            Err(error) => {
                trace(&format!("snapshot failed: {error}"));
                let _ = to_ui.send(Event::Disconnected(error.to_string()));
                return;
            }
        };
        trace(&format!("ready, session={session_id}"));
        let _ = to_ui.send(Event::Ready { session_id, model });
        let _ = refresh_models(&session, &to_ui);

        // A resumed session already has a history, and the runtime is the only
        // place it lives: without this the conversation reappears empty.
        // Answered either way: the app is waiting on this to stop the frame
        // loop, so a failure has to release it too.
        let items = match session.invoke(serde_json::json!({ "kind": "session.transcript.read" })) {
            Ok((page, _)) => page
                .pointer("/result/items")
                .and_then(|items| items.as_array())
                .cloned()
                .unwrap_or_default(),
            Err(error) => {
                trace(&format!("transcript failed: {error}"));
                Vec::new()
            }
        };
        trace(&format!("transcript: {} items", items.len()));
        let _ = to_ui.send(Event::Transcript { items });

        while let Ok(command) = from_ui.recv() {
            match command {
                Command::Prompt(text) => {
                    // The turn runs on its own thread. It would otherwise hold
                    // this loop for its whole length, and an abort queued behind
                    // it would arrive only after the turn was already over.
                    let session = Arc::clone(&session);
                    let to_ui = to_ui.clone();
                    thread::spawn(move || {
                        if let Err(error) = run_turn(&session, &to_ui, &text) {
                            let _ = to_ui.send(Event::TurnFailed(error.to_string()));
                        }
                    });
                }
                Command::Abort => {
                    let session = Arc::clone(&session);
                    thread::spawn(move || {
                        // The adapter settles the pending prompt itself, so
                        // there is nothing to relay here.
                        let _ = session.invoke(serde_json::json!({ "kind": "core.abort" }));
                    });
                }
                Command::SetModel(selector) => {
                    // The Studio operation takes the canonical `provider/id`
                    // selector; the adapter resolves it against its catalog.
                    match session.invoke(serde_json::json!({
                        "kind": "session.model.set",
                        "selector": selector,
                    })) {
                        Ok(_) => {
                            if let Ok(snapshot) = session.snapshot() {
                                let _ = to_ui.send(Event::Ready {
                                    session_id: pointer_str(&snapshot, "/snapshot/sessionId")
                                        .unwrap_or_default(),
                                    model: pointer_str(&snapshot, "/snapshot/model/selector"),
                                });
                            }
                        }
                        Err(error) => {
                            let _ = to_ui.send(Event::TurnFailed(error.to_string()));
                        }
                    }
                }
                Command::RefreshModels => {
                    let _ = refresh_models(&session, &to_ui);
                }
                Command::NewSession => {
                    // The adapter resets its own mapping state, so the only
                    // thing to relay is the new session identity.
                    trace("new session requested");
                    let session = Arc::clone(&session);
                    let to_ui = to_ui.clone();
                    thread::spawn(move || {
                        match session.invoke(serde_json::json!({ "kind": "session.new" })) {
                            Ok((receipt, _)) => {
                                trace(&format!("new session receipt: {}", pointer_str(&receipt, "/status").unwrap_or_default()));
                                if let Ok(snapshot) = session.snapshot() {
                                    let id = pointer_str(&snapshot, "/snapshot/sessionId").unwrap_or_default();
                                    trace(&format!("new session id: {id}"));
                                    let _ = to_ui.send(Event::NewSession { session_id: id });
                                } else {
                                    trace("new session: snapshot failed");
                                }
                            }
                            Err(error) => {
                                trace(&format!("new session failed: {error}"));
                                let _ = to_ui.send(Event::TurnFailed(error.to_string()));
                            }
                        }
                    });
                }
            }
        }
    });

    (to_bridge, from_bridge)
}

fn refresh_models(
    session: &BridgeSession,
    to_ui: &Sender<Event>,
) -> Result<(), step_studio_bridge::BridgeError> {
    let (receipt, _) = session.invoke(serde_json::json!({ "kind": "session.models.list" }))?;
    let models = receipt
        .pointer("/result/models")
        .and_then(|m| m.as_array())
        .map(|list| {
            list.iter()
                .map(|entry| ModelRecord {
                    selector: pointer_str(entry, "/selector").unwrap_or_default(),
                    name: pointer_str(entry, "/name").unwrap_or_else(|| {
                        pointer_str(entry, "/id").unwrap_or_default()
                    }),
                    reasoning: entry.get("reasoning").and_then(|r| r.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let _ = to_ui.send(Event::Models(models));
    Ok(())
}

/// Run one turn, streaming events as they arrive.
fn run_turn(
    session: &BridgeSession,
    to_ui: &Sender<Event>,
    text: &str,
) -> Result<(), step_studio_bridge::BridgeError> {
    // Stream: each event reaches the UI as it arrives, so the answer types out
    // instead of appearing whole once the turn is over.
    let receipt = session.invoke_with(serde_json::json!({
        "kind": "core.prompt",
        "text": text,
    }), |event| dispatch(to_ui, event))?;

    match receipt.get("status").and_then(|s| s.as_str()) {
        Some("completed") => {
            let _ = to_ui.send(Event::TurnCompleted);
            Ok(())
        }
        _ => {
            let message = receipt
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("turn failed")
                .to_string();
            let _ = to_ui.send(Event::TurnFailed(message));
            Ok(())
        }
    }
}

/// Map one Studio conversation event onto the UI's event stream.
fn dispatch(to_ui: &Sender<Event>, event: &serde_json::Value) {
    match event.get("kind").and_then(|k| k.as_str()) {
        Some("conversation.message.delta") => {
            let delta = pointer_str(event, "/delta").unwrap_or_default();
            if delta.is_empty() {
                return;
            }
            let kind = if pointer_str(event, "/blockType").as_deref() == Some("thinking") {
                Event::Thinking(delta)
            } else {
                Event::Text(delta)
            };
            let _ = to_ui.send(kind);
        }
        Some("conversation.tool.started") => {
            let _ = to_ui.send(Event::ToolStarted {
                call_id: pointer_str(event, "/toolCallId").unwrap_or_default(),
                name: pointer_str(event, "/toolName").unwrap_or_default(),
            });
        }
        Some("conversation.tool.completed") => {
            let _ = to_ui.send(Event::ToolCompleted {
                call_id: pointer_str(event, "/result/toolCallId").unwrap_or_default(),
                output: pointer_str(event, "/result/output").unwrap_or_default(),
                is_error: event
                    .pointer("/result/isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
        _ => {}
    }
}

fn pointer_str(value: &serde_json::Value, pointer: &str) -> Option<String> {
    value.pointer(pointer).and_then(|v| v.as_str()).map(|s| s.to_string())
}
