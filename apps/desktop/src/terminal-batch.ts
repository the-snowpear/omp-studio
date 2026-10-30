/**
 * PTY output batching + bounded flow control (P0-4).
 *
 * Before this module every PTY chunk became its own IPC message
 * (`terminal-pty.ts` `sender.send` via `terminal-ipc.ts`): a `npm install`
 * flood is thousands of tiny messages per second, each one a structured clone
 * and a renderer long task. Recording paid an extra `JSON.stringify` per chunk
 * on top.
 *
 * Design:
 * - **Batching window.** Output is coalesced for `TERMINAL_BATCH_MS` (8 ms —
 *   half a 16 ms frame; VS Code's `TerminalDataBufferer` defaults to 5 ms).
 *   A burst larger than the hard cap flushes immediately instead of waiting.
 * - **Byte-safe.** Chunks are concatenated as bytes and decoded through one
 *   stateful `StringDecoder` per session, so a UTF-8 code point split across
 *   two chunks is reassembled instead of becoming two replacement characters.
 *   `close()` ends the decoder, so the tail is delivered rather than dropped.
 * - **Bounded.** `TERMINAL_BUFFER_HARD_CAP_BYTES` (2 MiB) is a floor, not a
 *   drop threshold: hitting it forces a flush. Nothing is ever discarded.
 * - **Flow control.** With `flowControl` negotiated (the Renderer opts in when
 *   it can ACK `xterm.write`), Main stops reading the source once the renderer
 *   has `TERMINAL_FLOW_HIGH_BYTES` (500 KiB) of unacknowledged output, and
 *   resumes below `TERMINAL_FLOW_LOW_BYTES` (100 KiB) — the watermarks from
 *   xterm's flow-control guide. Without the negotiation (old renderer, no ACK
 *   method) the batcher degrades to batching only and never pauses.
 * - **No idle work.** A timer exists only while data is buffered.
 *
 * Not here: the input path (`terminal write`). Keystrokes stay unbuffered and
 * unthrottled.
 */

import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";

/** Coalescing window: half a 60 Hz frame. */
export const TERMINAL_BATCH_MS = 8;

/** Pause the source above this many unacknowledged bytes (xterm guide: ≤ 500 K). */
export const TERMINAL_FLOW_HIGH_BYTES = 500 * 1024;

/** Resume the source below this many unacknowledged bytes (xterm guide: ~100 K). */
export const TERMINAL_FLOW_LOW_BYTES = 100 * 1024;

/** Never buffer more than this per session; flush instead of dropping. */
export const TERMINAL_BUFFER_HARD_CAP_BYTES = 2 * 1024 * 1024;

export interface TerminalBatchTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: TerminalBatchTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Where a batched payload goes. `bytes` is the UTF-8 length of `data`. */
export interface TerminalBatchSink {
  /** Deliver one batch to the Renderer (one IPC message). */
  send(id: string, data: string, bytes: number): void;
  /** Terminal recording: same batch, so it no longer stringifies per chunk. */
  record?(id: string, data: string): void;
  /** Ask the source (PTY / SSH process) to stop or resume producing output. */
  pauseSource?(id: string, paused: boolean): void;
  /** Diagnostic hook: the hard cap forced a flush before the window closed. */
  capReached?(id: string, bufferedBytes: number): void;
}

export interface TerminalOutputBatcherOptions {
  readonly sink: TerminalBatchSink;
  readonly batchMs?: number;
  readonly highWaterBytes?: number;
  readonly lowWaterBytes?: number;
  readonly hardCapBytes?: number;
  readonly timers?: TerminalBatchTimers;
}

/** Observable per-session state, used by tests and the diagnostics path. */
export interface TerminalFlowStats {
  readonly bufferedBytes: number;
  readonly unackedBytes: number;
  readonly paused: boolean;
  readonly flowControl: boolean;
}

interface SessionState {
  readonly id: string;
  readonly decoder: StringDecoder;
  chunks: Buffer[];
  bufferedBytes: number;
  unackedBytes: number;
  readonly flowControl: boolean;
  paused: boolean;
  timer: unknown;
}

export class TerminalOutputBatcher {
  readonly #sink: TerminalBatchSink;
  readonly #batchMs: number;
  readonly #highWater: number;
  readonly #lowWater: number;
  readonly #hardCap: number;
  readonly #timers: TerminalBatchTimers;
  readonly #sessions = new Map<string, SessionState>();

  constructor(options: TerminalOutputBatcherOptions) {
    this.#sink = options.sink;
    this.#batchMs = options.batchMs ?? TERMINAL_BATCH_MS;
    this.#highWater = options.highWaterBytes ?? TERMINAL_FLOW_HIGH_BYTES;
    this.#lowWater = options.lowWaterBytes ?? TERMINAL_FLOW_LOW_BYTES;
    this.#hardCap = options.hardCapBytes ?? TERMINAL_BUFFER_HARD_CAP_BYTES;
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    if (this.#lowWater > this.#highWater) {
      throw new Error("terminal batcher: low watermark must not exceed the high watermark");
    }
  }

  /** Number of sessions with an open buffer (diagnostics/tests). */
  get openSessions(): number {
    return this.#sessions.size;
  }

  /**
   * Start buffering for one terminal. `flowControl` is true only when the
   * Renderer negotiated ACKs; otherwise the batcher never pauses the source.
   */
  open(id: string, options: { readonly flowControl?: boolean } = {}): void {
    if (this.#sessions.has(id)) return;
    this.#sessions.set(id, {
      id,
      decoder: new StringDecoder("utf8"),
      chunks: [],
      bufferedBytes: 0,
      unackedBytes: 0,
      flowControl: options.flowControl === true,
      paused: false,
      timer: undefined,
    });
  }

  /** Queue one chunk. Strings are encoded to bytes; Uint8Array views are copied. */
  push(id: string, chunk: string | Uint8Array): void {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (bytes.length === 0) return;
    session.chunks.push(bytes);
    session.bufferedBytes += bytes.length;
    if (session.bufferedBytes >= this.#hardCap) {
      // Bounded memory wins over the batching window. The renderer is clearly
      // behind, so stop the source *and* hand over what is buffered: nothing is
      // dropped, and the buffer cannot grow past the cap.
      this.#sink.capReached?.(id, session.bufferedBytes);
      this.#pause(session);
      this.#flush(session, false);
      return;
    }
    if (session.timer === undefined) {
      session.timer = this.#timers.setTimeout(() => {
        session.timer = undefined;
        this.#flush(session, false);
      }, this.#batchMs);
    }
  }

  /**
   * Renderer consumed `bytes` of output. Clamped to what is actually
   * outstanding, so a confused renderer cannot drive the counter negative or
   * release the source early.
   */
  acknowledge(id: string, bytes: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined || !session.flowControl) return;
    const acked = Number.isFinite(bytes) && bytes > 0 ? Math.min(bytes, session.unackedBytes) : 0;
    session.unackedBytes -= acked;
    if (session.paused && session.unackedBytes <= this.#lowWater) {
      session.paused = false;
      this.#sink.pauseSource?.(id, false);
    }
  }

  /** Deliver buffered output now (`id` omitted = every session). */
  flush(id?: string): void {
    if (id !== undefined) {
      const session = this.#sessions.get(id);
      if (session !== undefined) this.#flush(session, false);
      return;
    }
    for (const session of [...this.#sessions.values()]) this.#flush(session, false);
  }

  /**
   * Deliver the tail (`decoder.end()` flushes a dangling partial code point as
   * a replacement character), release the session and stop its timer. Called
   * on terminal exit, dispose and window teardown.
   */
  close(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    this.#flush(session, true);
    this.#sessions.delete(id);
    if (session.timer !== undefined) {
      this.#timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (session.paused) {
      session.paused = false;
      this.#sink.pauseSource?.(id, false);
    }
  }

  /** Release every session (window teardown / app quit). */
  closeAll(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
  }

  stats(id: string): TerminalFlowStats | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) return undefined;
    return {
      bufferedBytes: session.bufferedBytes,
      unackedBytes: session.unackedBytes,
      paused: session.paused,
      flowControl: session.flowControl,
    };
  }

  #flush(session: SessionState, final: boolean): void {
    if (session.timer !== undefined) {
      this.#timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (session.bufferedBytes === 0) {
      if (final) {
        // Flush a dangling partial code point, if the decoder still holds one.
        const tail = session.decoder.end();
        if (tail.length > 0) this.#deliver(session, tail);
      }
      return;
    }
    const bytes = session.bufferedBytes === 1 ? session.chunks[0]! : Buffer.concat(session.chunks, session.bufferedBytes);
    session.chunks = [];
    session.bufferedBytes = 0;
    const text = final ? session.decoder.write(bytes) + session.decoder.end() : session.decoder.write(bytes);
    if (text.length === 0) return;
    this.#deliver(session, text);
  }

  #deliver(session: SessionState, text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    session.unackedBytes += session.flowControl ? bytes : 0;
    this.#sink.record?.(session.id, text);
    this.#sink.send(session.id, text, bytes);
    if (session.flowControl && !session.paused && session.unackedBytes >= this.#highWater) {
      // The Renderer is behind: stop reading the source instead of letting the
      // unacknowledged window (or this buffer) grow without bound.
      this.#pause(session);
    }
  }

  /** Pause the source once; a backend without pause support keeps buffering. */
  #pause(session: SessionState): void {
    if (!session.flowControl || session.paused) return;
    session.paused = true;
    this.#sink.pauseSource?.(session.id, true);
  }
}
