import { connect, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { desktopText } from "./desktop-language-shared.js";
import type { TerminalSender, TerminalIpcMain } from "./terminal-ipc.js";
import {
  PREDICTION_CHANNELS,
  type PredictionResult,
} from "./prediction-shared.js";
import type { PredictionEvent, PredictionInput } from "@omp-studio/studio-protocol";
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid prediction ID");
  return value;
};
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("Invalid prediction fields");
  return value as Record<string, unknown>;
}
class PredictionChannelLost extends Error {}

interface Entry {
  sender: TerminalSender;
  socket?: Socket;
  attached: boolean;
  importing?:
    | {
        id: string;
        resolve: (value: PredictionResult) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
}
export class DesktopPrediction {
  readonly #activeImports = new Set<number>();
  readonly #connections = new Map<string, Entry>();
  constructor(
    readonly options: {
      directory(): string;
      socketDirectory(): Promise<string>;
      chooseHistory(sender: TerminalSender): Promise<string | undefined>;
    },
  ) {}
  async attach(sender: TerminalSender, value: unknown): Promise<void> {
    // The renderer forwards the channel `prediction.prepare` returned. Protocol
    // v2 adds ranked choices to the same private event stream.
    const input = object(value),
      channelId = id(input.channelId);
    if (input.protocolVersion !== undefined && input.protocolVersion !== 2)
      throw new Error("Invalid prediction protocol");
    if (
      typeof input.sessionId !== "string" ||
      !input.sessionId ||
      input.sessionId.length > 128
    )
      throw new Error("Invalid prediction session");
    if (this.#connections.has(channelId))
      throw new Error(desktopText("预测通道已被占用", "Prediction channel is already in use"));
    const entry: Entry = { sender, attached: false };
    this.#connections.set(channelId, entry);
    try {
      await this.#connect(channelId, input.sessionId, entry);
    } catch (error) {
      this.#disconnect(channelId, entry);
      throw error;
    }
  }

  async #connect(channelId: string, sessionId: string, entry: Entry): Promise<void> {
    const { sender } = entry;
    const file = join(
        this.options.directory(),
        "prediction",
        channelId + ".json",
      ),
      stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw new Error("Prediction descriptor unavailable");
    const descriptor = object(JSON.parse(await readFile(file, "utf8")));
    const endpoint =
      process.platform === "win32"
        ? "\\\\.\\pipe\\omp-studio-predict-" + channelId
        : join(
            await this.options.socketDirectory(),
            "p-" +
              createHash("sha256")
                .update(channelId)
                .digest("hex")
                .slice(0, 16) +
              ".sock",
          );
    if (
      descriptor.version !== 1 ||
      descriptor.channelId !== channelId ||
      descriptor.sessionId !== sessionId ||
      descriptor.endpoint !== endpoint ||
      typeof descriptor.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(descriptor.token) ||
      typeof descriptor.expiresAt !== "number" ||
      descriptor.expiresAt > Date.now() + 30000
    )
      throw new Error("Prediction descriptor expired or changed");
    if (
      descriptor.expiresAt < Date.now() ||
      this.#connections.get(channelId) !== entry ||
      sender.isDestroyed()
    )
      throw new PredictionChannelLost("Prediction descriptor expired or changed");
    const socket = entry.socket = connect(endpoint);
    socket.setEncoding("utf8");
    let accept!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => {
        accept = resolve;
        reject = fail;
      }),
      timer = setTimeout(() => {
        reject(new PredictionChannelLost("Prediction attach timed out"));
        socket.destroy();
      }, 5000);
    let pending = "";
    socket.on("error", () => reject(new PredictionChannelLost("Prediction connection failed")));
    socket.once("connect", () => socket.write(descriptor.token + "\n"));
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new PredictionChannelLost("Prediction detached"));
      entry.importing?.resolve({
        ok: false,
        message:
          "Prediction import interrupted and may have partially completed; it was not retried",
      });
      if (entry.importing) clearTimeout(entry.importing.timer);
      if (this.#connections.get(channelId) === entry)
        this.#connections.delete(channelId);
      if (entry.attached && !sender.isDestroyed() && !this.#connections.has(channelId))
        sender.send(PREDICTION_CHANNELS.event, { kind: "closed", channelId });
    });
    socket.on("data", (part: string) => {
      pending += part;
      if (Buffer.byteLength(pending) > 32768) {
        socket.destroy();
        return;
      }
      for (
        let at = pending.indexOf("\n");
        at >= 0;
        at = pending.indexOf("\n")
      ) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!entry.attached) {
          if (line !== "OK") {
            socket.destroy();
            return;
          }
          entry.attached = true;
          clearTimeout(timer);
          accept();
          continue;
        }
        try {
          const event = JSON.parse(line) as PredictionEvent;
          if (event.channelId !== channelId)
            throw new Error("Prediction target changed");
          if (
            event.kind === "imported" &&
            event.requestId === entry.importing?.id
          ) {
            clearTimeout(entry.importing.timer);
            entry.importing.resolve({
              ok: true,
              count: event.count,
              truncated: event.truncated,
            });
            entry.importing = undefined;
          }
          if (
            event.kind === "error" &&
            event.requestId &&
            event.requestId === entry.importing?.id
          ) {
            clearTimeout(entry.importing.timer);
            entry.importing.resolve({ ok: false, message: event.message });
            entry.importing = undefined;
          }
          if (
            !sender.isDestroyed() &&
            this.#connections.get(channelId) === entry
          )
            sender.send(PREDICTION_CHANNELS.event, event);
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    await ready;
    if (this.#connections.get(channelId) !== entry || socket.destroyed)
      throw new PredictionChannelLost("Prediction detached");
  }
  input(sender: TerminalSender, value: unknown): void {
    const raw = object(value);
    if ((raw.input as PredictionInput).kind === "import")
      throw new Error("History imports require the file picker");
    const entry = this.#entry(sender, id(raw.channelId));
    if (entry.socket.writableLength > 32768)
      throw new Error("Prediction input buffer is full");
    entry.socket.write(JSON.stringify(raw.input) + "\n");
  }
  #entry(sender: TerminalSender, channelId: string): Entry & { socket: Socket } {
    const entry = this.#connections.get(channelId);
    if (
      !entry?.attached ||
      entry.sender.id !== sender.id ||
      !entry.socket ||
      entry.socket.destroyed
    )
      throw new PredictionChannelLost("Prediction channel is not owned by this window");
    return entry as Entry & { socket: Socket };
  }
  #disconnect(channelId: string, entry: Entry): void {
    if (this.#connections.get(channelId) === entry)
      this.#connections.delete(channelId);
    entry.socket?.destroy();
  }
  detach(sender: TerminalSender, value: unknown): void {
    const channelId = id(object(value).channelId);
    const entry = this.#connections.get(channelId);
    if (entry?.sender.id === sender.id) this.#disconnect(channelId, entry);
  }
  async importHistory(
    sender: TerminalSender,
    value: unknown,
    isVisible?: (sender: TerminalSender) => boolean,
  ): Promise<PredictionResult> {
    if (this.#activeImports.has(sender.id))
      throw new Error("A history import is already running");
    this.#activeImports.add(sender.id);
    try {
      return await this.#importHistory(sender, value, isVisible);
    } finally {
      this.#activeImports.delete(sender.id);
    }
  }
  async #importHistory(
    sender: TerminalSender,
    value: unknown,
    isVisible?: (sender: TerminalSender) => boolean,
  ): Promise<PredictionResult> {
    const channelId = id(object(value).channelId),
      entry = this.#entry(sender, channelId);
    if (entry.importing) throw new Error("A history import is already running");
    const selected = await this.options.chooseHistory(sender);
    if (!selected) return { ok: true, cancelled: true };
    if (isVisible && !isVisible(sender)) {
      this.disposeWindow(sender.id);
      throw new PredictionChannelLost("Prediction requires a visible window");
    }
    if (this.#connections.get(channelId) !== entry || sender.isDestroyed())
      throw new PredictionChannelLost("Prediction session changed");
    const stat = await lstat(selected);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new Error("Select a JSONL history file no larger than 8 MiB");
    const transferId = randomUUID(),
      requestId = randomUUID(),
      directory = join(this.options.directory(), "prediction-imports"),
      target = join(directory, transferId + ".jsonl");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > 8 * 1024 * 1024
            ? new Error("History file exceeds 8 MiB")
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        createReadStream(selected),
        bounded,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
      );
      if (isVisible && !isVisible(sender)) {
        this.disposeWindow(sender.id);
        throw new PredictionChannelLost("Prediction requires a visible window");
      }
      if (this.#connections.get(channelId) !== entry || sender.isDestroyed())
        throw new PredictionChannelLost("Prediction session changed");
      const result = new Promise<PredictionResult>((resolve) => {
        const timer = setTimeout(() => {
          if (entry.importing?.id === requestId) {
            entry.importing = undefined;
            resolve({
              ok: false,
              message: "Prediction import timed out; it was not retried",
            });
          }
        }, 90000);
        entry.importing = { id: requestId, resolve, timer };
      });
      entry.socket.write(
        JSON.stringify({ kind: "import", requestId, transferId }) + "\n",
      );
      return await result;
    } finally {
      await unlink(target).catch(() => {});
    }
  }
  disposeWindow(owner: number): void {
    for (const [channelId, entry] of this.#connections)
      if (entry.sender.id === owner) this.#disconnect(channelId, entry);
  }
  dispose(): void {
    for (const [channelId, entry] of this.#connections)
      this.#disconnect(channelId, entry);
  }
}
export function registerPredictionIpc(options: {
  ipcMain: TerminalIpcMain;
  manager: DesktopPrediction;
  isTrustedSender(sender: TerminalSender): boolean;
  isVisible(sender: TerminalSender): boolean;
}): { dispose(): void } {
  const owners = new Map<number, () => void>();
  for (const kind of ["attach", "input", "detach", "import"] as const)
    options.ipcMain.handle(
      PREDICTION_CHANNELS[kind],
      async ({ sender }, input): Promise<PredictionResult> => {
        if (sender.isDestroyed() || !options.isTrustedSender(sender))
          throw new Error("Untrusted prediction request");
        if (kind !== "detach" && !options.isVisible(sender)) {
          options.manager.disposeWindow(sender.id);
          return { ok: false, channelLost: true, message: "Prediction requires a visible window" };
        }
        if (!owners.has(sender.id)) {
          const dispose = () => {
            owners.delete(sender.id);
            options.manager.disposeWindow(sender.id);
            sender.off("destroyed", dispose);
            sender.off("did-navigate", dispose);
            sender.off("render-process-gone", dispose);
          };
          owners.set(sender.id, dispose);
          sender.once("destroyed", dispose);
          sender.once("did-navigate", dispose);
          sender.once("render-process-gone", dispose);
        }
        try {
          if (kind === "attach") {
            await options.manager.attach(sender, input);
            if (!options.isVisible(sender)) {
              options.manager.disposeWindow(sender.id);
              return { ok: false, channelLost: true, message: "Prediction requires a visible window" };
            }
          } else if (kind === "input") options.manager.input(sender, input);
          else if (kind === "detach") options.manager.detach(sender, input);
          else return await options.manager.importHistory(sender, input, options.isVisible);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            ...(error instanceof PredictionChannelLost ||
            (kind === "attach" && error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")
              ? { channelLost: true }
              : {}),
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
  return {
    dispose() {
      for (const kind of ["attach", "input", "detach", "import"] as const)
        options.ipcMain.removeHandler(PREDICTION_CHANNELS[kind]);
      for (const dispose of owners.values()) dispose();
    },
  };
}
