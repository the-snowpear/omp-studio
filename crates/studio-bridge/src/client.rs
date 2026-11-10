//! A connected Studio Bridge session: handshake done, commands and events
//! flowing. The shell drives this from a background thread.

use std::collections::VecDeque;
use std::io::{BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::frame::{read_frame, write_frame, FrameError};
use crate::handshake::{verify_hello, PROTOCOL_VERSION};

/// Receipt statuses that settle a command.
pub const TERMINAL_STATUSES: [&str; 4] = ["completed", "failed", "rejected", "outcome_unknown"];

#[derive(Debug)]
pub enum BridgeError {
    Io(String),
    Protocol(String),
    Rejected { code: String, message: String },
    TimedOut(String),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(d) => write!(f, "io: {d}"),
            Self::Protocol(d) => write!(f, "protocol: {d}"),
            Self::Rejected { code, message } => write!(f, "{code}: {message}"),
            Self::TimedOut(what) => write!(f, "timed out waiting for {what}"),
        }
    }
}

impl std::error::Error for BridgeError {}

impl From<FrameError> for BridgeError {
    fn from(error: FrameError) -> Self {
        Self::Protocol(error.to_string())
    }
}

/// Frames the reader thread has taken off the socket, waiting for whoever
/// asked for them.
#[derive(Default)]
struct Inbox {
    /// `studio.event` payloads, in arrival order. Events carry no requestId —
    /// the protocol broadcasts them on the connection — so this is one stream
    /// shared by every in-flight command. See [`BridgeSession::invoke_with`].
    events: VecDeque<Value>,
    /// `studio.snapshot` and terminal `studio.receipt` bodies, by requestId.
    replies: Vec<(String, Value)>,
    /// Why the connection ended, once it does.
    closed: Option<String>,
}

/// The reader thread's output plus the condvar waiters park on.
#[derive(Default)]
struct Shared {
    inbox: Mutex<Inbox>,
    ready: Condvar,
}

impl Shared {
    /// A poisoned mutex still holds valid state, and a stalled reader must not
    /// take the whole session down with it.
    fn lock_inbox(&self) -> std::sync::MutexGuard<'_, Inbox> {
        self.inbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn close(&self, reason: String) {
        self.lock_inbox().closed = Some(reason);
        self.ready.notify_all();
    }
}

/// One live session. Owns the socket and the adapter child process.
///
/// Every method takes `&self`, so a session behind an `Arc` can serve a
/// streaming command and a control command at once — which is what makes
/// aborting a turn possible.
pub struct BridgeSession {
    child: Option<Child>,
    /// Only the write half is used here; the read half belongs to the reader
    /// thread. A mutex, because two commands may write concurrently.
    stream: Mutex<UnixStream>,
    shared: Arc<Shared>,
    epoch: u64,
    instance_id: String,
    request_seq: AtomicU64,
}

/// Where the adapter lives and how to launch it.
pub struct AdapterLaunch {
    pub node: String,
    pub adapter_script: String,
    pub socket_path: String,
    pub token_file: String,
    pub cwd: String,
    pub runtime_epoch: u64,
    /// Extra environment for the adapter, e.g. `STEP_STUDIO_RUNTIME_CMD`.
    pub env: Vec<(String, String)>,
    /// The bridge token, when the peer already holds it. Set this and
    /// `token_file` may be empty: the session writes the file only when it is
    /// the one launching the runtime.
    pub token: Option<String>,
    /// Full command to run instead of `node <adapter_script>`. Used when the
    /// runtime is a native binary rather than a Node script.
    pub command: Vec<String>,
}

impl BridgeSession {
    /// Launch the adapter, wait for its socket, and complete the handshake.
    pub fn connect(launch: &AdapterLaunch) -> Result<Self, BridgeError> {
        let token = match launch.token.clone() {
            Some(token) => token,
            None => {
                std::fs::write(&launch.token_file, "step-studio")
                    .map_err(|e| BridgeError::Io(format!("token file: {e}")))?;
                "step-studio".to_string()
            }
        };

        // An empty `node` means the peer is already running and this session is
        // only a client — used when the runtime under test is not one we spawn.
        let child = if launch.node.is_empty() {
            None
        } else {
            let _ = std::fs::remove_file(&launch.socket_path);
            Some(Self::spawn(launch)?)
        };
        let stream = wait_for_socket(&launch.socket_path, Duration::from_secs(20))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(300)))
            .map_err(|e| BridgeError::Io(e.to_string()))?;

        // Handshake. The challenge is ours; the runtime must prove it holds the
        // token before anything else is trusted. This frame is read directly,
        // before the reader thread exists, so exactly one owner touches the
        // socket at a time.
        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| BridgeError::Io(e.to_string()))?,
        );
        let challenge = format!("shell-{}", launch.runtime_epoch);
        let hello = json!({
            "type": "studio.hello",
            "requestId": "shell-hello",
            "supportedProtocolVersions": [PROTOCOL_VERSION],
            "requiredProfile": "limited",
            "challenge": challenge,
        });
        write_frame(&mut (&stream), 1, &hello)?;
        let frame = read_frame(&mut reader)?
            .ok_or_else(|| BridgeError::Protocol("adapter closed before hello".to_string()))?;
        let verified = verify_hello(&frame.body, &token, &challenge).map_err(BridgeError::Protocol)?;

        // From here on a reader thread owns the socket: it demultiplexes
        // frames into the shared inbox and wakes whoever is waiting.
        let shared = Arc::new(Shared::default());
        let reader_stream = stream
            .try_clone()
            .map_err(|e| BridgeError::Io(e.to_string()))?;
        spawn_reader(reader_stream, Arc::clone(&shared));

        Ok(Self {
            child,
            stream: Mutex::new(stream),
            shared,
            epoch: verified.runtime_epoch,
            instance_id: verified.runtime_instance_id,
            request_seq: AtomicU64::new(0),
        })
    }

    /// Launch the adapter process. Separated so a client-only session can skip
    /// it entirely.
    fn spawn(launch: &AdapterLaunch) -> Result<Child, BridgeError> {
        let mut command = if launch.command.is_empty() {
            let mut command = Command::new(&launch.node);
            command.arg(&launch.adapter_script);
            command
        } else {
            let mut parts = launch.command.iter();
            let mut command = Command::new(parts.next().expect("command is non-empty"));
            for arg in parts {
                command.arg(arg);
            }
            command
        };
        command
            .arg("--mode")
            .arg("studio-host")
            .arg("--bridge-endpoint")
            .arg(&launch.socket_path)
            .arg("--bridge-token-file")
            .arg(&launch.token_file)
            .arg("--bridge-runtime-epoch")
            .arg(launch.runtime_epoch.to_string())
            .arg("--cwd")
            .arg(&launch.cwd);
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        command
            .stdout(std::process::Stdio::null())
            .spawn()
            .map_err(|e| BridgeError::Io(format!("spawn adapter: {e}")))
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// The snapshot is a query: it answers with a `studio.snapshot` frame.
    pub fn snapshot(&self) -> Result<Value, BridgeError> {
        let request_id = self.next_request_id();
        self.send(&json!({
            "type": "studio.request",
            "requestId": request_id,
            "runtimeEpoch": self.epoch,
            "operation": { "kind": "runtime.snapshot" },
        }))?;
        self.await_reply(&request_id, |_| {})
    }

    /// Run a command and collect events until its terminal receipt.
    ///
    /// Every event is buffered, so the caller sees the turn only once it is
    /// over. Use [`BridgeSession::invoke_with`] when the consumer can render as
    /// events arrive.
    pub fn invoke(&self, operation: Value) -> Result<(Value, Vec<Value>), BridgeError> {
        let mut events = Vec::new();
        let receipt = self.invoke_with(operation, |event| events.push(event.clone()))?;
        Ok((receipt, events))
    }

    /// Run a command, handing each event to `on_event` the moment it arrives,
    /// and return the terminal receipt.
    ///
    /// Streaming is not cosmetic: a turn takes seconds, and buffering means the
    /// UI shows nothing for all of them and then the whole answer at once.
    ///
    /// Events are broadcast, not addressed, so **at most one event-consuming
    /// command may be in flight** on a session — otherwise two waiters split
    /// one stream between them. Control commands (`core.abort`,
    /// `session.model.set`) emit no events and are exempt.
    pub fn invoke_with(
        &self,
        operation: Value,
        on_event: impl FnMut(&Value),
    ) -> Result<Value, BridgeError> {
        let request_id = self.next_request_id();
        self.send(&json!({
            "type": "studio.request",
            "requestId": request_id,
            "runtimeEpoch": self.epoch,
            "operation": operation,
        }))?;
        self.await_reply(&request_id, on_event)
    }

    /// Write one frame. Locked, because a control command and a turn can be in
    /// flight together.
    fn send(&self, body: &Value) -> Result<(), BridgeError> {
        let mut stream = self
            .stream
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        write_frame(&mut *stream, self.epoch, body).map_err(BridgeError::from)
    }

    /// Block until the reply to `request_id` lands, handing over every event
    /// that arrives on the way. Events are drained before the reply is taken,
    /// so nothing that preceded it is dropped.
    fn await_reply(
        &self,
        request_id: &str,
        mut on_event: impl FnMut(&Value),
    ) -> Result<Value, BridgeError> {
        let mut inbox = self.shared.lock_inbox();
        loop {
            // Deliver outside the lock: a slow consumer must not stall the
            // reader thread for every other waiter.
            let batch: Vec<Value> = inbox.events.drain(..).collect();
            if !batch.is_empty() {
                drop(inbox);
                for event in &batch {
                    on_event(event);
                }
                inbox = self.shared.lock_inbox();
            }
            if let Some(index) = inbox.replies.iter().position(|(id, _)| id == request_id) {
                return Ok(inbox.replies.remove(index).1);
            }
            // The reply is checked first: a connection can close with the
            // answer still sitting in the inbox.
            if let Some(reason) = inbox.closed.clone() {
                return Err(BridgeError::Protocol(reason));
            }
            inbox = self
                .shared
                .ready
                .wait(inbox)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn next_request_id(&self) -> String {
        let seq = self.request_seq.fetch_add(1, Ordering::Relaxed) + 1;
        format!("shell-req-{seq}")
    }
}

impl Drop for BridgeSession {
    fn drop(&mut self) {
        // Ask the runtime to shut down cleanly, then make sure it is gone.
        let request = json!({
            "type": "studio.request",
            "requestId": "shell-shutdown",
            "runtimeEpoch": self.epoch,
            "operation": { "kind": "runtime.shutdown", "drain": true },
        });
        let _ = self.send(&request);
        let mut stream = self
            .stream
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = stream.flush();
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Own the read half of the socket and file every frame into the shared inbox.
fn spawn_reader(stream: UnixStream, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(frame)) => {
                    let body = frame.body;
                    let kind = body.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let request_id = body
                        .get("requestId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let mut inbox = shared.lock_inbox();
                    match kind {
                        "studio.event" => inbox.events.push_back(
                            body.get("event").cloned().unwrap_or(Value::Null),
                        ),
                        // `accepted` is not terminal, so it is dropped here
                        // rather than settling a waiter early.
                        "studio.snapshot" if !request_id.is_empty() => {
                            inbox.replies.push((request_id, body));
                        }
                        "studio.receipt"
                            if !request_id.is_empty()
                                && is_terminal(body.get("status").and_then(|s| s.as_str())) =>
                        {
                            inbox.replies.push((request_id, body));
                        }
                        _ => {}
                    }
                    drop(inbox);
                    shared.ready.notify_all();
                }
                Ok(None) => {
                    shared.close("adapter closed the connection".to_string());
                    return;
                }
                Err(error) => {
                    shared.close(error.to_string());
                    return;
                }
            }
        }
    });
}

/// Poll for the socket file; the adapter creates it after binding.
fn wait_for_socket(path: &str, timeout: Duration) -> Result<UnixStream, BridgeError> {
    let deadline = Instant::now() + timeout;
    loop {
        if std::path::Path::new(path).exists() {
            if let Ok(stream) = UnixStream::connect(path) {
                return Ok(stream);
            }
        }
        if Instant::now() >= deadline {
            return Err(BridgeError::TimedOut("adapter socket".to_string()));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn is_terminal(status: Option<&str>) -> bool {
    matches!(status, Some(s) if TERMINAL_STATUSES.contains(&s))
}
