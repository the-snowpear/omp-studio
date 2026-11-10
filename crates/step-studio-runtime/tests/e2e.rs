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

/// A wrapper that runs the shared fake CLI, so the adapter can be pointed at a
/// script instead of a single executable.
fn fake_step_wrapper(dir: &std::path::Path) -> PathBuf {
    let fake = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root")
        .join("packages/runtime-stepcode/test/fake-step.mjs");
    let wrapper = dir.join("fake-step");
    std::fs::write(&wrapper, format!("#!/bin/sh\nexec node {} \"$@\"\n", fake.display()))
        .expect("write wrapper");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755));
    }
    wrapper
}

fn launch(tag: &str) -> (AdapterConfig, PathBuf) {
    let dir = std::env::temp_dir().join(format!("rust-rt-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let step = find_step().expect("no Step CLI installed");
    config_in(&dir, step)
}

fn config_in(dir: &std::path::Path, step_command: String) -> (AdapterConfig, PathBuf) {
    {
        let config = AdapterConfig {
            endpoint: dir.join("bridge.sock").to_string_lossy().to_string(),
            token: "rust-runtime-token".to_string(),
            runtime_epoch: 1,
            cwd: dir.to_string_lossy().to_string(),
            step_command,
        // The whole environment, the same way the production config path passes
        // it: the CLI resolves its config dir and credentials from more than a
        // prefix, and filtering it here silently starves the turn.
        step_env: std::env::vars().collect(),
    };
    (config, dir.to_path_buf())
    }
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

    let session = BridgeSession::connect(&AdapterLaunch {
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

#[test]
fn aborting_settles_the_turn_the_rust_adapter_is_still_running() {
    // The fake CLI has a turn that never settles on its own, so the receipt can
    // only come from the abort. The TypeScript adapter used to drop the turn's
    // receipt here and leave the Host waiting for the prompt RPC to time out.
    let dir = std::env::temp_dir().join(format!("rust-abort-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let (config, _) = config_in(&dir, fake_step_wrapper(&dir).to_string_lossy().to_string());

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

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !std::path::Path::new(&config.endpoint).exists() {
        assert!(std::time::Instant::now() < deadline, "the adapter never bound its socket");
        std::thread::sleep(Duration::from_millis(50));
    }

    let session = std::sync::Arc::new(
        BridgeSession::connect(&AdapterLaunch {
            node: String::new(),
            adapter_script: String::new(),
            socket_path: config.endpoint.clone(),
            token_file: String::new(),
            cwd: config.cwd.clone(),
            runtime_epoch: config.runtime_epoch,
            env: Vec::new(),
            token: Some(config.token.clone()),
            command: Vec::new(),
        })
        .expect("connect to the Rust adapter"),
    );

    let (first, started) = std::sync::mpsc::channel::<()>();
    let turn = std::sync::Arc::clone(&session);
    let handle = std::thread::spawn(move || {
        turn.invoke_with(serde_json::json!({ "kind": "core.prompt", "text": "hang" }), |event| {
            if event.get("kind") == Some(&serde_json::json!("conversation.message.delta")) {
                let _ = first.send(());
            }
        })
    });

    started
        .recv_timeout(Duration::from_secs(30))
        .expect("the turn never started");
    session
        .invoke(serde_json::json!({ "kind": "core.abort" }))
        .expect("abort was refused");

    let receipt = handle.join().expect("turn thread").expect("the turn never settled");
    assert_eq!(
        receipt.get("status").and_then(|s| s.as_str()),
        Some("completed"),
        "the aborted turn did not settle: {}",
        receipt.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("unknown")
    );
}

#[test]
fn a_new_session_mints_a_fresh_session_id() {
    // Probed against the real CLI first: `new_session` returns
    // `{"cancelled":false}` and the next `get_state` reports a different id with
    // the transcript reset. Anything else would make the shell's New button
    // clear a conversation that is still there.
    let Some(step) = find_step() else {
        eprintln!("skipping: no Step CLI installed");
        return;
    };
    let dir = std::env::temp_dir().join(format!("rust-new-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let (config, _) = config_in(&dir, step);

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

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !std::path::Path::new(&config.endpoint).exists() {
        assert!(std::time::Instant::now() < deadline, "the adapter never bound its socket");
        std::thread::sleep(Duration::from_millis(50));
    }

    let session = BridgeSession::connect(&AdapterLaunch {
        node: String::new(),
        adapter_script: String::new(),
        socket_path: config.endpoint.clone(),
        token_file: String::new(),
        cwd: config.cwd.clone(),
        runtime_epoch: config.runtime_epoch,
        env: Vec::new(),
        token: Some(config.token.clone()),
        command: Vec::new(),
    })
    .expect("connect to the Rust adapter");

    let before = session
        .snapshot()
        .expect("snapshot")
        .pointer("/snapshot/sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    assert!(!before.is_empty(), "no session id before the reset");

    let receipt = session
        .invoke(serde_json::json!({ "kind": "session.new" }))
        .expect("session.new")
        .0;
    assert_eq!(
        receipt.get("status").and_then(|s| s.as_str()),
        Some("completed"),
        "session.new failed: {}",
        receipt.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("unknown")
    );

    let after = session
        .snapshot()
        .expect("snapshot after the reset")
        .pointer("/snapshot/sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    assert_ne!(before, after, "session.new kept the old session id");
}
