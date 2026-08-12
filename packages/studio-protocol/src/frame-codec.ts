import { STUDIO_PROTOCOL_NAME, STUDIO_PROTOCOL_VERSION, type FrameHeader } from "./contracts/protocol.js";
import type { RuntimeEpoch } from "./contracts/ids.js";
import { parseFrameHeader } from "./validation.js";

export const DEFAULT_MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
const LENGTH_PREFIX_BYTES = 4;

export interface DecodedFrame<T = unknown> {
  header: FrameHeader;
  body: T;
}

export class FrameCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameCodecError";
  }
}

export function encodeFrame(
  frameId: string,
  runtimeEpoch: RuntimeEpoch,
  body: unknown,
  maxBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES,
): Buffer {
  const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
  const header: FrameHeader = {
    protocol: STUDIO_PROTOCOL_NAME,
    version: STUDIO_PROTOCOL_VERSION,
    frameId,
    runtimeEpoch,
    bodyLength: bodyBytes.byteLength,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const payloadLength = LENGTH_PREFIX_BYTES + headerBytes.byteLength + bodyBytes.byteLength;

  if (payloadLength > maxBytes) {
    throw new FrameCodecError(`Frame exceeds ${maxBytes} bytes`);
  }

  const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.writeUInt32BE(headerBytes.byteLength, LENGTH_PREFIX_BYTES);
  headerBytes.copy(frame, LENGTH_PREFIX_BYTES * 2);
  bodyBytes.copy(frame, LENGTH_PREFIX_BYTES * 2 + headerBytes.byteLength);
  return frame;
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #failed = false;

  constructor(private readonly maxBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES) {}

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.#failed) {
      throw new FrameCodecError("Frame decoder is closed after a protocol error");
    }
    const frames: DecodedFrame[] = [];
    let offset = 0;

    while (offset < chunk.byteLength || this.#buffer.byteLength >= LENGTH_PREFIX_BYTES) {
      if (this.#buffer.byteLength < LENGTH_PREFIX_BYTES) {
        const prefixBytes = Math.min(LENGTH_PREFIX_BYTES - this.#buffer.byteLength, chunk.byteLength - offset);
        if (prefixBytes <= 0) break;
        this.#buffer = Buffer.concat([
          this.#buffer,
          Buffer.from(chunk.subarray(offset, offset + prefixBytes)),
        ]);
        offset += prefixBytes;
        if (this.#buffer.byteLength < LENGTH_PREFIX_BYTES) break;
      }

      const payloadLength = this.#buffer.readUInt32BE(0);
      if (payloadLength > this.maxBytes) {
        this.#fail(`Frame exceeds ${this.maxBytes} bytes`);
      }
      if (payloadLength < LENGTH_PREFIX_BYTES) {
        this.#fail("Frame payload is too small");
      }

      const frameLength = LENGTH_PREFIX_BYTES + payloadLength;
      if (this.#buffer.byteLength < frameLength && offset < chunk.byteLength) {
        const frameBytes = Math.min(frameLength - this.#buffer.byteLength, chunk.byteLength - offset);
        this.#buffer = Buffer.concat([
          this.#buffer,
          Buffer.from(chunk.subarray(offset, offset + frameBytes)),
        ]);
        offset += frameBytes;
      }
      if (this.#buffer.byteLength < frameLength) break;

      const payload = this.#buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + payloadLength);
      try {
        const headerLength = payload.readUInt32BE(0);
        if (headerLength <= 0 || headerLength > payloadLength - LENGTH_PREFIX_BYTES) {
          throw new FrameCodecError("Invalid frame header length");
        }

        const headerValue: unknown = JSON.parse(
          payload.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + headerLength).toString("utf8"),
        );
        const header = parseFrameHeader(headerValue);
        const bodyBytes = payload.subarray(LENGTH_PREFIX_BYTES + headerLength);
        if (bodyBytes.byteLength !== header.bodyLength) {
          throw new FrameCodecError("Frame body length does not match header");
        }

        frames.push({ header, body: JSON.parse(bodyBytes.toString("utf8")) as unknown });
      } catch (error) {
        this.#failed = true;
        this.#buffer = Buffer.alloc(0);
        if (error instanceof FrameCodecError) throw error;
        throw new FrameCodecError(`Malformed frame: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#buffer = Buffer.alloc(0);
    }

    return frames;
  }

  #fail(message: string): never {
    this.#failed = true;
    this.#buffer = Buffer.alloc(0);
    throw new FrameCodecError(message);
  }
}
