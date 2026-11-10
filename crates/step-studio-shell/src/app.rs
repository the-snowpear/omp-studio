//! Shell state and rendering. Deliberately free of `eframe::App` plumbing so
//! the reducer can be tested without a window.

use std::path::PathBuf;
use std::sync::mpsc::Receiver;

use eframe::egui;

use crate::bridge_client::{Command, Event, ModelRecord};

/// One streamed assistant message.
#[derive(Debug, Default, Clone)]
pub struct AssistantTurn {
    pub text: String,
    pub thinking: String,
    pub tools: Vec<ToolCall>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ToolCall {
    pub name: String,
    pub output: String,
    pub is_error: bool,
    pub done: bool,
}

/// A completed exchange.
#[derive(Debug, Clone)]
pub struct Turn {
    pub user: String,
    pub assistant: AssistantTurn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Ready,
    Failed,
}

pub struct App {
    pub status: Status,
    pub status_detail: String,
    pub session_id: String,
    pub model: Option<String>,
    pub models: Vec<ModelRecord>,
    pub turns: Vec<Turn>,
    pub composer: String,
    pub show_thinking: bool,
    /// A command is outstanding, so the bridge thread may still deliver. egui
    /// stops calling `update` once nothing asks for a repaint, which would
    /// strand every event that arrives after the app goes idle.
    busy: bool,
    to_bridge: Option<std::sync::mpsc::Sender<Command>>,
    from_bridge: Option<Receiver<Event>>,
}

impl App {
    /// Build the app and start the bridge thread.
    pub fn connect(repo_root: PathBuf, step_command: String) -> Self {
        // The repo is the agent's working directory, and it has to be stable
        // across launches: Step files sessions per project, so a per-process
        // temp dir made every launch a new project that `--continue` could
        // never find the previous session in.
        let cwd = repo_root.clone();
        let (to_bridge, from_bridge) =
            crate::bridge_client::spawn(repo_root.clone(), cwd, step_command.clone());
        Self {
            // Startup is work in flight: the snapshot, the model catalog and the
            // transcript all land after the first frame, and the loop has to
            // stay awake long enough to read them.
            busy: true,
            status: Status::Connecting,
            status_detail: "starting runtime".to_string(),
            session_id: String::new(),
            model: None,
            models: Vec::new(),
            turns: Vec::new(),
            composer: String::new(),
            show_thinking: true,
            to_bridge: Some(to_bridge),
            from_bridge: Some(from_bridge),
        }
    }

    /// Drain the bridge channel and fold each event into the state.
    /// Returns true when anything changed, so the caller can repaint.
    pub fn pump(&mut self) -> bool {
        // Take the receiver out so the loop does not hold a borrow of `self`
        // across `apply`, which needs it mutably.
        let Some(receiver) = self.from_bridge.take() else {
            return false;
        };
        let mut changed = false;
        while let Ok(event) = receiver.try_recv() {
            changed = true;
            self.apply(event);
        }
        self.from_bridge = Some(receiver);
        changed
    }

    /// Rebuild the view from a transcript page.
    ///
    /// The runtime is the source of truth for what happened, so this replaces
    /// the local turns rather than merging into them. Assistant entries append
    /// to the turn their user message opened, which is how a reply split across
    /// several entries (thinking, then text, then tools) lands in one place.
    pub fn restore(&mut self, items: &[serde_json::Value]) {
        self.turns.clear();
        for item in items {
            let role = item.get("role").and_then(|r| r.as_str()).unwrap_or("");
            let blocks = item.get("content").and_then(|c| c.as_array());
            match role {
                "user" => {
                    let text = block_text(blocks, "text");
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.turns.push(Turn {
                        user: text,
                        assistant: AssistantTurn {
                            done: true,
                            ..AssistantTurn::default()
                        },
                    });
                }
                "assistant" => {
                    // A transcript that opens with an assistant entry has no
                    // turn to attach to; dropping it is better than inventing an
                    // empty user bubble.
                    let Some(turn) = self.turns.last_mut() else {
                        continue;
                    };
                    turn.assistant.thinking.push_str(&block_text(blocks, "thinking"));
                    turn.assistant.text.push_str(&block_text(blocks, "text"));
                    for block in blocks.into_iter().flatten() {
                        if block.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                            continue;
                        }
                        turn.assistant.tools.push(ToolCall {
                            name: block
                                .get("toolName")
                                .and_then(|n| n.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            // Tool results are separate entries the transcript
                            // drops, so a restored call has no output.
                            output: String::new(),
                            is_error: false,
                            done: true,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    /// Fold one event. Pure, so it can be tested without a socket.
    pub fn apply(&mut self, event: Event) {
        match event {
            Event::Ready { session_id, model } => {
                self.status = Status::Ready;
                self.status_detail = String::new();
                if !session_id.is_empty() {
                    self.session_id = session_id;
                }
                if model.is_some() {
                    self.model = model;
                }
            }
            Event::Models(models) => {
                self.busy = false;
                self.models = models;
            }
            Event::Thinking(delta) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.thinking.push_str(&delta);
                }
            }
            Event::Text(delta) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.text.push_str(&delta);
                }
            }
            Event::ToolStarted { name } => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.tools.push(ToolCall {
                        name,
                        output: String::new(),
                        is_error: false,
                        done: false,
                    });
                }
            }
            Event::ToolCompleted { name, output, is_error } => {
                if let Some(turn) = self.turns.last_mut() {
                    // Match the oldest unfinished call of this name: a turn can
                    // run the same tool more than once.
                    if let Some(tool) = turn
                        .assistant
                        .tools
                        .iter_mut()
                        .find(|tool| !tool.done && tool.name == name)
                    {
                        tool.output = output;
                        tool.is_error = is_error;
                        tool.done = true;
                    }
                }
            }
            Event::Transcript { items } => {
                self.busy = false;
                self.restore(&items);
            }
            Event::NewSession { session_id } => {
                self.busy = false;
                // The runtime dropped the transcript, so the local copy of it
                // has to go too: leaving it would show a conversation the
                // runtime no longer has.
                self.turns.clear();
                self.composer.clear();
                if !session_id.is_empty() {
                    self.session_id = session_id;
                }
                self.status = Status::Ready;
                self.status_detail = String::new();
            }
            Event::TurnCompleted => {
                self.busy = false;
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.done = true;
                }
            }
            Event::TurnFailed(message) => {
                self.busy = false;
                self.status = Status::Failed;
                self.status_detail = message.clone();
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.done = true;
                    turn.assistant.error = Some(message);
                }
            }
            Event::Disconnected(detail) => {
                self.busy = false;
                self.status = Status::Failed;
                self.status_detail = detail;
            }
        }
    }

    pub fn send(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        self.busy = true;
        self.turns.push(Turn {
            user: text.clone(),
            assistant: AssistantTurn::default(),
        });
        if let Some(sender) = self.to_bridge.as_ref() {
            let _ = sender.send(Command::Prompt(text));
        }
    }

    /// Drop the transcript and start a fresh session.
    pub fn new_session(&mut self) {
        self.busy = true;
        if let Some(sender) = self.to_bridge.as_ref() {
            let _ = sender.send(Command::NewSession);
        }
    }

    /// Stop the running turn. The runtime settles the prompt itself, so the
    /// turn thread reports the outcome; nothing here waits for it.
    pub fn abort(&mut self) {
        if let Some(sender) = self.to_bridge.as_ref() {
            let _ = sender.send(Command::Abort);
        }
    }

    pub fn set_model(&mut self, selector: String) {
        self.busy = true;
        if let Some(sender) = self.to_bridge.as_ref() {
            let _ = sender.send(Command::SetModel(selector));
        }
    }

    /// True while a command is outstanding, so the frame loop must keep
    /// running. See the field.
    pub fn busy(&self) -> bool {
        self.busy
    }

    /// The turn currently streaming, if any.
    pub fn streaming(&self) -> bool {
        self.turns.last().map(|turn| !turn.assistant.done).unwrap_or(false)
    }
}

/// Concatenated text of every block of one type in a Studio content array.
fn block_text(blocks: Option<&Vec<serde_json::Value>>, kind: &str) -> String {
    blocks
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some(kind))
        .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
        .collect()
}

/// State without a bridge thread, for reducer tests.
pub fn app_for_test() -> App {
    App {
        status: Status::Connecting,
        status_detail: String::new(),
        session_id: String::new(),
        model: None,
        models: Vec::new(),
        turns: Vec::new(),
        composer: String::new(),
        show_thinking: true,
        busy: false,
        to_bridge: None,
        from_bridge: None,
    }
}

impl Default for App {
    fn default() -> Self {
        Self::connect(PathBuf::from("."), "step".to_string())
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.pump() || self.streaming() {
            ctx.request_repaint();
        }
        self.render_chrome(ctx);
        self.render_conversation(ctx);
        self.render_composer(ctx);
    }
}
