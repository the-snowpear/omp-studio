//! The Rust adapter end to end: the Rust Studio Bridge client (verified against
//! the TypeScript adapter) drives this adapter, which drives the real Step CLI.
//!
//! Skips when no CLI is installed, so CI is unaffected.

use std::path::PathBuf;
use std::time::Duration;

use step_studio_bridge::{AdapterLaunch, BridgeSession};
use step_studio_runtime::bridge_server::{AdapterConfig, Runtime};

fn find_step() -> Option<String> {
    let from_env = std::env::var("STEP_STUDIO_REAL_STEP").ok().filter(|v| !v.is_empty());
    if let Some(path) = from_env {
        return std::path::Path::new(&path).exists().then_some(path);
    }
    for dir in (std::env::var("PATH").unwrap_or_default()).split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(dir).join("step");
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let installed = PathBuf::from(home).join(".stepcode/bin/step");
    installed.exists().then(|| installed.to_string_lossy().to_string())
}

fn launch(tag: &str) -> (AdapterConfig, PathBuf) {
    let dir = std::env::temp_dir().join(format!("rust-rt-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let step = find_step().expect("no Step CLI installed");
    let config = AdapterConfig {
        endpoint: dir.join("bridge.sock").to_string_lossy().to_string(),
        token: "rust-runtime-token".to_string(),
        runtime_epoch: 1,
        cwd: dir.to_string_lossy().to_string(),
        step_command: step,
        // The whole environment, the same way the production config path passes
        // it: the CLI resolves its config dir and credentials from more than a
        // prefix, and filtering it here silently starves the turn.
        step_env: std::env::vars().collect(),
    };
    (config, dir)
}

#[test]
fn the_rust_adapter_drives_the_real_step_cli() {
    let Some(_) = find_step() else {
        eprintln!("skipping: no Step CLI installed");
        return;
    };
    let (config, _dir) = launch("e2e");

    // The adapter owns its socket, so run it on a thread and connect to it.
    let runtime = Runtime::new(AdapterConfig {
        endpoint: config.endpoint.clone(),
        token: config.token.clone(),
        runtime_epoch: config.runtime_epoch,
        cwd: config.cwd.clone(),
        step_command: config.step_command.clone(),
        step_env: config.step_env.clone(),
    });
    std::thread::spawn(move || {
        let _ = runtime.serve();
    });

    // Wait for the socket to appear.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !std::path::Path::new(&config.endpoint).exists() {
        assert!(std::time::Instant::now() < deadline, "the adapter never bound its socket");
        std::thread::sleep(Duration::from_millis(50));
    }

    let mut session = BridgeSession::connect(&AdapterLaunch {
        node: String::new(),
        adapter_script: String::new(),
        socket_path: config.endpoint.clone(),
        token_file: String::new(),
        cwd: config.cwd.clone(),
        runtime_epoch: config.runtime_epoch,
        env: Vec::new(),
        // The adapter already holds this token, so the client must not write a
        // competing file.
        token: Some(config.token.clone()),
        command: Vec::new(),
    })
    .expect("connect to the Rust adapter");

    let snapshot = session.snapshot().expect("snapshot");
    let session_id = snapshot
        .pointer("/snapshot/sessionId")
        .and_then(|v| v.as_str())
        .expect("sessionId");
    assert!(!session_id.is_empty(), "the CLI reported an empty session id");

    let (receipt, events) = session
        .invoke(serde_json::json!({ "kind": "core.prompt", "text": "reply with exactly: PONG" }))
        .expect("prompt");
    assert_eq!(
        receipt.get("status").and_then(|s| s.as_str()),
        Some("completed"),
        "turn failed: {}",
        receipt.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("unknown")
    );

    let answer: String = events
        .iter()
        .filter(|event| event.get("kind") == Some(&serde_json::json!("conversation.message.delta")))
        .filter(|event| event.get("blockType") == Some(&serde_json::json!("text")))
        .filter_map(|event| event.get("delta").and_then(|d| d.as_str()))
        .collect();
    assert!(answer.contains("PONG"), "no answer streamed; got: {answer}");

    let page = session
        .invoke(serde_json::json!({ "kind": "session.transcript.read" }))
        .expect("transcript")
        .0;
    let items = page.pointer("/result/items").and_then(|i| i.as_array()).expect("items");
    assert!(
        items.iter().any(|item| item.get("role") == Some(&serde_json::json!("assistant"))),
        "the transcript lost the assistant turn"
    );
}
