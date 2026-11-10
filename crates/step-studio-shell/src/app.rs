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
    to_bridge: Option<std::sync::mpsc::Sender<Command>>,
    from_bridge: Option<Receiver<Event>>,
}

impl App {
    /// Build the app and start the bridge thread.
    pub fn connect(repo_root: PathBuf, step_command: String) -> Self {
        let cwd = std::env::temp_dir().join(format!("step-studio-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&cwd);
        let (to_bridge, from_bridge) =
            crate::bridge_client::spawn(repo_root.clone(), cwd, step_command.clone());
        Self {
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
            Event::Models(models) => self.models = models,
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
            Event::TurnCompleted => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.done = true;
                }
            }
            Event::TurnFailed(message) => {
                self.status = Status::Failed;
                self.status_detail = message.clone();
                if let Some(turn) = self.turns.last_mut() {
                    turn.assistant.done = true;
                    turn.assistant.error = Some(message);
                }
            }
            Event::Disconnected(detail) => {
                self.status = Status::Failed;
                self.status_detail = detail;
            }
        }
    }

    pub fn send(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        self.turns.push(Turn {
            user: text.clone(),
            assistant: AssistantTurn::default(),
        });
        if let Some(sender) = self.to_bridge.as_ref() {
            let _ = sender.send(Command::Prompt(text));
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
        if let Some(sender) = self.to_bridge.as_ref() {
            let _ = sender.send(Command::SetModel(selector));
        }
    }

    /// The turn currently streaming, if any.
    pub fn streaming(&self) -> bool {
        self.turns.last().map(|turn| !turn.assistant.done).unwrap_or(false)
    }
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
