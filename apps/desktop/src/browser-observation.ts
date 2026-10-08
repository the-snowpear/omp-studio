import { connect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BROWSER_PRIVATE_MAX_BYTES, validateBrowserObservationEvent, validateBrowserObservationInput, type BrowserObservationEvent } from "@omp-studio/studio-protocol";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";
import { BROWSER_OBSERVATION_CHANNELS, type BrowserObservationResult } from "./browser-observation-shared.js";
const identifier = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid browser observation identity"); return value; };
function record(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid browser observation fields"); return value as Record<string, unknown>; }
interface Connection { sender: TerminalSender; id: string; tabId: string; sessionId: string; socket: Socket; attached: boolean; latest: number; inFlight: number; lastFrameAt: number; control: string; }
/** Fixed, authenticated, window-owned transport. No CDP endpoint or method crosses preload. */
export class DesktopBrowserObservation {
  readonly #connections = new Map<number, Connection>();
  readonly #generations = new Map<number, number>();
  constructor(readonly options: { directory(): string; socketDirectory(): Promise<string> }) {}
  async attach(sender: TerminalSender, value: unknown): Promise<void> {
    const input = record(value, ["observationId", "sessionId", "tabId"]); const id = identifier(input.observationId); const tabId = identifier(input.tabId);
    if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 512) throw new Error("Invalid browser session");
    this.disposeWindow(sender.id); const generation = this.#generations.get(sender.id);
    const file = join(this.options.directory(), "browser", id + ".json"); const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Browser observation descriptor unavailable");
    const descriptor = record(JSON.parse(await readFile(file, "utf8")), ["version", "observationId", "sessionId", "tabId", "endpoint", "token", "expiresAt"]);
    if (descriptor.version !== 1 || descriptor.observationId !== id || descriptor.tabId !== tabId || descriptor.sessionId !== input.sessionId || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token) || typeof descriptor.expiresAt !== "number" || descriptor.expiresAt < Date.now() || descriptor.expiresAt > Date.now() + 60000) throw new Error("Browser observation descriptor expired");
    const endpoint = process.platform === "win32" ? "\\\\.\\pipe\\omp-studio-browser-" + id : join(await this.options.socketDirectory(), "b-" + createHash("sha256").update(id).digest("hex").slice(0, 16) + ".sock");
    if (descriptor.endpoint !== endpoint || generation !== this.#generations.get(sender.id) || sender.isDestroyed()) throw new Error("Browser observation target changed");
    const socket = connect(endpoint); const entry: Connection = { sender, id, tabId, sessionId: input.sessionId, socket, attached: false, latest: 0, inFlight: 0, lastFrameAt: 0, control: "agent" };
    if (this.#connections.size >= 4) { socket.destroy(); throw new Error("Too many browser observations"); }
    this.#connections.set(sender.id, entry); const pending = Buffer.alloc(BROWSER_PRIVATE_MAX_BYTES); let pendingLength = 0;
    let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
    const ready = { promise: new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }), resolve: () => resolveReady(), reject: (error: Error) => rejectReady(error) };
    const timer = setTimeout(() => { ready.reject(new Error("Browser observation attach timed out")); socket.destroy(); }, 5000);
    const emit = (event: BrowserObservationEvent) => { if (!sender.isDestroyed() && this.#connections.get(sender.id) === entry) sender.send(BROWSER_OBSERVATION_CHANNELS.event, event); };
    socket.on("error", () => ready.reject(new Error("Browser observation connection failed")));
    socket.once("close", () => { clearTimeout(timer); ready.reject(new Error("Browser observation detached")); emit({ kind: "closed", observationId: id }); if (this.#connections.get(sender.id) === entry) this.#connections.delete(sender.id); });
    socket.once("connect", () => socket.write(descriptor.token + "\n"));
    socket.on("data", chunk => {
      if (pendingLength + chunk.length > BROWSER_PRIVATE_MAX_BYTES) { socket.destroy(); return; }
      chunk.copy(pending, pendingLength); pendingLength += chunk.length;
      for (let index = pending.subarray(0, pendingLength).indexOf(10); index >= 0; index = pending.subarray(0, pendingLength).indexOf(10)) {
        const line = pending.subarray(0, index).toString("utf8"); pending.copyWithin(0, index + 1, pendingLength); pendingLength -= index + 1;
        if (!entry.attached) { if (line !== "OK") { socket.destroy(); return; } entry.attached = true; clearTimeout(timer); ready.resolve(); continue; }
        try {
          const event: unknown = JSON.parse(line); validateBrowserObservationEvent(event);
          if (event.observationId !== id || ("tabId" in event && event.tabId !== tabId)) throw new Error("Browser target identity mismatch");
          if (event.kind === "frame") {
            if (event.sequence <= entry.latest || entry.inFlight) throw new Error("Browser frame backpressure violation"); entry.latest = event.sequence;
            if (Date.now() - entry.lastFrameAt < 95) { socket.write(JSON.stringify({ kind: "ack", sequence: event.sequence }) + "\n"); continue; }
            entry.inFlight = event.sequence; entry.lastFrameAt = Date.now();
          }
          if (event.kind === "state") entry.control = event.control;
          emit(event);
        } catch { socket.destroy(); return; }
      }
    });
    try { await ready.promise; if (generation !== this.#generations.get(sender.id) || socket.destroyed) throw new Error("Window no longer owns this observation"); }
    catch (error) { socket.destroy(); throw error; }
  }
  input(sender: TerminalSender, value: unknown): void {
    const raw = record(value, ["observationId", "input"]); const id = identifier(raw.observationId); validateBrowserObservationInput(raw.input);
    const entry = this.#connections.get(sender.id); if (!entry?.attached || entry.id !== id || entry.socket.destroyed) throw new Error("Browser observation is not owned by this window");
    const input = raw.input;
    if (input.kind === "ack") { if (entry.inFlight !== input.sequence) throw new Error("Browser frame acknowledgement is stale"); entry.inFlight = 0; }
    else if (!["ping", "take", "release"].includes(input.kind) && entry.control !== "human") throw new Error("Explicit human control is required");
    if (entry.socket.writableLength > 65536) throw new Error("Browser control buffer is full");
    entry.socket.write(JSON.stringify(input) + "\n");
  }
  detach(sender: TerminalSender, value: unknown): void {
    const input = record(value, ["observationId"]); const id = identifier(input.observationId);
    if (this.#connections.get(sender.id)?.id === id) this.disposeWindow(sender.id);
  }
  disposeWindow(owner: number): void { this.#generations.set(owner, (this.#generations.get(owner) ?? 0) + 1); const entry = this.#connections.get(owner); if (entry) { entry.socket.destroy(); this.#connections.delete(owner); } }
  dispose(): void { for (const owner of this.#connections.keys()) this.disposeWindow(owner); }
}
export function registerBrowserObservationIpc(options: { ipcMain: TerminalIpcMain; manager: DesktopBrowserObservation; isTrustedSender(sender: TerminalSender): boolean; isVisible(sender: TerminalSender): boolean }): { dispose(): void } {
  const owners = new Set<number>();
  for (const kind of ["attach", "input", "detach"] as const) options.ipcMain.handle(BROWSER_OBSERVATION_CHANNELS[kind], async ({ sender }, input): Promise<BrowserObservationResult> => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) throw new Error("Untrusted browser observation request");
    if (kind !== "detach" && !options.isVisible(sender)) { options.manager.disposeWindow(sender.id); return { ok: false, message: "Browser observation requires a visible window" }; }
    if (!owners.has(sender.id)) { owners.add(sender.id); const dispose = () => { options.manager.disposeWindow(sender.id); owners.delete(sender.id); }; sender.once("destroyed", dispose); sender.once("did-navigate", dispose); }
    try { if (kind === "attach") await options.manager.attach(sender, input); else if (kind === "input") options.manager.input(sender, input); else options.manager.detach(sender, input); return { ok: true }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Browser observation unavailable" }; }
  });
  return { dispose() { for (const owner of owners) options.manager.disposeWindow(owner); owners.clear(); for (const kind of ["attach", "input", "detach"] as const) options.ipcMain.removeHandler(BROWSER_OBSERVATION_CHANNELS[kind]); } };
}
