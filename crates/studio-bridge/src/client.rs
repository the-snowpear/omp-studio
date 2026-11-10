//! A connected Studio Bridge session: handshake done, commands and events
//! flowing. The shell drives this from a background thread.

use std::io::{BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
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

/// One live session. Owns the socket and the adapter child process.
pub struct BridgeSession {
    child: Option<Child>,
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    epoch: u64,
    instance_id: String,
    request_seq: u64,
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
            .set_read_timeout(Some(Duration::from_secs(120)))
            .map_err(|e| BridgeError::Io(e.to_string()))?;
        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| BridgeError::Io(e.to_string()))?,
        );

        // Handshake. The challenge is ours; the runtime must prove it holds the
        // token before anything else is trusted.
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

        Ok(Self {
            child,
            stream,
            reader,
            epoch: verified.runtime_epoch,
            instance_id: verified.runtime_instance_id,
            request_seq: 0,
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
    pub fn snapshot(&mut self) -> Result<Value, BridgeError> {
        let request_id = self.next_request_id();
        let request = json!({
            "type": "studio.request",
            "requestId": request_id,
            "runtimeEpoch": self.epoch,
            "operation": { "kind": "runtime.snapshot" },
        });
        write_frame(&mut self.stream, self.epoch, &request)?;
        loop {
            let frame = self.next_frame()?;
            if frame.body.get("type") == Some(&json!("studio.snapshot"))
                && frame.body.get("requestId") == Some(&json!(request_id))
            {
                return Ok(frame.body);
            }
        }
    }

    /// Run a command and collect events until its terminal receipt.
    pub fn invoke(&mut self, operation: Value) -> Result<(Value, Vec<Value>), BridgeError> {
        let request_id = self.next_request_id();
        let request = json!({
            "type": "studio.request",
            "requestId": request_id,
            "runtimeEpoch": self.epoch,
            "operation": operation,
        });
        write_frame(&mut self.stream, self.epoch, &request)?;
        let mut events = Vec::new();
        loop {
            let frame = self.next_frame()?;
            match frame.body.get("type").and_then(|t| t.as_str()) {
                Some("studio.event") => events.push(
                    frame
                        .body
                        .get("event")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                Some("studio.receipt")
                    if frame.body.get("requestId") == Some(&json!(request_id))
                        && is_terminal(frame.body.get("status").and_then(|s| s.as_str())) =>
                {
                    return Ok((frame.body, events));
                }
                _ => {}
            }
        }
    }

    /// Read one frame. Used by the streaming loop after a command returns.
    pub fn next_frame(&mut self) -> Result<crate::frame::DecodedFrame, BridgeError> {
        read_frame(&mut self.reader)?
            .ok_or_else(|| BridgeError::Protocol("adapter closed the connection".to_string()))
    }

    fn next_request_id(&mut self) -> String {
        self.request_seq += 1;
        format!("shell-req-{}", self.request_seq)
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
        let _ = write_frame(&mut self.stream, self.epoch, &request);
        let _ = self.stream.flush();
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
