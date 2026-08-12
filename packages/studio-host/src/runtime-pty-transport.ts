import { PtyAttachTicketRegistry, type PtyRuntimeBinding } from "./pty-ticket.js";

export interface RuntimePtyPort {
  write(data: Uint8Array): Promise<void> | void;
  resize(columns: number, rows: number): Promise<void> | void;
  signal(signal: string): Promise<void> | void;
  terminate(): Promise<void> | void;
  close(): Promise<void> | void;
}

/** Opaque PTY byte transport. It intentionally performs no semantic terminal parsing. */
export class RuntimePtyTransport {
  #tail = Buffer.alloc(0);
  #closed = false;

  constructor(
    readonly binding: PtyRuntimeBinding,
    private readonly tickets: PtyAttachTicketRegistry,
    private readonly port: RuntimePtyPort,
    private readonly maxTailBytes = 256 * 1024,
  ) {
    if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1) throw new RangeError("PTY tail limit must be positive");
  }

  acceptOutput(data: Uint8Array): void {
    this.#assertOpen();
    const combined = Buffer.concat([this.#tail, Buffer.from(data)]);
    this.#tail = combined.length <= this.maxTailBytes ? combined : combined.subarray(combined.length - this.maxTailBytes);
  }

  outputTail(): Buffer {
    return Buffer.from(this.#tail);
  }

  async write(token: string, data: Uint8Array): Promise<void> {
    this.#authorize(token, "write");
    await this.port.write(data);
  }

  async resize(token: string, columns: number, rows: number): Promise<void> {
    this.#authorize(token, "resize");
    if (!Number.isSafeInteger(columns) || columns < 1 || !Number.isSafeInteger(rows) || rows < 1) {
      throw new RangeError("PTY dimensions must be positive integers");
    }
    await this.port.resize(columns, rows);
  }

  async signal(token: string, signal: string): Promise<void> {
    this.#authorize(token, "signal");
    if (signal.length === 0) throw new TypeError("PTY signal is required");
    await this.port.signal(signal);
  }

  async terminate(token: string): Promise<void> {
    this.#authorize(token, "terminate");
    await this.port.terminate();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.tickets.revokeRuntime(this.binding);
    await this.port.close();
  }

  #authorize(token: string, action: "write" | "resize" | "signal" | "terminate"): void {
    this.#assertOpen();
    this.tickets.consume(token, this.binding, action);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("PTY transport is closed");
  }
}
