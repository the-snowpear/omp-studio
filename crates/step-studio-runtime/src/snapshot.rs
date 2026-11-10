//! The Operator state snapshot the Host needs to reach `ready`.

use serde_json::{json, Value};

use crate::step_rpc::StepRpc;

/// Build the snapshot from the CLI's live state.
///
/// `get_state` can fail — a CLI that has not finished starting, or one that
/// died — and the adapter must still answer, because a Host with no snapshot
/// never leaves `negotiated`. The fallback is a minimal but valid snapshot.
pub fn build_snapshot(step: &mut StepRpc, epoch: u64, session_id: &str) -> Value {
    let state = step
        .request("get_state", json!({}), std::time::Duration::from_secs(10))
        .ok();

    let mut snapshot = json!({
        "runtimeId": format!("step-runtime-{}", std::process::id()),
        "runtimeEpoch": epoch,
        "stateVersion": 0,
        "sessionId": session_id,
        "isStreaming": false,
        "isCompacting": false,
        "activeMode": "normal",
        "approvalMode": "always-ask",
        "pendingMessages": 0,
        "activeCommandIds": [],
        "agentsRevision": 0,
        "jobsRevision": 0,
        "agents": [],
        "jobs": [],
    });

    if let Some(state) = state {
        let model = state.get("model");
        let provider = model.and_then(|m| m.get("provider")).and_then(|v| v.as_str());
        let model_id = model.and_then(|m| m.get("id")).and_then(|v| v.as_str());
        let thinking = state.get("thinkingLevel").and_then(|v| v.as_str());
        if let (Some(provider), Some(model_id)) = (provider, model_id) {
            let mut model = json!({
                "selector": format!("{provider}/{model_id}"),
                "provider": provider,
                "id": model_id,
            });
            if let Some(level) = thinking {
                model["thinking"] = json!(level);
                model["configuredThinking"] = json!(level);
            }
            snapshot["model"] = model;
        }
        if let Some(streaming) = state.get("isStreaming").and_then(|v| v.as_bool()) {
            snapshot["isStreaming"] = json!(streaming);
        }
        if let Some(compacting) = state.get("isCompacting").and_then(|v| v.as_bool()) {
            snapshot["isCompacting"] = json!(compacting);
        }
        if let Some(pending) = state.get("pendingMessageCount").and_then(|v| v.as_i64()) {
            snapshot["pendingMessages"] = json!(pending);
        }
    }

    snapshot
}
