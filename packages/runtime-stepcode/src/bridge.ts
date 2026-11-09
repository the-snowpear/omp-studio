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
export class BridgeConnection {
  #decoder = new FrameDecoder();
  #seq = 0;

  constructor(
    private readonly socket: Socket,
    private readonly runtimeEpoch: number,
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
    this.send({
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
    this.send({
      type: "studio.receipt",
      requestId,
      commandId: randomUUID(),
      runtimeEpoch: this.runtimeEpoch,
      stateVersion: 0,
      status,
      ...(result === undefined ? {} : { result }),
    });
  }
}
