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

const EMPTY_BUFFER: Buffer = typeof Buffer === "function"
  ? Buffer.alloc(0)
  : (new Uint8Array(0) as unknown as Buffer);

export class FrameDecoder {
  #buffer = EMPTY_BUFFER;
  #used = 0;
  #failed = false;

  constructor(private readonly maxBytes = DEFAULT_MAX_CONTROL_FRAME_BYTES) {}

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.#failed) {
      throw new FrameCodecError("Frame decoder is closed after a protocol error");
    }
    const frames: DecodedFrame[] = [];
    const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < view.length) {
      const available = view.length - offset;
      if (this.#used === 0 && available >= LENGTH_PREFIX_BYTES) {
        const length = this.#frameLength(view.readUInt32BE(offset));
        if (available < length) {
          this.#append(view.subarray(offset), length);
          break;
        }
        frames.push(this.#decodePayload(view.subarray(offset + LENGTH_PREFIX_BYTES, offset + length)));
        offset += length;
        continue;
      }

      if (this.#used < LENGTH_PREFIX_BYTES) {
        const count = Math.min(LENGTH_PREFIX_BYTES - this.#used, available);
        this.#append(view.subarray(offset, offset + count), LENGTH_PREFIX_BYTES);
        offset += count;
        if (this.#used < LENGTH_PREFIX_BYTES) break;
      }
      const length = this.#frameLength(this.#buffer.readUInt32BE(0));
      const count = Math.min(length - this.#used, view.length - offset);
      this.#append(view.subarray(offset, offset + count), length);
      offset += count;
      if (this.#used < length) break;
      frames.push(this.#decodePayload(this.#buffer.subarray(LENGTH_PREFIX_BYTES, length)));
      this.#buffer = EMPTY_BUFFER;
      this.#used = 0;
    }
    return frames;
  }

  #frameLength(payloadLength: number): number {
    if (payloadLength > this.maxBytes) this.#fail(`Frame exceeds ${this.maxBytes} bytes`);
    if (payloadLength < LENGTH_PREFIX_BYTES) this.#fail("Frame payload is too small");
    return LENGTH_PREFIX_BYTES + payloadLength;
  }

  // Partial frames own only the bytes received so far. Growing geometrically
  // avoids copying the entire prefix on every pipe or socket read.
  #append(fragment: Buffer, limit: number): void {
    const needed = this.#used + fragment.length;
    if (needed > this.#buffer.length) {
      const capacity = Math.min(limit, Math.max(needed, this.#buffer.length * 2));
      const next = Buffer.allocUnsafe(capacity);
      this.#buffer.copy(next, 0, 0, this.#used);
      this.#buffer = next;
    }
    fragment.copy(this.#buffer, this.#used);
    this.#used = needed;
  }

  #decodePayload(payload: Buffer): DecodedFrame {
    try {
      const headerLength = payload.readUInt32BE(0);
      if (headerLength <= 0 || headerLength > payload.byteLength - LENGTH_PREFIX_BYTES) {
        throw new FrameCodecError("Invalid frame header length");
      }

      const headerValue: unknown = JSON.parse(
        payload.toString("utf8", LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + headerLength),
      );
      const header = parseFrameHeader(headerValue);
      const bodyStart = LENGTH_PREFIX_BYTES + headerLength;
      if (payload.byteLength - bodyStart !== header.bodyLength) {
        throw new FrameCodecError("Frame body length does not match header");
      }

      return { header, body: JSON.parse(payload.toString("utf8", bodyStart)) as unknown };
    } catch (error) {
      this.#failed = true;
      this.#buffer = EMPTY_BUFFER;
      if (error instanceof FrameCodecError) throw error;
      throw new FrameCodecError(`Malformed frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #fail(message: string): never {
    this.#failed = true;
    this.#buffer = EMPTY_BUFFER;
    throw new FrameCodecError(message);
  }
}
