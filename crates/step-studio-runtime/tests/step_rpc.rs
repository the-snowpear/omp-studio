//! `StepRpc` alone against the real CLI. If this passes, the stall is in the
//! adapter's plumbing rather than the JSONL client.

use std::time::Duration;

use step_studio_runtime::step_rpc::{StepLaunch, StepRpc};

fn find_step() -> Option<String> {
    for dir in (std::env::var("PATH").unwrap_or_default()).split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = std::path::Path::new(dir).join("step");
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let installed = std::path::Path::new(&home).join(".stepcode/bin/step");
    installed.exists().then(|| installed.to_string_lossy().to_string())
}

#[test]
fn step_rpc_runs_a_turn_against_the_real_cli() {
    let Some(step) = find_step() else {
        eprintln!("skipping: no Step CLI installed");
        return;
    };
    let dir = std::env::temp_dir().join(format!("rust-rpc-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);

    let mut rpc = StepRpc::spawn(&StepLaunch {
        command: step,
        cwd: dir.to_string_lossy().to_string(),
        env: std::env::vars().collect(),
        continue_session: false,
    })
    .expect("spawn step");

    let state = rpc
        .request("get_state", serde_json::json!({}), Duration::from_secs(30))
        .expect("get_state");
    eprintln!("session: {}", state.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?"));

    rpc.send("prompt", serde_json::json!({ "message": "reply with exactly: PONG" }))
        .expect("send prompt");

    let mut kinds = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    while std::time::Instant::now() < deadline {
        let Some(event) = rpc.wait_event(Duration::from_millis(200)) else {
            continue;
        };
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !kinds.contains(&kind) {
            kinds.push(kind.clone());
        }
        if kind == "agent_settled" {
            eprintln!("settled after seeing: {kinds:?}");
            return;
        }
    }
    panic!("turn never settled; saw: {kinds:?}");
}
