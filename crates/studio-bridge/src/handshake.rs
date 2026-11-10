//! The Studio Hello handshake. The runtime proves it holds the bridge token by
//! answering a challenge; the host verifies before trusting anything else.

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Protocol version this client speaks. Mirrors STUDIO_PROTOCOL_VERSION.
pub const PROTOCOL_VERSION: u32 = 1;

pub type HmacSha256 = Hmac<Sha256>;

/// HMAC-SHA256(token, challenge + NUL + runtimeInstanceId), base64url.
///
/// The NUL separator is load-bearing: without it a challenge and an instance
/// id that concatenate to the same bytes would produce the same proof.
pub fn challenge_proof(token: &str, challenge: &str, runtime_instance_id: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(challenge.as_bytes());
    mac.update(b"\0");
    mac.update(runtime_instance_id.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// What a verified hello establishes about the runtime on the other end.
#[derive(Debug, Clone)]
pub struct HelloResult {
    pub selected_protocol_version: u32,
    pub runtime_version: String,
    pub upstream_version: String,
    pub runtime_instance_id: String,
    pub runtime_epoch: u64,
    pub capability_profile: String,
}

/// Build the `studio.hello` request body.
pub fn hello_request(challenge: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "studio.hello",
        "requestId": crate::frame::next_frame_id(),
        "supportedProtocolVersions": [PROTOCOL_VERSION],
        "requiredProfile": "limited",
        "challenge": challenge,
    })
}

/// Verify a hello result against the expected proof and extract its identity.
pub fn verify_hello(
    body: &serde_json::Value,
    token: &str,
    challenge: &str,
) -> Result<HelloResult, String> {
    let instance_id = body
        .get("runtimeInstanceId")
        .and_then(|v| v.as_str())
        .ok_or("hello is missing runtimeInstanceId")?;
    let expected = challenge_proof(token, challenge, instance_id);
    let actual = body
        .get("challengeProof")
        .and_then(|v| v.as_str())
        .ok_or("hello is missing challengeProof")?;
    if actual != expected {
        return Err("challenge proof mismatch".to_string());
    }
    let version = body
        .get("selectedProtocolVersion")
        .and_then(|v| v.as_u64())
        .ok_or("hello is missing selectedProtocolVersion")? as u32;
    if version != PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version {version}"));
    }
    Ok(HelloResult {
        selected_protocol_version: version,
        runtime_version: str_field(body, "runtimeVersion")?,
        upstream_version: str_field(body, "upstreamVersion")?,
        runtime_instance_id: instance_id.to_string(),
        runtime_epoch: body.get("runtimeEpoch").and_then(|v| v.as_u64()).unwrap_or(1),
        capability_profile: body
            .get("capabilityManifest")
            .and_then(|m| m.get("profile"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn str_field(body: &serde_json::Value, key: &str) -> Result<String, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("hello is missing {key}"))
}
