import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { liveAudioSocketName, privateSocketPath } from "@omp-studio/studio-host";
import type { DictationCaptureState, DictationChannel, DictationEvent, DictationInput } from "@omp-studio/studio-protocol";
import type { RuntimeMediaFiles } from "./runtime-media-files.js";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";
import {
  DICTATION_AUDIO_CHANNELS, DICTATION_MAX_PCM_BYTES,
  type DictationAudioAttach, type DictationAudioResult, type DictationDesktopEvent,
  type DictationOwner, type DictationRecovery,
} from "./dictation-audio-shared.js";

const MAX_CHUNK_BYTES = 12800;
const MAX_RECEIVE_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 4 * (MAX_CHUNK_BYTES + 4);
const PCM16_BLOCK_BYTES = 6400;
// Main closes the controller immediately; only a bounded, already produced Worklet tail can enter the cache.
const TAIL_SAMPLES = 3200;
const TAIL_WINDOW_MS = 1000;

export class DictationAudioError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DictationAudioError"; }
}
const failure = (code: string, message: string): DictationAudioError => new DictationAudioError(code, message);
function audioId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw failure("invalid-audio-id", "Invalid dictation audio identifier.");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid-input", "Invalid dictation input.");
  return value as Record<string, unknown>;
}
function controlFrame(input: DictationInput): Buffer {
  const json = Buffer.from(JSON.stringify(input), "utf8"), frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32LE((json.length | 0x80000000) >>> 0); json.copy(frame, 4); return frame;
}
interface DrainWaiter { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Connection {
  socket: Socket; active: boolean; authenticated: boolean; sequence: number;
  pending: Buffer; writes: Promise<void>; pendingBytes: number;
  drains: Map<string, DrainWaiter>; abortAttach?: ((error: Error) => void) | undefined;
  started: boolean; ready: boolean; recording: boolean; drained: boolean; replaying: boolean;
}
interface Capture {
  windowId: number; owner: DictationOwner; audioId: string; channel: DictationChannel;
  generation: number; connection?: Connection | undefined; state: DictationCaptureState;
  // Retry shares this array, never a second whole-recording buffer.
  pcm: Buffer[]; bytes: number; sequence: number; retained: boolean;
  inputClosed: boolean; limited: boolean; retry: boolean; previousState?: DictationCaptureState | undefined;
  tailUntil: number; tailSamples: number;
}

/** One app-wide window/draft-owned PCM16 recovery slot. Audio and text never go to disk or the ledger. */
export class DesktopDictationAudio {
  #capture: Capture | undefined;
  readonly #hidden = new Set<number>();
  readonly #listeners = new Set<(windowId: number, event: DictationDesktopEvent) => void>();
  constructor(readonly options: {
    directory(): string;
    files(): Pick<RuntimeMediaFiles, "descriptor">;
    socketDirectory?(): Promise<string>;
  }) {}

  onEvent(listener: (windowId: number, event: DictationDesktopEvent) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  #emit(capture: Capture, event: DictationDesktopEvent): void {
    for (const listener of this.#listeners) listener(capture.windowId, event);
  }
  #recovery(capture: Capture): DictationRecovery {
    return { audioId: capture.audioId, owner: capture.owner, state: capture.state,
      durationMs: capture.bytes / 32, bytes: capture.bytes, retained: capture.retained,
      canReplay: capture.bytes > 0, configuration: capture.channel.configuration };
  }
  recovery(windowId: number): DictationRecovery | null {
    const capture = this.#capture; return capture?.windowId === windowId ? this.#recovery(capture) : null;
  }
  #owned(windowId: number, value: unknown): Capture {
    const id = audioId(value), capture = this.#capture;
    if (!capture || capture.windowId !== windowId || capture.audioId !== id) throw failure("owner-mismatch", "This window does not own the dictation capture.");
    return capture;
  }
  #connected(capture: Capture): Connection {
    const connection = capture.connection;
    if (!connection?.active || !connection.authenticated || connection.socket.destroyed) throw failure("runtime-disconnected", "Dictation Runtime is disconnected. Retry explicitly to transcribe retained audio.");
    return connection;
  }
  #visible(windowId: number): void {
    if (this.#hidden.has(windowId)) throw failure("window-hidden", "Dictation cannot start or transcribe in a hidden window.");
  }
  #current(capture: Capture, generation: number, connection?: Connection): boolean {
    return this.#capture === capture && capture.generation === generation && (!connection || capture.connection === connection && connection.active);
  }
  setVisible(windowId: number, visible: boolean): void {
    if (visible) this.#hidden.delete(windowId);
    else if (!this.#hidden.has(windowId)) { this.#hidden.add(windowId); this.retainWindow(windowId); }
  }
  retainWindow(windowId: number): void {
    const capture = this.#capture; if (capture?.windowId === windowId) this.#retain(capture, true);
  }

  async attach(windowId: number, raw: unknown): Promise<void> {
    this.#visible(windowId);
    const input = object(raw) as unknown as DictationAudioAttach;
    const channel = object(input.channel) as unknown as DictationChannel, id = audioId(channel.audioId);
    const owner = object(input.owner) as unknown as DictationOwner;
    if (typeof owner.sessionId !== "string" || !owner.sessionId || owner.sessionId.length > 512 || typeof owner.draftId !== "string" || !owner.draftId || owner.draftId.length > 512 || channel.sessionId !== owner.sessionId) throw failure("owner-mismatch", "Dictation channel and draft must belong to the same session.");
    if (channel.protocolVersion !== 2 || !channel.configuration || channel.configuration.protocolVersion !== 2 || typeof channel.configuration.configurationId !== "string" || typeof channel.expiresAt !== "number" || channel.expiresAt <= Date.now()) throw failure("channel-expired", "Dictation channel expired or requires a newer Runtime.");
    let capture = this.#capture;
    if (input.recoveryId !== undefined) {
      capture = this.#owned(windowId, input.recoveryId);
      if (!capture.retained || capture.owner.sessionId !== owner.sessionId || capture.owner.draftId !== owner.draftId || id === capture.audioId) throw failure("recovery-mismatch", "Retry requires the original retained draft and a new audio channel.");
      capture.previousState = capture.state; this.#disconnect(capture);
      capture.audioId = id; capture.channel = channel; capture.generation++;
      capture.retry = true; capture.retained = false; capture.inputClosed = true;
      capture.tailUntil = 0; capture.tailSamples = 0;
    } else {
      if (capture) throw failure("recovery-pending", "Resolve the existing dictation before starting another capture.");
      capture = { windowId, owner: { sessionId: owner.sessionId, draftId: owner.draftId, ...(owner.label ? { label: owner.label } : {}) },
        audioId: id, channel, generation: 0, state: { phase: "prepared", committedText: "", partialText: "", submit: false },
        pcm: [], bytes: 0, sequence: 0, retained: false, inputClosed: false, limited: false, retry: false, tailUntil: 0, tailSamples: 0 };
      this.#capture = capture;
    }
    const generation = capture.generation;
    try {
      const descriptor = object(await this.options.files().descriptor(this.options.directory(), id));
      if (!this.#current(capture, generation)) throw failure("capture-ended", "Dictation capture was released or retained.");
      const expected = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${id}` : await this.#socketEndpoint(id);
      if (!this.#current(capture, generation)) throw failure("capture-ended", "Dictation capture was released or retained.");
      this.#visible(windowId);
      if (descriptor.version !== 2 || descriptor.audioId !== id || descriptor.sessionId !== owner.sessionId || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token) || typeof descriptor.expiresAt !== "number" || descriptor.expiresAt <= Date.now() || descriptor.expiresAt > Date.now() + 60000) throw failure("channel-expired", "Dictation attachment expired or belongs to another session.");
      if (descriptor.endpoint !== expected) throw failure("invalid-endpoint", "Invalid private dictation endpoint.");
      const socket = connect(expected);
      const connection: Connection = { socket, active: true, authenticated: false, sequence: -1, pending: Buffer.alloc(0), writes: Promise.resolve(), pendingBytes: 0, drains: new Map(), started: false, ready: false, recording: false, drained: false, replaying: false };
      capture.connection = connection;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => this.#lost(capture, connection, failure("attach-timeout", "Dictation authentication timed out.")), 5000);
        connection.abortAttach = error => { clearTimeout(timer); reject(error); };
        const authenticated = () => { clearTimeout(timer); connection.abortAttach = undefined; resolve(); };
        socket.on("data", data => this.#receive(capture, generation, connection, data, authenticated));
        socket.on("error", error => this.#lost(capture, connection, failure("runtime-connection-failed", `Dictation connection failed: ${error.message}`)));
        socket.on("close", () => this.#lost(capture, connection, failure("runtime-disconnected", "Dictation Runtime disconnected. Audio and recognized text were retained.")));
        socket.once("connect", () => { if (this.#current(capture, generation, connection)) socket.write(descriptor.token + "\n"); });
      });
      if (!this.#current(capture, generation, connection)) throw failure("capture-ended", "Dictation capture ended during attachment.");
    } catch (cause) {
      const error = cause instanceof DictationAudioError ? cause : failure("descriptor-unavailable", "The private dictation channel is unavailable. Prepare a new channel and retry.");
      if (this.#current(capture, generation) && !capture.retained) this.#retain(capture, false, error);
      throw error;
    }
  }
  async #socketEndpoint(id: string): Promise<string> {
    if (!this.options.socketDirectory) throw failure("invalid-endpoint", "Runtime socket directory is unavailable.");
    return privateSocketPath(await this.options.socketDirectory(), liveAudioSocketName(id));
  }
  #receive(capture: Capture, generation: number, connection: Connection, data: Buffer, authenticated: () => void): void {
    if (!this.#current(capture, generation, connection)) return;
    if (connection.pending.length + data.length > MAX_RECEIVE_BYTES) { this.#lost(capture, connection, failure("event-too-large", "Dictation event exceeded the private channel buffer.")); return; }
    connection.pending = Buffer.concat([connection.pending, data]);
    try {
      for (;;) {
        const end = connection.pending.indexOf(10); if (end < 0) break;
        const line = connection.pending.subarray(0, end); connection.pending = connection.pending.subarray(end + 1);
        if (!connection.authenticated) {
          if (line.toString("ascii") !== "OK") throw failure("authentication-failed", "Dictation channel authentication was refused.");
          connection.authenticated = true; authenticated(); continue;
        }
        if (!line.length) continue;
        const event = JSON.parse(line.toString("utf8")) as DictationEvent;
        if (event.audioId !== capture.audioId || !Number.isSafeInteger(event.sequence) || event.sequence !== connection.sequence + 1) throw failure("event-sequence", "Dictation received an out-of-order private event.");
        connection.sequence = event.sequence;
        if (event.kind === "drained") {
          const waiter = connection.drains.get(event.requestId);
          if (waiter) { connection.drains.delete(event.requestId); clearTimeout(waiter.timer); connection.drained = true; waiter.resolve(); }
        } else if (event.kind === "state") {
          let state = event.state;
          if (capture.retry && !connection.ready && state.phase !== "ready") state = { ...state, committedText: capture.previousState?.committedText ?? "", partialText: capture.previousState?.partialText ?? "", submit: false };
          if (state.phase === "ready") connection.ready = true;
          capture.state = capture.retry ? { ...state, submit: false } : state;
          this.#emit(capture, { kind: "state", audioId: capture.audioId, owner: capture.owner, state: capture.state });
          if (state.phase === "complete") { capture.inputClosed = true; capture.previousState = undefined; this.#disconnect(capture); }
          else if (state.phase === "error" || state.phase === "cancelled") this.#retain(capture, false);
        } else throw failure("invalid-event", "Unsupported private dictation event.");
        if (!this.#current(capture, generation, connection)) break;
      }
    } catch (cause) { this.#lost(capture, connection, cause instanceof DictationAudioError ? cause : failure("invalid-event", "Invalid private dictation event.")); }
  }
  #lost(capture: Capture, connection: Connection, error: DictationAudioError): void {
    if (this.#capture !== capture || capture.connection !== connection || !connection.active) return;
    this.#retain(capture, true, error);
  }
  #disconnect(capture: Capture, reason?: DictationAudioError): void {
    const connection = capture.connection; if (!connection) return;
    capture.connection = undefined; connection.active = false;
    const error = reason ?? failure("runtime-disconnected", "Dictation connection ended; retained audio is still available.");
    connection.abortAttach?.(error); connection.abortAttach = undefined;
    for (const waiter of connection.drains.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    connection.drains.clear(); connection.pending = Buffer.alloc(0);
    // Fence events before cancelling the native controller. Close is its final cancellation boundary.
    if (!connection.socket.destroyed) {
      if (connection.authenticated) {
        connection.socket.end(controlFrame({ kind: "cancel" }), () => connection.socket.destroy());
        const timer = setTimeout(() => connection.socket.destroy(), 200); timer.unref();
        connection.socket.once("close", () => clearTimeout(timer));
      } else connection.socket.destroy();
    }
  }
  #retain(capture: Capture, allowTail: boolean, error?: DictationAudioError): void {
    if (capture.retained) return;
    const recording = capture.connection?.recording && !capture.retry && !capture.inputClosed;
    capture.retained = true; capture.inputClosed = true; capture.generation++;
    capture.tailUntil = allowTail && recording ? Date.now() + TAIL_WINDOW_MS : 0;
    capture.tailSamples = capture.tailUntil ? TAIL_SAMPLES : 0;
    if (error) capture.state = { ...capture.state, phase: "error", submit: false, error: { code: error.code, message: error.message } };
    else capture.state = { ...capture.state, submit: false };
    this.#disconnect(capture, error);
    this.#emit(capture, { kind: "retained", recovery: this.#recovery(capture) });
  }
  #write(capture: Capture, connection: Connection, frame: Buffer): Promise<void> {
    if (!connection.active) return Promise.reject(failure("runtime-disconnected", "Dictation Runtime disconnected."));
    if (connection.pendingBytes + frame.length > MAX_PENDING_BYTES) {
      const error = failure("audio-backpressure", "Dictation Runtime cannot keep up. Audio has been retained.");
      this.#lost(capture, connection, error); return Promise.reject(error);
    }
    connection.pendingBytes += frame.length;
    const write = connection.writes.then(() => new Promise<void>((resolve, reject) => {
      if (!connection.active || connection.socket.destroyed) { reject(failure("runtime-disconnected", "Dictation Runtime disconnected.")); return; }
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(timer); connection.socket.off("close", closed);
        if (error) reject(error); else resolve();
      };
      const closed = () => finish(failure("runtime-disconnected", "Dictation Runtime disconnected before the audio write completed."));
      const timer = setTimeout(() => {
        const error = failure("audio-backpressure", "Dictation audio write timed out. Audio has been retained.");
        this.#lost(capture, connection, error); finish(error);
      }, 2000);
      connection.socket.once("close", closed);
      connection.socket.write(frame, error => finish(error ? failure("audio-write-failed", "Dictation audio write failed. Audio has been retained.") : undefined));
    }));
    connection.writes = write.catch(() => {});
    return write.catch(error => { this.#lost(capture, connection, error); throw error; }).finally(() => { connection.pendingBytes -= frame.length; });
  }

  async control(windowId: number, raw: unknown): Promise<void> {
    const input = object(raw), capture = this.#owned(windowId, input.audioId), command = object(input.input) as unknown as DictationInput;
    if (command.kind === "cancel") { this.release(windowId, { audioId: capture.audioId }); return; }
    if (command.kind === "drain") { await this.#drain(capture, command.requestId); return; }
    this.#visible(windowId);
    const connection = this.#connected(capture);
    if (command.kind === "start") {
      if (connection.started || !["click", "hold", "toggle", "retry"].includes(command.mode) || (command.mode === "retry") !== capture.retry || command.configurationId !== capture.channel.configuration.configurationId) throw failure("invalid-start", "Dictation start must use its prepared configuration and capture mode.");
      connection.started = true;
    } else if (command.kind === "recording") {
      if (!connection.ready || !connection.started || capture.retry && !connection.replaying || !capture.retry && capture.inputClosed) throw failure("not-ready", "Dictation receiver is not ready for capture.");
      connection.recording = true;
    } else if (command.kind === "stop") {
      if (!connection.drained) throw failure("not-drained", "Drain the final audio frame before stopping dictation.");
      capture.inputClosed = true; connection.recording = false;
    } else if (command.kind !== "snapshot" && command.kind !== "ping") throw failure("invalid-control", "Unsupported dictation control.");
    const canonical: DictationInput = command.kind === "start"
      ? { kind: "start", mode: command.mode, configurationId: command.configurationId }
      : { kind: command.kind };
    await this.#write(capture, connection, controlFrame(canonical));
  }
  async append(windowId: number, raw: unknown): Promise<void> {
    const input = object(raw), capture = this.#owned(windowId, input.audioId);
    if (input.sequence !== capture.sequence || !(input.bytes instanceof ArrayBuffer) || !input.bytes.byteLength || input.bytes.byteLength > MAX_CHUNK_BYTES || input.bytes.byteLength % 4) throw failure("invalid-pcm-sequence", "Invalid or out-of-order dictation PCM chunk.");
    const samples = new DataView(input.bytes), count = samples.byteLength / 4;
    for (let i = 0; i < count; i++) { const value = samples.getFloat32(i * 4, true); if (!Number.isFinite(value) || Math.abs(value) > 1) throw failure("invalid-pcm", "Invalid dictation PCM samples."); }
    if (capture.limited) {
      // The limit is a normal stop. ACK only the bounded frames already in flight, without growing or forwarding the cache.
      if (capture.retry || capture.tailUntil <= Date.now() || count > capture.tailSamples) throw failure("audio-limit", "Dictation reached its ten-minute audio limit.");
      capture.sequence++; capture.tailSamples -= count; return;
    }
    const tail = capture.retained && capture.tailUntil > Date.now() && capture.tailSamples > 0;
    if (capture.retry || !tail && (capture.retained || capture.inputClosed || this.#hidden.has(windowId))) throw failure("capture-stopped", "Dictation is no longer accepting microphone audio.");
    const connection = tail ? undefined : this.#connected(capture);
    if (connection && (!connection.recording || !connection.ready)) throw failure("not-ready", "Dictation receiver is not ready for microphone audio.");
    if (tail && count > capture.tailSamples) throw failure("tail-limit", "Hidden-window dictation tail exceeded its bounded allowance.");
    const accepted = Math.min(count, (DICTATION_MAX_PCM_BYTES - capture.bytes) / 2);
    if (accepted > 0) {
      for (let i = 0; i < accepted; i++) {
        const blockOffset = capture.bytes % PCM16_BLOCK_BYTES;
        if (blockOffset === 0) capture.pcm.push(Buffer.allocUnsafe(Math.min(PCM16_BLOCK_BYTES, DICTATION_MAX_PCM_BYTES - capture.bytes)));
        const sample = samples.getFloat32(i * 4, true);
        capture.pcm[capture.pcm.length - 1]!.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), blockOffset);
        capture.bytes += 2;
      }
    }
    capture.sequence++; if (tail) capture.tailSamples -= count;
    if (capture.bytes === DICTATION_MAX_PCM_BYTES && !capture.limited) {
      capture.limited = true; capture.inputClosed = true;
      capture.tailUntil = Date.now() + TAIL_WINDOW_MS; capture.tailSamples = TAIL_SAMPLES;
      this.#emit(capture, { kind: "limit", audioId: capture.audioId });
    }
    // Cache first, including the frame whose Runtime write fails.
    if (connection && accepted) {
      const frame = Buffer.allocUnsafe(4 + accepted * 4); frame.writeUInt32LE(accepted * 4);
      Buffer.from(input.bytes, 0, accepted * 4).copy(frame, 4); await this.#write(capture, connection, frame);
    }
  }
  async drain(windowId: number, raw: unknown): Promise<void> {
    const input = object(raw); await this.#drain(this.#owned(windowId, input.audioId), randomUUID());
  }
  async #drain(capture: Capture, requestId: string): Promise<void> {
    capture.inputClosed = true; capture.tailUntil = 0; capture.tailSamples = 0;
    // For retained captures the barrier is the Main cache, never a disconnected controller.
    if (capture.retained) { this.#emit(capture, { kind: "retained", recovery: this.#recovery(capture) }); return; }
    const connection = this.#connected(capture);
    if (!connection.ready || typeof requestId !== "string" || !requestId || requestId.length > 128 || connection.drains.size) throw failure("not-ready", "Dictation receiver is not ready to drain.");
    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.drains.delete(requestId);
        const error = failure("drain-timeout", "Dictation Runtime did not confirm the final audio frame. Audio has been retained.");
        this.#lost(capture, connection, error); reject(error);
      }, 5000);
      connection.drains.set(requestId, { resolve, reject, timer });
    });
    void ack.catch(() => {});
    try { await this.#write(capture, connection, controlFrame({ kind: "drain", requestId })); await ack; }
    catch (error) { const waiter = connection.drains.get(requestId); if (waiter) { connection.drains.delete(requestId); clearTimeout(waiter.timer); waiter.reject(error as Error); } throw error; }
  }
  async replay(windowId: number, raw: unknown): Promise<void> {
    const input = object(raw), capture = this.#owned(windowId, input.audioId);
    this.#visible(windowId);
    const connection = this.#connected(capture);
    if (!capture.retry || !connection.ready || !connection.started || connection.replaying || connection.drained || !capture.bytes) throw failure("retry-not-ready", "Replay requires a ready retry capture and retained audio.");
    connection.replaying = true;
    try {
      await this.control(windowId, { audioId: capture.audioId, input: { kind: "recording" } });
      let remaining = capture.bytes;
      for (const pcm of capture.pcm) {
        if (capture.connection !== connection || !connection.active) throw failure("capture-ended", "Dictation retry ended.");
        const bytes = Math.min(remaining, pcm.length); remaining -= bytes;
        const frame = Buffer.allocUnsafe(4 + bytes * 2); frame.writeUInt32LE(bytes * 2);
        for (let offset = 0; offset < bytes; offset += 2) { const sample = pcm.readInt16LE(offset); frame.writeFloatLE(sample < 0 ? sample / 32768 : sample / 32767, 4 + offset * 2); }
        await this.#write(capture, connection, frame);
      }
      await this.#drain(capture, randomUUID());
      await this.control(windowId, { audioId: capture.audioId, input: { kind: "stop" } });
    } finally { connection.replaying = false; }
  }
  retain(windowId: number, raw: unknown): void {
    const input = object(raw); this.#retain(this.#owned(windowId, input.audioId), true);
  }
  release(windowId: number, raw: unknown): void {
    const input = object(raw), capture = this.#owned(windowId, input.audioId);
    this.#capture = undefined; capture.generation++; this.#disconnect(capture);
    capture.pcm.length = 0; capture.bytes = 0; capture.previousState = undefined;
    this.#emit(capture, { kind: "released", audioId: capture.audioId });
  }
  disposeWindow(windowId: number): void {
    if (this.#capture?.windowId === windowId) this.release(windowId, { audioId: this.#capture.audioId });
    this.#hidden.delete(windowId);
  }
  dispose(): void {
    if (this.#capture) this.disposeWindow(this.#capture.windowId);
    this.#hidden.clear(); this.#listeners.clear();
  }
}

/** Fixed private methods. Field/owner checks are made once, in the actual audio service. */
export function registerDictationAudioIpc(options: {
  ipcMain: TerminalIpcMain; isTrustedSender(sender: TerminalSender): boolean;
  isVisible(sender: TerminalSender): boolean; manager: DesktopDictationAudio;
}): { dispose(): void } {
  const senders = new Map<number, TerminalSender>(); let disposed = false;
  const unsubscribe = options.manager.onEvent((windowId, event) => {
    const sender = senders.get(windowId);
    if (sender && !sender.isDestroyed() && options.isTrustedSender(sender)) sender.send(DICTATION_AUDIO_CHANNELS.event, event);
  });
  for (const [kind, channel] of Object.entries(DICTATION_AUDIO_CHANNELS)) {
    if (kind === "event") continue;
    options.ipcMain.handle(channel, async ({ sender }, payload): Promise<DictationAudioResult> => {
      if (sender.isDestroyed() || !options.isTrustedSender(sender)) throw failure("untrusted-sender", "Untrusted dictation sender.");
      if (!senders.has(sender.id)) {
        senders.set(sender.id, sender);
        sender.once("destroyed", () => { if (!disposed) { senders.delete(sender.id); options.manager.disposeWindow(sender.id); } });
        const onNavigate = () => { if (!disposed && !sender.isDestroyed()) { options.manager.retainWindow(sender.id); sender.once("did-navigate", onNavigate); } };
        sender.once("did-navigate", onNavigate);
      }
      options.manager.setVisible(sender.id, options.isVisible(sender));
      try {
        if (kind === "attach") await options.manager.attach(sender.id, payload);
        else if (kind === "input") await options.manager.control(sender.id, payload);
        else if (kind === "chunk") await options.manager.append(sender.id, payload);
        else if (kind === "drain") await options.manager.drain(sender.id, payload);
        else if (kind === "replay") await options.manager.replay(sender.id, payload);
        else if (kind === "retain") options.manager.retain(sender.id, payload);
        else if (kind === "release") options.manager.release(sender.id, payload);
        options.manager.setVisible(sender.id, options.isVisible(sender));
        return kind === "recovery" || kind === "attach" || kind === "retain" ? { ok: true, recovery: options.manager.recovery(sender.id) } : { ok: true };
      } catch (cause) {
        const error = cause instanceof DictationAudioError ? cause : failure("dictation-operation-failed", "Dictation operation failed. Retained audio remains available.");
        return { ok: false, code: error.code, message: error.message, recovery: options.manager.recovery(sender.id) };
      }
    });
  }
  return { dispose() {
    disposed = true; unsubscribe();
    for (const windowId of senders.keys()) options.manager.disposeWindow(windowId);
    senders.clear();
    for (const [kind, channel] of Object.entries(DICTATION_AUDIO_CHANNELS)) if (kind !== "event") options.ipcMain.removeHandler(channel);
  } };
}
