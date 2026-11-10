//! JSONL client for `step --mode rpc --include-live-events`.
//!
//! Requests are one JSON object per line on stdin, correlated by `id`.
//! Responses carry that id back; everything else on stdout is an event.
//! The split matters: a response settles a request, an event does not, and
//! conflating them drops turns.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Opt-in diagnostics, so a non-interactive run stays quiet by default.
fn trace(message: &str) {
    if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
        eprintln!("[step-rpc] {message}");
    }
}

#[derive(Debug)]
pub enum StepError {
    Spawn(String),
    Closed(String),
    TimedOut(String),
    Response { command: String, message: String },
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(d) => write!(f, "could not start step: {d}"),
            Self::Closed(d) => write!(f, "step closed the connection: {d}"),
            Self::TimedOut(what) => write!(f, "timed out waiting for {what}"),
            Self::Response { command, message } => write!(f, "{command} failed: {message}"),
        }
    }
}

impl std::error::Error for StepError {}

/// How to launch the CLI.
pub struct StepLaunch {
    pub command: String,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    /// Pick the previous session back up instead of starting a fresh one, so a
    /// relaunch continues the conversation rather than losing it.
    pub continue_session: bool,
}

/// A running Step CLI plus the channels to talk to it.
pub struct StepRpc {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<Value>,
    pending: VecDeque<Value>,
    seq: u64,
    exited: bool,
}

impl StepRpc {
    pub fn spawn(launch: &StepLaunch) -> Result<Self, StepError> {
        // The CLI reads commands from stdin and writes frames to stdout, so
        // both must be pipes; stderr is inherited so its diagnostics surface.
        let mut command = Command::new(&launch.command);
        command
            .arg("--mode")
            .arg("rpc")
            .arg("--include-live-events");
        if launch.continue_session {
            command.arg("--continue");
        }
        command.current_dir(&launch.cwd);
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| StepError::Spawn(e.to_string()))?;

        let stdin = child.stdin.take().ok_or_else(|| StepError::Spawn("no stdin pipe".to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| StepError::Spawn("no stdout pipe".to_string()))?;

        // A reader thread owns stdout so the connection handler never blocks on
        // the CLI while it is supposed to be serving the Host.
        let (sender, events) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            // Non-JSON stdout is diagnostic noise, not a frame.
                            Ok(value) => {
                                if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                                    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                                    let extra = if kind == "extension_ui_request" {
                                        format!(" method={} key={}", value.get("method").and_then(|v| v.as_str()).unwrap_or("?"), value.get("statusKey").and_then(|v| v.as_str()).unwrap_or("?"))
                                    } else { String::new() };
                                    eprintln!("[step-rpc] line {kind}{extra}");
                                }
                                if sender.send(value).is_err() {
                                    return;
                                }
                            }
                            Err(_) => {
                                if std::env::var_os("STEP_STUDIO_TRACE").is_some() {
                                    eprintln!("[step-rpc] non-json line: {}", trimmed.chars().take(120).collect::<String>());
                                }
                                continue;
                            }
                        }
                    }
                    Err(error) => {
                        trace(&format!("reader thread exiting: {error}"));
                        return;
                    }
                }
            }
            trace("reader thread: stdout closed");
        });

        Ok(Self {
            child,
            stdin,
            events,
            pending: VecDeque::new(),
            seq: 0,
            exited: false,
        })
    }

    /// Send a request and wait for its response. Events that arrive first are
    /// buffered so the caller can drain them afterwards.
    pub fn request(&mut self, kind: &str, payload: Value, timeout: Duration) -> Result<Value, StepError> {
        if self.exited {
            return Err(StepError::Closed("process has exited".to_string()));
        }
        self.seq += 1;
        let id = format!("rust-{}", self.seq);
        let mut request = payload;
        if let Value::Object(ref mut map) = request {
            map.insert("id".to_string(), json!(id));
            map.insert("type".to_string(), json!(kind));
        }
        self.write(&request)?;

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(StepError::TimedOut(kind.to_string()));
            }
            match self.events.recv_timeout(remaining) {
                Ok(message) => {
                    if message.get("type") == Some(&json!("response"))
                        && message.get("id") == Some(&json!(id))
                    {
                        if message.get("success") == Some(&json!(false)) {
                            let detail = message
                                .get("error")
                                .and_then(|e| e.as_str())
                                .unwrap_or("unknown error")
                                .to_string();
                            return Err(StepError::Response {
                                command: kind.to_string(),
                                message: detail,
                            });
                        }
                        return Ok(message.get("data").cloned().unwrap_or(Value::Null));
                    }
                    self.pending.push_back(message);
                }
                Err(_) => {
                    self.exited = true;
                    return Err(StepError::TimedOut(kind.to_string()));
                }
            }
        }
    }

    /// Fire a request without waiting for its response.
    pub fn send(&mut self, kind: &str, payload: Value) -> Result<(), StepError> {
        if self.exited {
            return Err(StepError::Closed("process has exited".to_string()));
        }
        self.seq += 1;
        let id = format!("rust-{}", self.seq);
        let mut request = payload;
        if let Value::Object(ref mut map) = request {
            map.insert("id".to_string(), json!(id));
            map.insert("type".to_string(), json!(kind));
        }
        self.write(&request)
    }

    /// Next buffered event, if any. Events buffered while a request was in
    /// flight are replayed here in arrival order.
    pub fn next_event(&mut self) -> Option<Value> {
        if let Some(event) = self.pending.pop_front() {
            return Some(event);
        }
        self.events.recv_timeout(Duration::ZERO).ok()
    }

    /// Block until the next event arrives, or the CLI goes away.
    pub fn wait_event(&mut self, timeout: Duration) -> Option<Value> {
        if let Some(event) = self.pending.pop_front() {
            return Some(event);
        }
        self.events.recv_timeout(timeout).ok()
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.exited = true;
    }

    fn write(&mut self, value: &Value) -> Result<(), StepError> {
        let line = serde_json::to_string(value).map_err(|e| StepError::Closed(e.to_string()))?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| StepError::Closed(e.to_string()))
    }
}

impl Drop for StepRpc {
    fn drop(&mut self) {
        self.kill();
    }
}
