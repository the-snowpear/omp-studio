import { Buffer } from "node:buffer";
import type { ArtifactLibrary } from "@omp-studio/studio-host";
import type { TerminalRecordingInput, TerminalRecordingStatus, TerminalSize } from "./terminal-shared.js";

const MAX_RECORDING_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_EVENTS = 100000;
/** Bounded producer; a slow disk stops recording while the real shell keeps running. */
class RecordingStream implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = []; #queued = 0; #closed = false; #wake: (() => void) | undefined;
  push(chunk: Uint8Array): boolean {
    if (this.#closed || this.#queued + chunk.length > MAX_QUEUED_BYTES) return false;
    this.#chunks.push(chunk); this.#queued += chunk.length; this.#wake?.(); this.#wake = undefined; return true;
  }
  end(): void { this.#closed = true; this.#wake?.(); this.#wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try { while (!this.#closed || this.#chunks.length) {
      const chunk = this.#chunks.shift();
      if (chunk) { this.#queued -= chunk.length; yield chunk; }
      else await new Promise<void>(resolve => { this.#wake = resolve; });
    } } finally { this.#chunks = []; this.#queued = 0; this.#closed = true; }
  }
}
interface RecordingState {
  input: TerminalRecordingInput; windowId: number; startedAt: number; stoppedAt?: number;
  status: TerminalRecordingStatus; stream: RecordingStream; saved: Promise<void>; events: number; lastAt: number;
}
export class TerminalRecordingManager {
  readonly #records = new Map<string, RecordingState>();
  constructor(readonly library: () => ArtifactLibrary, readonly now: () => number = Date.now) {}
  #key(windowId: number, id: string): string { return `${windowId}:${id}`; }
  status(windowId: number, id: string): TerminalRecordingStatus {
    const state = this.#records.get(this.#key(windowId, id));
    return state ? { ...state.status, elapsedMs: Math.max(0, (state.stoppedAt ?? this.now()) - state.startedAt) } : { terminalId: id, state: "idle", elapsedMs: 0, bytes: 0 };
  }
  start(windowId: number, input: TerminalRecordingInput, target: TerminalSize & { name: string; backend: "pty" | "pipes" }): TerminalRecordingStatus {
    if (target.backend !== "pty") throw new Error("Recording requires a real PTY; this terminal uses the pipe fallback");
    const key = this.#key(windowId, input.id); const previous = this.#records.get(key);
    if (previous && (previous.status.state === "recording" || previous.status.state === "saving")) throw new Error("This terminal already has an active recording");
    // Keep only a bounded tail of completed status rows for terminals closed in this window.
    const completed = [...this.#records.entries()].filter(([, value]) => value.windowId === windowId && ["saved", "failed"].includes(value.status.state));
    for (const [old] of completed.slice(0, Math.max(0, completed.length - 15))) this.#records.delete(old);
    const library = this.library(); const startedAt = this.now(); const stream = new RecordingStream();
    const header = Buffer.from(JSON.stringify({ studiocast: 1, cols: target.cols, rows: target.rows, title: target.name, createdAt: new Date(startedAt).toISOString() }) + "\n");
    stream.push(header);
    const state: RecordingState = { input, windowId, startedAt, status: { terminalId: input.id, state: "recording", elapsedMs: 0, bytes: header.length }, stream, saved: Promise.resolve(), events: 0, lastAt: 0 };
    this.#records.set(key, state);
    state.saved = library.register({ kind: "recording", name: `shell-${new Date(startedAt).toISOString().replace(/[:.]/gu, "-")}.studiocast`, mimeType: "application/x-studio-terminalcast", ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, stream)
      .then(artifact => { state.status = { ...state.status, state: "saved", artifactId: artifact.artifactId }; })
      .catch(() => { state.status = { ...state.status, state: "failed", notice: "Recording could not be saved. Check the artifact storage location." }; state.stoppedAt ??= this.now(); stream.end(); });
    return this.status(windowId, input.id);
  }
  output(windowId: number, id: string, data: string): void { this.#append(windowId, id, { t: "output", data }); }
  resize(windowId: number, id: string, cols: number, rows: number): void { this.#append(windowId, id, { t: "resize", cols, rows }); }
  #append(windowId: number, id: string, frame: object): void {
    const state = this.#records.get(this.#key(windowId, id)); if (!state || state.status.state !== "recording") return;
    const elapsed = Math.max(state.lastAt, this.now() - state.startedAt); const bytes = Buffer.from(JSON.stringify([elapsed, frame]) + "\n");
    if (elapsed > 8 * 3600000 || state.status.bytes + bytes.length > MAX_RECORDING_BYTES || state.events >= MAX_EVENTS || !state.stream.push(bytes)) {
      state.status.notice = "Recording stopped at the duration/size limit or because storage could not keep up. The captured prefix is being saved.";
      void this.stop(windowId, id); return;
    }
    state.status.bytes += bytes.length; state.events++; state.lastAt = elapsed;
  }
  async stop(windowId: number, id: string): Promise<TerminalRecordingStatus> {
    const state = this.#records.get(this.#key(windowId, id)); if (!state) return this.status(windowId, id);
    if (state.status.state === "recording") { state.status.state = "saving"; state.stoppedAt = this.now(); state.stream.end(); }
    await state.saved; return this.status(windowId, id);
  }
  end(windowId: number, id: string): void { void this.stop(windowId, id); }
  disposeWindow(windowId: number): void {
    for (const [key, state] of this.#records) if (state.windowId === windowId) void this.stop(windowId, state.input.id).finally(() => { if (this.#records.get(key) === state) this.#records.delete(key); });
  }
  async dispose(): Promise<void> { await Promise.all([...this.#records.values()].map(state => this.stop(state.windowId, state.input.id))); this.#records.clear(); }
}
