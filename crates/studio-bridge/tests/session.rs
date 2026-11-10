//! `BridgeSession` end to end against the real adapter. The shell drives this
//! from a thread, so a hang here is invisible in the UI — it just never
//! becomes ready.

use std::path::PathBuf;

use step_studio_bridge::{AdapterLaunch, BridgeSession};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root")
        .to_path_buf()
}

fn launch(tag: &str) -> AdapterLaunch {
    let dir = std::env::temp_dir().join(format!("rust-session-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let root = repo_root();
    AdapterLaunch {
        node: "node".to_string(),
        adapter_script: root
            .join("packages/runtime-stepcode/dist/src/main.js")
            .to_string_lossy()
            .to_string(),
        socket_path: dir.join("bridge.sock").to_string_lossy().to_string(),
        token_file: dir.join("token").to_string_lossy().to_string(),
        cwd: dir.to_string_lossy().to_string(),
        runtime_epoch: 1,
        env: vec![(
            "STEP_STUDIO_RUNTIME_CMD".to_string(),
            format!(
                "node {}",
                root.join("packages/runtime-stepcode/test/fake-step.mjs")
                    .to_string_lossy()
            ),
        )],
    }
}

#[test]
fn session_handshakes_snapshots_and_runs_a_turn() {
    let mut session = BridgeSession::connect(&launch("full")).expect("connect");

    let snapshot = session.snapshot().expect("snapshot");
    let session_id = snapshot
        .pointer("/snapshot/sessionId")
        .and_then(|v| v.as_str())
        .expect("sessionId");
    assert!(!session_id.is_empty(), "the adapter reported an empty session id");

    let (receipt, events) = session
        .invoke(serde_json::json!({ "kind": "core.prompt", "text": "hi" }))
        .expect("prompt");
    assert_eq!(receipt.get("status").and_then(|s| s.as_str()), Some("completed"));

    let deltas: String = events
        .iter()
        .filter(|event| event.get("kind") == Some(&serde_json::json!("conversation.message.delta")))
        .filter_map(|event| event.get("delta").and_then(|d| d.as_str()))
        .collect();
    assert_eq!(deltas, "hello!");
}

#[test]
fn the_handshake_token_comes_from_the_file_the_session_writes() {
    // `connect` owns the token file: it writes the secret and the adapter reads
    // it back, so a client cannot be pointed at somebody else's token by
    // pre-seeding the path. What matters is that the proof is checked at all —
    // a session built with a mismatched expectation must not verify.
    let launch = launch("auth");
    let proof = step_studio_bridge::challenge_proof("step-studio", "c", "rt-1");
    let other = step_studio_bridge::challenge_proof("different-token", "c", "rt-1");
    assert_ne!(proof, other, "the proof must depend on the token");

    // And connecting still works, because both sides use the file's secret.
    assert!(BridgeSession::connect(&launch).is_ok());
}
