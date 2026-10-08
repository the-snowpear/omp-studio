import { connect, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  validatePredictionEvent,
  validatePredictionInput,
  type PredictionEvent,
} from "@omp-studio/studio-protocol";
import type { TerminalSender, TerminalIpcMain } from "./terminal-ipc.js";
import {
  PREDICTION_CHANNELS,
  type PredictionResult,
} from "./prediction-shared.js";
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid prediction ID");
  return value;
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid prediction fields");
  return value as Record<string, unknown>;
}
interface Entry {
  id: string;
  sessionId: string;
  sender: TerminalSender;
  socket: Socket;
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
  readonly #connections = new Map<number, Entry>();
  readonly #generation = new Map<number, number>();
  constructor(
    readonly options: {
      directory(): string;
      socketDirectory(): Promise<string>;
      chooseHistory(sender: TerminalSender): Promise<string | undefined>;
    },
  ) {}
  async attach(sender: TerminalSender, value: unknown): Promise<void> {
    const input = object(value, ["channelId", "sessionId", "expiresAt"]),
      channelId = id(input.channelId);
    if (
      typeof input.sessionId !== "string" ||
      !input.sessionId ||
      input.sessionId.length > 128
    )
      throw new Error("Invalid prediction session");
    this.disposeWindow(sender.id);
    const generation = this.#generation.get(sender.id);
    const file = join(
        this.options.directory(),
        "prediction",
        channelId + ".json",
      ),
      stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw new Error("Prediction descriptor unavailable");
    const descriptor = object(JSON.parse(await readFile(file, "utf8")), [
      "version",
      "channelId",
      "sessionId",
      "endpoint",
      "token",
      "expiresAt",
    ]);
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
      descriptor.sessionId !== input.sessionId ||
      descriptor.endpoint !== endpoint ||
      typeof descriptor.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(descriptor.token) ||
      typeof descriptor.expiresAt !== "number" ||
      descriptor.expiresAt < Date.now() ||
      descriptor.expiresAt > Date.now() + 30000 ||
      generation !== this.#generation.get(sender.id) ||
      sender.isDestroyed()
    )
      throw new Error("Prediction descriptor expired or changed");
    const socket = connect(endpoint),
      entry: Entry = {
        id: channelId,
        sessionId: input.sessionId,
        sender,
        socket,
        attached: false,
      };
    socket.setEncoding("utf8");
    this.#connections.set(sender.id, entry);
    let accept!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => {
        accept = resolve;
        reject = fail;
      }),
      timer = setTimeout(() => {
        reject(new Error("Prediction attach timed out"));
        socket.destroy();
      }, 5000);
    let pending = "";
    socket.on("error", () => reject(new Error("Prediction connection failed")));
    socket.once("connect", () => socket.write(descriptor.token + "\n"));
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Prediction detached"));
      entry.importing?.resolve({
        ok: false,
        message:
          "Prediction import interrupted and may have partially completed; it was not retried",
      });
      if (entry.importing) clearTimeout(entry.importing.timer);
      if (this.#connections.get(sender.id) === entry)
        this.#connections.delete(sender.id);
      if (!sender.isDestroyed())
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
          const event: unknown = JSON.parse(line);
          validatePredictionEvent(event);
          if (event.channelId !== entry.id)
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
            this.#connections.get(sender.id) === entry
          )
            sender.send(PREDICTION_CHANNELS.event, event);
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    try {
      await ready;
      if (generation !== this.#generation.get(sender.id) || socket.destroyed)
        throw new Error("Prediction owner changed");
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  input(sender: TerminalSender, value: unknown): void {
    const raw = object(value, ["channelId", "input"]);
    validatePredictionInput(raw.input);
    if (raw.input.kind === "import")
      throw new Error("History imports require the file picker");
    const entry = this.#entry(sender, raw.channelId);
    if (entry.socket.writableLength > 32768)
      throw new Error("Prediction input buffer is full");
    entry.socket.write(JSON.stringify(raw.input) + "\n");
  }
  #entry(sender: TerminalSender, channelId: unknown): Entry {
    const entry = this.#connections.get(sender.id);
    if (
      !entry?.attached ||
      entry.id !== id(channelId) ||
      entry.socket.destroyed
    )
      throw new Error("Prediction channel is not owned by this window");
    return entry;
  }
  detach(sender: TerminalSender, value: unknown): void {
    const input = object(value, ["channelId"]);
    if (this.#connections.get(sender.id)?.id === id(input.channelId))
      this.disposeWindow(sender.id);
  }
  async importHistory(
    sender: TerminalSender,
    value: unknown,
  ): Promise<PredictionResult> {
    if (this.#activeImports.has(sender.id))
      throw new Error("A history import is already running");
    this.#activeImports.add(sender.id);
    try {
      return await this.#importHistory(sender, value);
    } finally {
      this.#activeImports.delete(sender.id);
    }
  }
  async #importHistory(
    sender: TerminalSender,
    value: unknown,
  ): Promise<PredictionResult> {
    const raw = object(value, ["channelId"]),
      entry = this.#entry(sender, raw.channelId);
    if (entry.importing) throw new Error("A history import is already running");
    const selected = await this.options.chooseHistory(sender);
    if (!selected) return { ok: true, cancelled: true };
    if (this.#connections.get(sender.id) !== entry || sender.isDestroyed())
      throw new Error("Prediction session changed");
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
      if (this.#connections.get(sender.id) !== entry)
        throw new Error("Prediction session changed");
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
    this.#generation.set(owner, (this.#generation.get(owner) ?? 0) + 1);
    this.#connections.get(owner)?.socket.destroy();
    this.#connections.delete(owner);
  }
  dispose(): void {
    for (const owner of this.#connections.keys()) this.disposeWindow(owner);
  }
}
export function registerPredictionIpc(options: {
  ipcMain: TerminalIpcMain;
  manager: DesktopPrediction;
  isTrustedSender(sender: TerminalSender): boolean;
  isVisible(sender: TerminalSender): boolean;
}): { dispose(): void } {
  const owners = new Set<number>();
  for (const kind of ["attach", "input", "detach", "import"] as const)
    options.ipcMain.handle(
      PREDICTION_CHANNELS[kind],
      async ({ sender }, input): Promise<PredictionResult> => {
        if (sender.isDestroyed() || !options.isTrustedSender(sender))
          throw new Error("Untrusted prediction request");
        if (kind !== "detach" && !options.isVisible(sender)) {
          options.manager.disposeWindow(sender.id);
          return { ok: false, message: "Prediction requires a visible window" };
        }
        if (!owners.has(sender.id)) {
          owners.add(sender.id);
          sender.once("destroyed", () => {
            owners.delete(sender.id);
            options.manager.disposeWindow(sender.id);
          });
        }
        try {
          if (kind === "attach") await options.manager.attach(sender, input);
          else if (kind === "input") options.manager.input(sender, input);
          else if (kind === "detach") options.manager.detach(sender, input);
          else return await options.manager.importHistory(sender, input);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
  return {
    dispose() {
      for (const kind of ["attach", "input", "detach", "import"] as const)
        options.ipcMain.removeHandler(PREDICTION_CHANNELS[kind]);
      for (const owner of owners) options.manager.disposeWindow(owner);
      owners.clear();
    },
  };
}
