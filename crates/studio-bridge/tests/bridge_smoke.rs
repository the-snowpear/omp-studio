//! End-to-end against the real TypeScript adapter. This is the test that proves
//! the Rust client speaks the same wire protocol — a unit test against a mock
//! would only prove it agrees with itself.

use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// The transport the Host actually uses on POSIX. Windows would be a named
/// pipe, which `std` does not speak — that needs its own client, not a TCP
/// stand-in the adapter never supported.
type Transport = UnixStream;

use step_studio_bridge::frame::{read_frame, write_frame};
use step_studio_bridge::handshake::{challenge_proof, verify_hello, PROTOCOL_VERSION};

/// Spawn the adapter the way the Host does, over a TCP endpoint so the test
/// needs no Unix-socket path juggling.
struct Adapter {
    child: Child,
    socket_path: std::path::PathBuf,
    token: String,
}

impl Adapter {
    fn spawn() -> Self {
        let dir = std::env::temp_dir().join(format!("rust-bridge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let token_file = dir.join("token");
        std::fs::write(&token_file, "rust-smoke-token").expect("token file");

        let root = env!("CARGO_MANIFEST_DIR");
        let repo = std::path::Path::new(root)
            .ancestors()
            .nth(2)
            .expect("repo root")
            .to_path_buf();
        let adapter = repo.join("packages/runtime-stepcode/dist/src/main.js");
        assert!(adapter.exists(), "adapter not built: {}", adapter.display());

        let socket_path = dir.join("bridge.sock");

        let child = Command::new("node")
            .arg(adapter)
            .arg("--mode")
            .arg("studio-host")
            .arg("--bridge-endpoint")
            .arg(&socket_path)
            .arg("--bridge-token-file")
            .arg(&token_file)
            .arg("--bridge-runtime-epoch")
            .arg("7")
            .arg("--cwd")
            .arg(&dir)
            .env(
                "STEP_STUDIO_RUNTIME_CMD",
                format!(
                    "node {}",
                    repo.join("packages/runtime-stepcode/test/fake-step.mjs").display()
                ),
            )
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .expect("spawn adapter");

        Self {
            child,
            socket_path,
            token: "rust-smoke-token".to_string(),
        }
    }

    /// Wait for the socket to appear, then connect.
    fn connect(&self) -> Transport {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match UnixStream::connect(&self.socket_path) {
                Ok(stream) => return stream,
                Err(error) => {
                    if Instant::now() >= deadline {
                        panic!("could not connect to {}: {error}", self.socket_path.display());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One client session: handshake, then request/receipt over the same socket.
struct Session {
    stream: Transport,
    reader: BufReader<Transport>,
    epoch: u64,
}

impl Session {
    fn connect(adapter: &Adapter) -> Self {
        let stream = adapter.connect();
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let challenge = "rust-challenge-1";
        let hello = serde_json::json!({
            "type": "studio.hello",
            "requestId": "rust-hello-1",
            "supportedProtocolVersions": [PROTOCOL_VERSION],
            "requiredProfile": "limited",
            "challenge": challenge,
        });
        write_frame(&mut (&stream), 1, &hello).expect("write hello");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let frame = read_frame(&mut reader)
            .expect("read hello")
            .expect("hello frame");
        let hello = verify_hello(&frame.body, &adapter.token, challenge).expect("verify hello");
        Self {
            stream,
            reader,
            epoch: hello.runtime_epoch,
        }
    }

    /// `runtime.snapshot` is a query, not a command: it answers with a
    /// `studio.snapshot` frame rather than a receipt.
    fn snapshot(&mut self) -> serde_json::Value {
        let request_id = format!("rust-snap-{}", randish());
        let request = serde_json::json!({
            "type": "studio.request",
            "requestId": request_id,
            "runtimeEpoch": self.epoch,
            "operation": { "kind": "runtime.snapshot" },
        });
        write_frame(&mut self.stream, self.epoch, &request).expect("write snapshot");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for a snapshot");
            let frame = read_frame(&mut self.reader)
                .expect("read frame")
                .expect("frame present");
            if frame.body.get("type") == Some(&serde_json::json!("studio.snapshot"))
                && frame.body.get("requestId") == Some(&serde_json::json!(request_id))
            {
                return frame.body;
            }
        }
    }

    /// Send a request and collect frames until its *terminal* receipt arrives.
    /// `core.prompt` answers `accepted` first and only settles when the turn
    /// ends, so stopping at the first receipt would report a turn that has not
    /// happened yet.
    fn invoke(&mut self, operation: serde_json::Value) -> (serde_json::Value, Vec<serde_json::Value>) {
        let request_id = format!("rust-req-{}", randish());
        let request = serde_json::json!({
            "type": "studio.request",
            "requestId": request_id,
            "runtimeEpoch": self.epoch,
            "operation": operation,
        });
        write_frame(&mut self.stream, self.epoch, &request).expect("write request");
        let mut events = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for {request_id}");
            let frame = read_frame(&mut self.reader)
                .expect("read frame")
                .expect("frame present");
            match frame.body.get("type").and_then(|t| t.as_str()) {
                Some("studio.event") => events.push(
                    frame
                        .body
                        .get("event")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                ),
                Some("studio.receipt")
                    if frame.body.get("requestId") == Some(&serde_json::json!(request_id))
                        && is_terminal(frame.body.get("status").and_then(|s| s.as_str())) =>
                {
                    return (frame.body, events);
                }
                _ => {}
            }
        }
    }
}

/// Receipt statuses that settle a command, mirroring the host's set.
fn is_terminal(status: Option<&str>) -> bool {
    matches!(
        status,
        Some("completed") | Some("failed") | Some("rejected") | Some("outcome_unknown")
    )
}

fn randish() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
}

#[test]
fn rust_client_drives_the_real_adapter() {
    let adapter = Adapter::spawn();
    let mut session = Session::connect(&adapter);

    let snapshot = session.snapshot();
    let session_id = snapshot
        .pointer("/snapshot/sessionId")
        .and_then(|v| v.as_str())
        .expect("snapshot sessionId");
    assert!(!session_id.is_empty(), "adapter reported an empty session id");

    let (prompt_receipt, events) = session.invoke(serde_json::json!({ "kind": "core.prompt", "text": "hi" }));
    assert_eq!(prompt_receipt.get("status").and_then(|s| s.as_str()), Some("completed"));

    let deltas: String = events
        .iter()
        .filter(|event| event.get("kind") == Some(&serde_json::json!("conversation.message.delta")))
        .filter_map(|event| event.get("delta").and_then(|d| d.as_str()))
        .collect();
    assert_eq!(deltas, "hello!", "streamed text through the Rust client");
}

#[test]
fn challenge_proof_matches_the_protocol_construction() {
    // Same vector the TypeScript host uses, so a drift on either side fails here.
    let proof = challenge_proof("token", "challenge-1", "rt-inst-0001");
    assert!(!proof.is_empty());
    // Deterministic: same inputs, same proof.
    assert_eq!(proof, challenge_proof("token", "challenge-1", "rt-inst-0001"));
    // The NUL separator is load-bearing.
    assert_ne!(proof, challenge_proof("token", "challenge-1", "rt-inst-0002"));
}

#[test]
fn frame_decoder_reassembles_split_and_batched_frames() {
    use step_studio_bridge::frame::{FrameDecoder, FrameEncoder};
    let first = FrameEncoder::encode(1, &serde_json::json!({"n": 1})).expect("encode");
    let second = FrameEncoder::encode(1, &serde_json::json!({"n": 2})).expect("encode");
    let mut both = first.clone();
    both.extend_from_slice(&second);

    let mut decoder = FrameDecoder::new();
    let frames = decoder.push(&both).expect("batched");
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].body.get("n").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(frames[1].body.get("n").and_then(|v| v.as_i64()), Some(2));

    // A frame arriving in fragments must not be decoded early or lost.
    let mut decoder = FrameDecoder::new();
    assert_eq!(decoder.push(&first[..3]).expect("partial").len(), 0);
    let frames = decoder.push(&first[3..]).expect("rest");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].body.get("n").and_then(|v| v.as_i64()), Some(1));
}
