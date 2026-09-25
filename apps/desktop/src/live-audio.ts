import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import type { RuntimeMediaFiles } from "./runtime-media-files.js";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";
import { LIVE_AUDIO_CHANNELS, type LiveAudioResult } from "./live-audio-shared.js";
interface Connection { owner: number; audioId: string; socket: Socket; sequence: number; busy: boolean; attached: boolean }
const identifier = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid audio id"); return value; };
function record(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid audio fields"); return value as Record<string, unknown>; }
/** Window-owned fixed PCM channel. Endpoint and bearer token remain in Main. */
export class DesktopLiveAudio {
  readonly #connections = new Map<string, Connection>();
  readonly #generations = new Map<number, number>();
  constructor(readonly options: { directory(): string; files(): RuntimeMediaFiles }) {}
  async attach(owner: number, raw: unknown): Promise<void> {
    const input = record(raw, ["audioId", "sessionId"]); const audioId = identifier(input.audioId);
    if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 512) throw new Error("Invalid audio session");
    this.disposeWindow(owner); const generation = this.#generations.get(owner);
    const root = this.options.directory();
    const descriptor = record(await this.options.files().descriptor(root, audioId), ["version", "audioId", "sessionId", "endpoint", "token", "expiresAt"]);
    if (generation !== this.#generations.get(owner) || descriptor.version !== 1 || descriptor.audioId !== audioId || descriptor.sessionId !== input.sessionId || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token) || typeof descriptor.expiresAt !== "number" || descriptor.expiresAt < Date.now() || descriptor.expiresAt > Date.now() + 60000) throw new Error("Audio attachment expired");
    const expected = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${audioId}` : resolve(root, "audio", audioId + ".sock");
    if (descriptor.endpoint !== expected || this.#connections.has(audioId)) throw new Error("Invalid audio endpoint");
    const socket = connect(expected); const connection: Connection = { owner, audioId, socket, sequence: 0, busy: false, attached: false }; this.#connections.set(audioId, connection);
    socket.on("error", () => {}); socket.once("close", () => { if (this.#connections.get(audioId) === connection) this.#connections.delete(audioId); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Audio attach timed out")), 5000); let response = "";
        const finish = (error?: Error) => { clearTimeout(timer); socket.off("error", failed); socket.off("close", closed); socket.off("data", received); if (error) reject(error); else resolve(); };
        const failed = () => finish(new Error("Audio connection failed")); const closed = () => finish(new Error("Audio detached"));
        const received = (data: Buffer) => { response += data.toString("ascii"); if (response === "OK\n") finish(); else if (response.length >= 3) failed(); };
        socket.once("error", failed); socket.once("close", closed); socket.on("data", received);
        socket.once("connect", () => socket.write(descriptor.token + "\n"));
      });
      if (generation !== this.#generations.get(owner) || socket.destroyed) throw new Error("Window no longer owns audio");
      connection.attached = true;
    } catch (cause) { socket.destroy(); throw cause; }
  }
  #owned(owner: number, raw: unknown): Connection { const value = this.#connections.get(identifier(raw)); if (!value || value.owner !== owner || !value.attached || value.socket.destroyed) throw new Error("Audio is not attached to this window"); return value; }
  async chunk(owner: number, raw: unknown): Promise<void> {
    const input = record(raw, ["audioId", "sequence", "bytes"]), connection = this.#owned(owner, input.audioId);
    if (connection.busy || input.sequence !== connection.sequence || !(input.bytes instanceof ArrayBuffer) || !input.bytes.byteLength || input.bytes.byteLength > 12800 || input.bytes.byteLength % 4) throw new Error("Invalid or out-of-order PCM chunk");
    const samples = new DataView(input.bytes); for (let offset = 0; offset < samples.byteLength; offset += 4) { const value = samples.getFloat32(offset, true); if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error("Invalid PCM samples"); }
    const frame = Buffer.alloc(4 + input.bytes.byteLength); frame.writeUInt32LE(input.bytes.byteLength); Buffer.from(input.bytes).copy(frame, 4); connection.busy = true;
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { connection.socket.destroy(); reject(new Error("Audio backpressure timed out")); }, 2000); connection.socket.write(frame, error => { clearTimeout(timer); if (error) reject(error); else resolve(); }); });
      connection.sequence++;
    } finally { connection.busy = false; }
  }
  detach(owner: number, raw: unknown): void { const input = record(raw, ["audioId"]); const connection = this.#connections.get(identifier(input.audioId)); if (connection?.owner === owner) { connection.socket.destroy(); this.#connections.delete(connection.audioId); } }
  disposeWindow(owner: number): void { this.#generations.set(owner, (this.#generations.get(owner) ?? 0) + 1); for (const connection of this.#connections.values()) if (connection.owner === owner) { connection.socket.destroy(); this.#connections.delete(connection.audioId); } }
  dispose(): void { for (const owner of this.#generations.keys()) this.disposeWindow(owner); }
}
export function registerLiveAudioIpc(options: { ipcMain: TerminalIpcMain; isTrustedSender(sender: TerminalSender): boolean; isVisible(sender: TerminalSender): boolean; manager: DesktopLiveAudio }): { dispose(): void } {
  const tracked = new Set<number>();
  for (const [kind, channel] of Object.entries(LIVE_AUDIO_CHANNELS)) options.ipcMain.handle(channel, async ({ sender }, payload): Promise<LiveAudioResult> => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) throw new Error("Untrusted audio sender");
    if (!tracked.has(sender.id)) { tracked.add(sender.id); const cleanup = () => { tracked.delete(sender.id); options.manager.disposeWindow(sender.id); }; sender.once("destroyed", cleanup); sender.once("did-navigate", cleanup); }
    try {
      if (kind !== "detach" && !options.isVisible(sender)) { options.manager.disposeWindow(sender.id); throw new Error("Hidden window"); }
      if (kind === "attach") await options.manager.attach(sender.id, payload);
      else if (kind === "chunk") await options.manager.chunk(sender.id, payload);
      else options.manager.detach(sender.id, payload);
      if (kind !== "detach" && !options.isVisible(sender)) { options.manager.disposeWindow(sender.id); throw new Error("Window hidden during audio operation"); }
      return { ok: true };
    } catch { return { ok: false, message: "Live microphone connection ended. Reconnect explicitly from a visible desktop window." }; }
  });
  return { dispose() { for (const owner of tracked) options.manager.disposeWindow(owner); tracked.clear(); for (const channel of Object.values(LIVE_AUDIO_CHANNELS)) options.ipcMain.removeHandler(channel); } };
}
