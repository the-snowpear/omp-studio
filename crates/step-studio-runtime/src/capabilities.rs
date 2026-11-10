//! The capability manifest. Only ids the adapter actually implements, with
//! honest grades: anything absent is treated as unavailable by Host and
//! Renderer, which is the correct default.

use serde_json::{json, Value};
use step_studio_bridge::frame::PROTOCOL_VERSION;

pub struct Manifest {
    pub value: Value,
    pub hash: String,
    pub command_hash: String,
    pub runtime_version: String,
}

const CAPABILITIES: &[(&str, &str, &str)] = &[
    ("core.prompt", "stable", ""),
    ("core.steer", "stable", ""),
    ("core.followUp", "stable", ""),
    ("core.abort", "stable", ""),
    ("runtime.snapshot", "stable", ""),
    ("session.state", "stable", ""),
    ("session.history", "stable", ""),
    (
        "session.transcript.read",
        "limited",
        "Step exposes no pagination cursor, so the page is the whole branch",
    ),
    ("session.new", "stable", ""),
    ("session.model.set", "stable", ""),
    ("session.models.list", "stable", ""),
    (
        "session.thinking.set",
        "limited",
        "`auto` has no Step equivalent; it maps to the model's first supported level",
    ),
    (
        "session.fork",
        "limited",
        "forks at the latest entry only; the Studio tree/branch surface is not implemented",
    ),
    (
        "conversation.compaction",
        "unavailable",
        "Step compacts on its own; it arrives as an event, not as a command a client can invoke",
    ),
];

const COMMANDS: &[&str] = &[
    "core.prompt",
    "core.steer",
    "core.followUp",
    "core.abort",
    "runtime.snapshot",
    "runtime.shutdown",
    "session.model.set",
    "session.thinking.set",
    "session.new",
    "session.fork",
    "session.models.list",
];

pub fn capability_manifest() -> Manifest {
    let entries: Vec<Value> = CAPABILITIES
        .iter()
        .map(|(id, grade, limitation)| {
            let mut entry = json!({
                "id": id,
                "grade": grade,
                "version": PROTOCOL_VERSION,
                "evidence": "step-studio-runtime",
            });
            if !limitation.is_empty() {
                entry["limitations"] = json!([limitation]);
            }
            entry
        })
        .collect();
    // The hash covers the capability list, so it is computed before the
    // manifest that carries it.
    let hash = sha256_hex(&serde_json::to_string(&entries).unwrap_or_default());
    let value = json!({ "profile": "limited", "generatedAt": crate::conversation::now_iso(), "hash": hash, "capabilities": entries });
    let command_hash = sha256_hex(&serde_json::to_string(&COMMANDS).unwrap_or_default());
    Manifest {
        value,
        hash,
        command_hash,
        runtime_version: "0.1.0-rust".to_string(),
    }
}

/// SHA-256 hex, so the manifest hash matches what the TypeScript side computes.
pub fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
