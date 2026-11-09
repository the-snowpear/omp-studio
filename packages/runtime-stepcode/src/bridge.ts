import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { FrameDecoder, encodeFrame } from "@omp-studio/studio-protocol";

/** Protocol version this adapter speaks. Mirrors STUDIO_PROTOCOL_VERSION. */
export const PROTOCOL_VERSION = 1;

/**
 * The handshake proof the host verifies: HMAC-SHA256(token, challenge + NUL +
 * runtimeInstanceId), base64url. Same construction as the OMP runtime so the
 * host needs no Step-specific branch.
 */
export function challengeProof(token: string, challenge: string, runtimeInstanceId: string): string {
  return createHmac("sha256", token).update(challenge).update("\0").update(runtimeInstanceId).digest("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One authenticated bridge connection: framed JSON in, framed JSON out. */
/** How many terminal receipts a reconnect can recover. */
const TERMINAL_RECEIPT_HISTORY = 64;

export class BridgeConnection {
  #decoder = new FrameDecoder();
  #seq = 0;

  constructor(
    private readonly socket: Socket,
    private readonly runtimeEpoch: number,
    /**
     * Terminal outcomes shared across connections. A reconnect gets a new
     * BridgeConnection, so history kept per connection would be empty exactly
     * when the Host needs it.
     */
    private readonly sharedTerminalReceipts: Array<Record<string, unknown>> = [],
  ) {}

  /** Highest eventSeq emitted on this connection; a snapshot must report it. */
  get lastEventSeq(): number {
    return this.#seq;
  }

  onFrame(handler: (body: Record<string, unknown>) => void): void {
    this.socket.on("data", chunk => {
      for (const frame of this.#decoder.push(chunk)) {
        handler(frame.body as Record<string, unknown>);
      }
    });
  }

  /** Drop this connection; the runtime itself stays alive for the next Host. */
  close(): void {
    this.socket.destroy();
  }

  send(body: unknown): void {
    this.socket.write(encodeFrame(randomUUID(), this.runtimeEpoch as never, body));
  }

  event(event: unknown, stateVersion: number): void {
    this.#seq += 1;
    this.send({
      type: "studio.event",
      runtimeEpoch: this.runtimeEpoch,
      eventSeq: this.#seq,
      stateVersion,
      occurredAt: new Date().toISOString(),
      event,
    });
  }

  failedReceipt(requestId: string, message: string, code = "INTERNAL_ERROR"): void {
    this.#terminal({
      type: "studio.receipt",
      requestId,
      commandId: randomUUID(),
      runtimeEpoch: this.runtimeEpoch,
      stateVersion: 0,
      status: "failed",
      error: { code, message, retryable: false },
    });
  }

  receipt(requestId: string, status: "accepted" | "completed" | "rejected" | "failed" | "outcome_unknown", result?: unknown): void {
    const receipt: Record<string, unknown> = {
      type: "studio.receipt",
      requestId,
      commandId: randomUUID(),
      runtimeEpoch: this.runtimeEpoch,
      stateVersion: 0,
      status,
      ...(result === undefined ? {} : { result }),
    };
    // Only terminal outcomes settle a command; `accepted` is not one, and
    // replaying it would resolve nothing.
    if (status !== "accepted") this.#terminal(receipt);
    else this.send(receipt);
  }

  /**
   * Terminal outcomes a reconnect may have missed. The Host reconciles only
   * receipts for commands it issued, so replaying history is safe; without it a
   * receipt lost in transit leaves that command pending forever.
   */
  get terminalReceipts(): ReadonlyArray<Record<string, unknown>> {
    return this.sharedTerminalReceipts;
  }

  #terminal(receipt: Record<string, unknown>): void {
    this.sharedTerminalReceipts.push(receipt);
    if (this.sharedTerminalReceipts.length > TERMINAL_RECEIPT_HISTORY) this.sharedTerminalReceipts.shift();
    this.send(receipt);
  }
}
