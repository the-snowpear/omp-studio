//! Length-prefixed framing, byte-for-byte compatible with
//! `@omp-studio/studio-protocol`'s `frame-codec.ts`.
//!
//! Layout, all lengths big-endian:
//!   [4B payloadLength][4B headerLength][header JSON][body JSON]
//! where `payloadLength` counts the header-length prefix itself:
//!   payloadLength = 4 + headerLength + bodyLength
//!
//! The header carries exactly five keys and is validated with `exactKeys` on
//! the TypeScript side, so an extra key there is a protocol error, not a
//! harmless addition.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

/// Protocol name the peer checks before anything else.
pub const PROTOCOL_NAME: &str = "omp-studio";
/// Protocol version this crate speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Bytes each length prefix occupies.
pub const LENGTH_PREFIX_BYTES: usize = 4;
/// Control-frame cap, matching `DEFAULT_MAX_CONTROL_FRAME_BYTES`.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameHeader {
    pub protocol: String,
    pub version: u32,
    #[serde(rename = "frameId")]
    pub frame_id: String,
    #[serde(rename = "runtimeEpoch")]
    pub runtime_epoch: u64,
    #[serde(rename = "bodyLength")]
    pub body_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    TooLarge { limit: usize },
    TooSmall,
    Malformed(String),
    Io(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(f, "frame exceeds {limit} bytes"),
            Self::TooSmall => write!(f, "frame payload is too small"),
            Self::Malformed(detail) => write!(f, "malformed frame: {detail}"),
            Self::Io(detail) => write!(f, "io: {detail}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<std::io::Error> for FrameError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

pub struct FrameEncoder;

impl FrameEncoder {
    pub fn encode(runtime_epoch: u64, body: &impl Serialize) -> Result<Vec<u8>, FrameError> {
        Self::encode_with_id(next_frame_id(), runtime_epoch, body)
    }

    pub fn encode_with_id(
        frame_id: String,
        runtime_epoch: u64,
        body: &impl Serialize,
    ) -> Result<Vec<u8>, FrameError> {
        let body_bytes = serde_json::to_vec(body).map_err(|e| FrameError::Malformed(e.to_string()))?;
        let header = FrameHeader {
            protocol: PROTOCOL_NAME.to_string(),
            version: PROTOCOL_VERSION,
            frame_id,
            runtime_epoch,
            body_length: body_bytes.len(),
        };
        let header_bytes =
            serde_json::to_vec(&header).map_err(|e| FrameError::Malformed(e.to_string()))?;
        let payload_length = LENGTH_PREFIX_BYTES + header_bytes.len() + body_bytes.len();
        if payload_length > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge {
                limit: MAX_FRAME_BYTES,
            });
        }

        let mut out = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload_length);
        out.extend_from_slice(&(payload_length as u32).to_be_bytes());
        out.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&header_bytes);
        out.extend_from_slice(&body_bytes);
        Ok(out)
    }
}

#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub header: FrameHeader,
    pub body: serde_json::Value,
}

pub struct FrameDecoder {
    buffer: Vec<u8>,
    failed: bool,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            failed: false,
        }
    }

    /// Feed bytes; returns every frame that became complete. A protocol error
    /// closes the decoder, exactly as the TypeScript one does — a peer that
    /// sent one bad frame is not worth decoding further.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<DecodedFrame>, FrameError> {
        if self.failed {
            return Err(FrameError::Malformed("decoder is closed".to_string()));
        }
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            if self.buffer.len() < LENGTH_PREFIX_BYTES {
                break;
            }
            let payload_length = u32::from_be_bytes([
                self.buffer[0],
                self.buffer[1],
                self.buffer[2],
                self.buffer[3],
            ]) as usize;
            if payload_length > MAX_FRAME_BYTES {
                self.failed = true;
                return Err(FrameError::TooLarge {
                    limit: MAX_FRAME_BYTES,
                });
            }
            if payload_length < LENGTH_PREFIX_BYTES {
                self.failed = true;
                return Err(FrameError::TooSmall);
            }
            let frame_length = LENGTH_PREFIX_BYTES + payload_length;
            if self.buffer.len() < frame_length {
                break;
            }

            let header_length = u32::from_be_bytes([
                self.buffer[LENGTH_PREFIX_BYTES],
                self.buffer[LENGTH_PREFIX_BYTES + 1],
                self.buffer[LENGTH_PREFIX_BYTES + 2],
                self.buffer[LENGTH_PREFIX_BYTES + 3],
            ]) as usize;
            if header_length == 0 || header_length > payload_length - LENGTH_PREFIX_BYTES {
                self.failed = true;
                return Err(FrameError::Malformed("invalid frame header length".to_string()));
            }
            let header_start = LENGTH_PREFIX_BYTES * 2;
            let header_bytes = self.buffer[header_start..header_start + header_length].to_vec();
            let body_bytes = self.buffer[header_start + header_length..frame_length].to_vec();
            self.buffer.drain(..frame_length);

            let header: FrameHeader =
                serde_json::from_slice(&header_bytes).map_err(|e| FrameError::Malformed(e.to_string()))?;
            if header.protocol != PROTOCOL_NAME {
                self.failed = true;
                return Err(FrameError::Malformed("unsupported protocol".to_string()));
            }
            if header.version != PROTOCOL_VERSION {
                self.failed = true;
                return Err(FrameError::Malformed("unsupported protocol version".to_string()));
            }
            if header.body_length != body_bytes.len() {
                self.failed = true;
                return Err(FrameError::Malformed(
                    "frame body length does not match header".to_string(),
                ));
            }
            let body: serde_json::Value =
                serde_json::from_slice(&body_bytes).map_err(|e| FrameError::Malformed(e.to_string()))?;
            frames.push(DecodedFrame { header, body });
        }
        Ok(frames)
    }
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Frame ids only need to be unique per connection; the peer never parses them.
pub fn next_frame_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("rust-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub fn write_frame<W: Write>(
    writer: &mut W,
    runtime_epoch: u64,
    body: &impl Serialize,
) -> Result<(), FrameError> {
    let bytes = FrameEncoder::encode(runtime_epoch, body)?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

/// Read exactly one frame; `Ok(None)` on a clean EOF between frames.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<DecodedFrame>, FrameError> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES * 2];
    match reader.read_exact(&mut prefix) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(FrameError::Io(e.to_string())),
    }
    let payload_length = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    if payload_length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            limit: MAX_FRAME_BYTES,
        });
    }
    if payload_length < LENGTH_PREFIX_BYTES {
        return Err(FrameError::TooSmall);
    }
    let header_length = u32::from_be_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]) as usize;
    if header_length == 0 || header_length > payload_length - LENGTH_PREFIX_BYTES {
        return Err(FrameError::Malformed("invalid frame header length".to_string()));
    }
    let mut rest = vec![0u8; header_length + (payload_length - LENGTH_PREFIX_BYTES - header_length)];
    reader.read_exact(&mut rest)?;
    let header: FrameHeader =
        serde_json::from_slice(&rest[..header_length]).map_err(|e| FrameError::Malformed(e.to_string()))?;
    let body: serde_json::Value =
        serde_json::from_slice(&rest[header_length..]).map_err(|e| FrameError::Malformed(e.to_string()))?;
    Ok(Some(DecodedFrame { header, body }))
}
