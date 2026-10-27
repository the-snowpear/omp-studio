import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { encodeFrame, FrameDecoder, type RuntimeEpoch } from "@omp-studio/studio-protocol";
import { RemoteConnectionError, sshFailure, type RemoteConnectionErrorCode } from "./errors.js";

export const REMOTE_PROTOCOL_VERSION = 3;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const WIRE_EPOCH = 1 as RuntimeEpoch;
export type RemoteMethod = "hello" | "ping" | "bootstrap" | "query" | "command" | "subscribe" | "workspace.register" | "workspace.path" | "directories" | "shutdown" | "network.open" | "network.configure" | "network.reset" | "provisioning.apply";
const METHODS = new Set<RemoteMethod>(["hello", "ping", "bootstrap", "query", "command", "subscribe", "workspace.register", "workspace.path", "directories", "shutdown", "network.open", "network.configure", "network.reset", "provisioning.apply"]);
export interface RemoteAttachment { key: string; sequence: number; }
export class RemoteOperationError extends Error {}
export class RemoteRequestTimeout extends Error {
  constructor() { super("Remote request timed out; its outcome may be unknown. It was not retried."); }
}

type Message =
  | { type: "request"; id: string; method: RemoteMethod; input: unknown }
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: string; connectionCode?: RemoteConnectionErrorCode }
  | { type: "event"; event: unknown };

export class RemotePeer {
  readonly #decoder = new FrameDecoder(MAX_FRAME_BYTES);
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly #events = new Set<(event: unknown) => void>();
  readonly #closedListeners = new Set<(error: Error) => void>();
  readonly #timeouts = new Set<(method: RemoteMethod) => void>();
  #handler: ((method: RemoteMethod, input: unknown) => Promise<unknown>) | undefined;
  #closed: Error | undefined;
  #requests = 0;

  constructor(readonly input: Readable, readonly output: Writable, readonly timeoutMs = 30_000, readonly endError: () => Error = () => new RemoteConnectionError("network", "Remote connection closed; pending command outcomes are unknown")) {
    input.on("data", this.#onData);
    input.once("end", this.#onEnd);
    input.once("close", this.#onEnd);
    input.once("error", this.#onError);
    output.on("error", this.#onError);
    output.once("close", this.#onEnd);
  }

  handle(handler: (method: RemoteMethod, input: unknown) => Promise<unknown>): void { this.#handler = handler; }
  onEvent(listener: (event: unknown) => void): () => void { this.#events.add(listener); return () => { this.#events.delete(listener); }; }
  onTimeout(listener: (method: RemoteMethod) => void): () => void { this.#timeouts.add(listener); return () => { this.#timeouts.delete(listener); }; }
  onClose(listener: (error: Error) => void): () => void {
    if (this.#closed) { listener(this.#closed); return () => {}; }
    this.#closedListeners.add(listener);
    return () => { this.#closedListeners.delete(listener); };
  }

  request<T>(method: RemoteMethod, input: unknown = null, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#pending.size >= 64) return Promise.reject(new Error("Too many pending remote requests"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RemoteRequestTimeout());
        for (const listener of this.#timeouts) listener(method);
      }, timeoutMs);
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.#send({ type: "request", id, method, input }); }
      catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  publish(event: unknown): void { this.#send({ type: "event", event }); }

  close(error = this.endError()): void {
    if (this.#closed) return;
    this.#closed = error;
    this.input.off("data", this.#onData);
    this.input.off("end", this.#onEnd);
    this.input.off("close", this.#onEnd);
    this.output.off("close", this.#onEnd);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#events.clear();
    this.#timeouts.clear();
    for (const listener of this.#closedListeners) listener(error);
    this.#closedListeners.clear();
    this.input.destroy();
    this.output.destroy();
  }

  readonly #onEnd = (): void => { this.close(); };
  readonly #onError = (error: Error): void => { this.close(sshFailure("", error)); };
  readonly #onData = (chunk: Buffer): void => {
    try {
      for (const frame of this.#decoder.push(chunk)) this.#receive(frame.body);
    } catch { this.close(new RemoteConnectionError("protocol", "远端控制协议异常，已停止连接；不会重发命令")); }
  };

  #send(message: Message): void {
    if (this.#closed) throw this.#closed;
    const frame = encodeFrame(randomUUID(), WIRE_EPOCH, message, MAX_FRAME_BYTES);
    if (this.output.writableLength + frame.byteLength > MAX_BUFFERED_BYTES) {
      const error = new RemoteConnectionError("network", "Remote connection is too slow; reconnect to resynchronize");
      this.close(error);
      throw error;
    }
    this.output.write(frame);
  }

  #receive(value: unknown): void {
    if (this.#closed) return;
    if (!value || typeof value !== "object") throw new Error("Invalid remote envelope");
    const message = value as Message;
    if (message.type === "event") { for (const listener of this.#events) listener(message.event); return; }
    if (typeof message.id !== "string" || message.id.length > 128) throw new Error("Invalid remote request identity");
    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.result);
      else {
        const text = typeof message.error === "string" ? message.error : "Remote request failed";
        pending.reject(message.connectionCode ? new RemoteConnectionError(message.connectionCode, text) : new RemoteOperationError(text));
      }
      return;
    }
    if (message.type !== "request" || !METHODS.has(message.method)) throw new Error("Unknown remote method");
    if (++this.#requests > 64) throw new Error("Too many incoming remote requests");
    void Promise.resolve().then(() => {
      if (this.#closed) return;
      if (!this.#handler) throw new Error("Remote request handler unavailable");
      return this.#handler(message.method, message.input);
    }).then(
      result => { if (!this.#closed) this.#send({ type: "response", id: message.id, ok: true, result }); },
      error => { if (!this.#closed) this.#send({ type: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : "Remote operation failed", ...(error instanceof RemoteConnectionError ? { connectionCode: error.connectionCode } : error instanceof RemoteRequestTimeout ? { connectionCode: "network" as const } : {}) }); },
    ).catch(error => this.close(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { this.#requests--; });
  }
}
