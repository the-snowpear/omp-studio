//! Studio Bridge wire protocol: the same framed JSON the TypeScript host and
//! runtime speak. A Rust client here lets a native shell drive the existing
//! TS adapter without a webview or an Electron process.

pub mod client;
pub mod frame;
pub mod handshake;

pub use frame::{FrameDecoder, FrameEncoder};
pub use handshake::{challenge_proof, PROTOCOL_VERSION};

pub use client::{AdapterLaunch, BridgeError, BridgeSession};
