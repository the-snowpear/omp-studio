import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  FrameDecoder,
  STUDIO_PROTOCOL_VERSION,
  encodeFrame,
  parseAgentTranscriptPage,
  parseConversationTranscriptPage,
  parseStudioEventEnvelope,
  parseStudioHelloResponse,
  parseOperatorCommandManifest,
  parseStudioReceipt,
  parseStudioSnapshotResponse,
  type AgentId,
  type AgentTranscriptPage,
  type ConversationTranscriptPage,
  type OpaqueCursor,
  type RequestId,
  type DecodedFrame,
  type RuntimeEpoch,
  type RuntimeInstanceId,
  type StudioEventEnvelope,
  type StudioHelloRequest,
  type StudioHelloResponse,
  type StudioRequest,
  type StudioReceipt,
  type StudioSnapshotResponse,
  type OperatorCommandManifest,
  type SessionTranscriptRead,
} from "@omp-studio/studio-protocol";
import { verifyChallengeProof } from "./bridge-auth.js";
import { StudioHostError } from "./command-arbiter.js";
import { RuntimeProjection } from "./runtime-projection.js";

export type StudioBridgeClientState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "negotiated"
  | "snapshotting"
  | "snapshot-required"
  | "ready"
  | "disconnected"
  | "closed";

export type StudioBridgeHandshakeErrorCode =
  | "CONNECTION_FAILED"
  | "HANDSHAKE_TIMEOUT"
  | "PROTOCOL_UNSUPPORTED"
  | "UNAUTHENTICATED"
  | "IDENTITY_CHANGED"
  | "MALFORMED_RESPONSE";

export class StudioBridgeHandshakeError extends Error {
  constructor(readonly code: StudioBridgeHandshakeErrorCode) {
    super(
      code === "HANDSHAKE_TIMEOUT"
        ? "Studio Bridge handshake timed out"
        : code === "PROTOCOL_UNSUPPORTED"
          ? "Studio Bridge protocol is unsupported"
          : code === "UNAUTHENTICATED"
            ? "Studio Bridge authentication failed"
            : code === "IDENTITY_CHANGED"
              ? "Studio Bridge runtime identity changed"
              : code === "MALFORMED_RESPONSE"
                ? "Studio Bridge returned a malformed response"
                : "Studio Bridge connection failed",
    );
    this.name = "StudioBridgeHandshakeError";
  }
}

export class StudioBridgeRequestError extends Error {
  constructor(readonly code: "CONNECTION_FAILED" | "OUTCOME_UNKNOWN") {
    super(code === "OUTCOME_UNKNOWN" ? "Studio Bridge command outcome is unknown" : "Studio Bridge request failed");
    this.name = "StudioBridgeRequestError";
  }
}

export interface StudioBridgeClientOptions {
  endpoint: string;
  token: string;
  handshakeTimeoutMs?: number;
  supportedProtocolVersions?: readonly number[];
  connectSocket?: (endpoint: string) => Socket;
  createChallenge?: () => string;
  createRequestId?: () => string;
  onEvent?: (event: StudioEventEnvelope) => void;
  onResyncRequired?: () => void;
  onProjectionChanged?: (snapshot: StudioSnapshotResponse["snapshot"]) => void;
  onDisconnect?: () => void;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly onReceipt?: (receipt: StudioReceipt) => void;
  readonly resolve: (receipt: StudioReceipt) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

const TERMINAL_RECEIPT_STATUSES = new Set<StudioReceipt["status"]>([
  "completed",
  "failed",
  "rejected",
  "outcome_unknown",
]);

export const READY_EVENT_QUEUE_MAX_FRAMES = 4_096;
export const READY_EVENT_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
const READY_EVENT_DRAIN_MAX_FRAMES = 256;
const READY_EVENT_DRAIN_BUDGET_MS = 4;

export class StudioBridgeClient {
  #state: StudioBridgeClientState = "idle";
  #socket: Socket | undefined;
  #token: string;
  #runtimeInstanceId: RuntimeInstanceId | undefined;
  #runtimeEpoch: RuntimeEpoch | undefined;
  #hello: StudioHelloResponse | undefined;
  #readyDataListener: ((chunk: Buffer) => void) | undefined;
  #readyEventQueue: DecodedFrame[] = [];
  #readyEventQueueHead = 0;
  #readyEventQueueBytes = 0;
  #readyEventDrainScheduled = false;
  #snapshotRecoveryScheduled = false;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #projectionListeners = new Set<(snapshot: StudioSnapshotResponse["snapshot"]) => void>();
  readonly #eventListeners = new Set<(event: StudioEventEnvelope) => void>();
  readonly #resyncListeners = new Set<() => void>();
  readonly #projection = new RuntimeProjection();

  constructor(private readonly options: StudioBridgeClientOptions) {
    if (options.endpoint.length === 0 || options.token.length === 0) {
      throw new TypeError("Studio Bridge endpoint and token are required");
    }
    this.#token = options.token;
  }

  get state(): StudioBridgeClientState {
    return this.#state;
  }

  async connect(): Promise<StudioHelloResponse> {
    if (this.#state !== "idle") throw new Error(`Cannot connect Studio Bridge from ${this.#state}`);
    return this.#handshake(false);
  }

  /**
   * Retry `CONNECTION_FAILED` until `deadline`. Windows named pipes are not
   * bound at spawn; a single connect hits ENOENT and must not fail the Host.
   * Other handshake failures (timeout, auth, protocol) are not retried.
   */
  async connectUntilReady(options: {
    readonly deadline: number;
    readonly retryDelayMs?: number;
    readonly hasExited?: () => boolean;
  }): Promise<StudioHelloResponse> {
    const retryDelayMs = options.retryDelayMs ?? 50;
    while (true) {
      try {
        return await this.connect();
      } catch (error) {
        if (
          !(error instanceof StudioBridgeHandshakeError) ||
          error.code !== "CONNECTION_FAILED" ||
          Date.now() >= options.deadline ||
          options.hasExited?.() === true
        ) {
          throw error;
        }
        const remaining = options.deadline - Date.now();
        if (remaining <= 0) throw error;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(retryDelayMs, remaining));
        });
      }
    }
  }

  disconnect(): void {
    if (!["negotiated", "snapshotting", "snapshot-required", "ready"].includes(this.#state)) return;
    this.#state = "disconnected";
    this.#detachReadyListener();
    this.#rejectPending("OUTCOME_UNKNOWN");
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  async reconnect(): Promise<StudioHelloResponse> {
    if (this.#state !== "disconnected" || this.#runtimeInstanceId === undefined) {
      throw new Error(`Cannot reconnect Studio Bridge from ${this.#state}`);
    }
    return this.#handshake(true);
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#detachReadyListener();
    this.#rejectPending("OUTCOME_UNKNOWN");
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#token = "";
  }

  async requestSnapshot(): Promise<StudioSnapshotResponse> {
    if (this.#state !== "negotiated" && this.#state !== "snapshot-required" && this.#state !== "ready") {
      throw new Error(`Cannot request Studio Bridge snapshot from ${this.#state}`);
    }
    if (this.#pendingRequests.size > 0) throw new Error("Cannot snapshot while Studio Bridge commands are pending");
    const socket = this.#socket;
    const hello = this.#hello;
    const runtimeEpoch = this.#runtimeEpoch;
    if (socket === undefined || hello === undefined || runtimeEpoch === undefined) {
      throw new Error("Studio Bridge negotiation is incomplete");
    }
    this.#detachReadyListener();
    this.#state = "snapshotting";
    const requestId = (this.options.createRequestId ?? randomUUID)();
    const decoder = new FrameDecoder();
    const request: StudioRequest = {
      type: "studio.request",
      requestId: requestId as RequestId,
      runtimeEpoch,
      operation: { kind: "runtime.snapshot" },
    };

    return new Promise<StudioSnapshotResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail("HANDSHAKE_TIMEOUT"), this.options.handshakeTimeoutMs ?? 10_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const fail = (code: StudioBridgeHandshakeErrorCode): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        if (this.#state !== "closed") this.#state = "disconnected";
        reject(new StudioBridgeHandshakeError(code));
      };
      const onError = (): void => fail("CONNECTION_FAILED");
      const onClose = (): void => fail("CONNECTION_FAILED");
      const onData = (chunk: Buffer): void => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          fail("MALFORMED_RESPONSE");
          return;
        }
        if (frames.length === 0) return;
        const snapshotIndex = frames.findIndex(
          (frame) =>
            frame.body !== null &&
            typeof frame.body === "object" &&
            "type" in frame.body &&
            frame.body.type === "studio.snapshot",
        );
        if (snapshotIndex < 0) return;
        let response: StudioSnapshotResponse;
        try {
          const snapshotFrame = frames[snapshotIndex]!;
          response = parseStudioSnapshotResponse(snapshotFrame.body);
          if (
            response.requestId !== requestId ||
            snapshotFrame.header.runtimeEpoch !== runtimeEpoch ||
            response.snapshot.runtimeEpoch !== runtimeEpoch
          ) {
            throw new Error("Snapshot identity mismatch");
          }
          this.#projection.applySnapshot(response);
        } catch {
          fail("MALFORMED_RESPONSE");
          return;
        }
        settled = true;
        cleanup();
        this.#state = "ready";
        this.#publishProjection(response.snapshot);
        this.#processReadyFrames(frames.slice(snapshotIndex + 1));
        if (this.#state === "ready") this.#attachReadyListener(socket, decoder);
        resolve(response);
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.write(encodeFrame(`snapshot:${requestId}`, runtimeEpoch, request));
    });
  }

  async invoke(request: StudioRequest, onReceipt?: (receipt: StudioReceipt) => void): Promise<StudioReceipt> {
    if (this.#state !== "ready") throw new Error(`Cannot invoke Studio Bridge command from ${this.#state}`);
    if (request.runtimeEpoch !== this.#runtimeEpoch) throw new Error("Studio Bridge request Runtime epoch is stale");
    if (this.#pendingRequests.has(request.requestId)) throw new Error(`Duplicate request id ${request.requestId}`);
    const socket = this.#socket;
    if (socket === undefined) throw new Error("Studio Bridge connection is unavailable");

    return new Promise<StudioReceipt>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#pendingRequests.delete(request.requestId);
              reject(new StudioBridgeRequestError("OUTCOME_UNKNOWN"));
              this.#scheduleSnapshotRecovery();
            }, timeoutMs);
      this.#pendingRequests.set(request.requestId, {
        resolve,
        reject,
        ...(onReceipt === undefined ? {} : { onReceipt }),
        ...(timer === undefined ? {} : { timer }),
      });
      try {
        socket.write(encodeFrame(`request:${request.requestId}`, request.runtimeEpoch, request));
      } catch {
        if (timer !== undefined) clearTimeout(timer);
        this.#pendingRequests.delete(request.requestId);
        reject(new StudioBridgeRequestError("CONNECTION_FAILED"));
      }
    });
  }

  projectionSnapshot(): StudioSnapshotResponse["snapshot"] | undefined {
    return this.#projection.snapshot();
  }

  messagesCursor(): OpaqueCursor | undefined {
    return this.#projection.messagesCursor();
  }

  async requestCommandManifest(): Promise<OperatorCommandManifest> {
    const runtimeEpoch = this.#runtimeEpoch;
    if (runtimeEpoch === undefined) throw new Error("Studio Bridge negotiation is incomplete");
    const requestId = (this.options.createRequestId ?? randomUUID)();
    const receipt = await this.invoke({
      type: "studio.request",
      requestId: requestId as RequestId,
      runtimeEpoch,
      operation: { kind: "operator.manifest.get" },
    });
    if (receipt.status !== "completed" || receipt.result === undefined) {
      throw new Error("Studio Bridge did not complete the command manifest request");
    }
    return parseOperatorCommandManifest(receipt.result);
  }

  async readTranscript(
    input: { readonly cursor?: OpaqueCursor; readonly limit?: number } = {},
  ): Promise<ConversationTranscriptPage> {
    if (this.#state !== "ready") {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Studio Bridge is not ready for transcript read");
    }
    const runtimeEpoch = this.#runtimeEpoch;
    if (runtimeEpoch === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Studio Bridge negotiation is incomplete");
    }
    const requestId = (this.options.createRequestId ?? randomUUID)();
    const operation: SessionTranscriptRead = { kind: "session.transcript.read" };
    if (input.cursor !== undefined) operation.cursor = input.cursor;
    if (input.limit !== undefined) operation.limit = input.limit;
    const receipt = await this.invoke({
      type: "studio.request",
      requestId: requestId as RequestId,
      runtimeEpoch,
      operation,
    });
    if (receipt.status === "rejected" || receipt.status === "failed") {
      throw new StudioHostError(
        receipt.error?.code ?? "INTERNAL_ERROR",
        receipt.error?.message ?? "session.transcript.read failed",
      );
    }
    if (receipt.status !== "completed" || receipt.result === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "session.transcript.read did not complete");
    }
    try {
      return parseConversationTranscriptPage(receipt.result);
    } catch (error) {
      throw new StudioHostError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "malformed transcript page",
      );
    }
  }

  /**
   * Read one page of a per-agent transcript through the Runtime Agent Hub.
   * Query, not a ledger command; the page carries its own signed cursor.
   */
  async readAgentTranscript(input: {
    readonly agentId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): Promise<AgentTranscriptPage> {
    if (this.#state !== "ready") {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Studio Bridge is not ready for agent transcript read");
    }
    const runtimeEpoch = this.#runtimeEpoch;
    if (runtimeEpoch === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Studio Bridge negotiation is incomplete");
    }
    const requestId = (this.options.createRequestId ?? randomUUID)();
    const operation: { kind: "agent.transcript.read"; agentId: AgentId; cursor?: OpaqueCursor; limit?: number } = {
      kind: "agent.transcript.read",
      agentId: input.agentId as AgentId,
    };
    if (input.cursor !== undefined) operation.cursor = input.cursor;
    if (input.limit !== undefined) operation.limit = input.limit;
    const receipt = await this.invoke({
      type: "studio.request",
      requestId: requestId as RequestId,
      runtimeEpoch,
      operation,
    });
    if (receipt.status === "rejected" || receipt.status === "failed") {
      throw new StudioHostError(
        receipt.error?.code ?? "INTERNAL_ERROR",
        receipt.error?.message ?? "agent.transcript.read failed",
      );
    }
    if (receipt.status !== "completed" || receipt.result === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "agent.transcript.read did not complete");
    }
    const page = parseAgentTranscriptPage(receipt.result);
    return page;
  }

  /**
   * Read one ConversationItem page for a child agent. Query, not a ledger
   * command. The page uses conversation cursors, not agent.transcript offsets.
   */
  async readAgentConversation(input: {
    readonly agentId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): Promise<ConversationTranscriptPage> {
    if (this.#state !== "ready") {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Studio Bridge is not ready for agent conversation read");
    }
    const runtimeEpoch = this.#runtimeEpoch;
    if (runtimeEpoch === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Studio Bridge negotiation is incomplete");
    }
    const requestId = (this.options.createRequestId ?? randomUUID)();
    const operation: { kind: "agent.conversation.read"; agentId: AgentId; cursor?: OpaqueCursor; limit?: number } = {
      kind: "agent.conversation.read",
      agentId: input.agentId as AgentId,
    };
    if (input.cursor !== undefined) operation.cursor = input.cursor;
    if (input.limit !== undefined) operation.limit = input.limit;
    const receipt = await this.invoke({
      type: "studio.request",
      requestId: requestId as RequestId,
      runtimeEpoch,
      operation,
    });
    if (receipt.status === "rejected" || receipt.status === "failed") {
      throw new StudioHostError(
        receipt.error?.code ?? "INTERNAL_ERROR",
        receipt.error?.message ?? "agent.conversation.read failed",
      );
    }
    if (receipt.status !== "completed" || receipt.result === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "agent.conversation.read did not complete");
    }
    try {
      return parseConversationTranscriptPage(receipt.result);
    } catch (error) {
      throw new StudioHostError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "malformed agent conversation page",
      );
    }
  }

  onProjectionChanged(listener: (snapshot: StudioSnapshotResponse["snapshot"]) => void): () => void {
    this.#projectionListeners.add(listener);
    return () => this.#projectionListeners.delete(listener);
  }

  onEvent(listener: (event: StudioEventEnvelope) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onResyncRequired(listener: () => void): () => void {
    this.#resyncListeners.add(listener);
    return () => this.#resyncListeners.delete(listener);
  }

  async shutdown(): Promise<StudioReceipt> {
    const runtimeEpoch = this.#runtimeEpoch;
    if (runtimeEpoch === undefined) throw new Error("Studio Bridge negotiation is incomplete");
    const requestId = (this.options.createRequestId ?? randomUUID)();
    let unsubscribe = (): void => undefined;
    const completed = new Promise<void>((resolve) => {
      unsubscribe = this.onEvent(event => {
        if (
          event.event === null ||
          typeof event.event !== "object" ||
          !("kind" in event.event) ||
          event.event.kind !== "runtime.shutdownComplete"
        ) return;
        unsubscribe();
        resolve();
      });
    });
    try {
      const receipt = await this.invoke({
        type: "studio.request",
        requestId: requestId as RequestId,
        runtimeEpoch,
        operation: { kind: "runtime.shutdown", drain: true },
      });
      await completed;
      return receipt;
    } finally {
      unsubscribe();
    }
  }

  async #handshake(isReconnect: boolean): Promise<StudioHelloResponse> {
    this.#state = "connecting";
    const socket = (this.options.connectSocket ?? createConnection)(this.options.endpoint);
    this.#socket = socket;
    const timeoutMs = this.options.handshakeTimeoutMs ?? 10_000;
    const supportedProtocolVersions = [
      ...(this.options.supportedProtocolVersions ?? [STUDIO_PROTOCOL_VERSION]),
    ];
    const challenge = (this.options.createChallenge ?? (() => randomBytes(32).toString("base64url")))();
    const requestId = (this.options.createRequestId ?? randomUUID)();
    const decoder = new FrameDecoder();

    return new Promise<StudioHelloResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail("HANDSHAKE_TIMEOUT"), timeoutMs);

      const cleanupHandshakeListeners = (): void => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onHandshakeClose);
      };
      const fail = (code: StudioBridgeHandshakeErrorCode): void => {
        if (settled) return;
        settled = true;
        cleanupHandshakeListeners();
        socket.destroy();
        if (this.#state !== "closed") this.#state = isReconnect ? "disconnected" : "idle";
        reject(new StudioBridgeHandshakeError(code));
      };
      const onError = (): void => fail("CONNECTION_FAILED");
      const onHandshakeClose = (): void => fail("CONNECTION_FAILED");
      const onConnect = (): void => {
        this.#state = "authenticating";
        const hello: StudioHelloRequest = {
          type: "studio.hello",
          requestId: requestId as StudioHelloRequest["requestId"],
          supportedProtocolVersions,
          requiredProfile: "full-parity-v1",
          challenge,
        };
        socket.write(encodeFrame(`hello:${requestId}`, 0 as RuntimeEpoch, hello));
      };
      const onData = (chunk: Buffer): void => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          fail("MALFORMED_RESPONSE");
          return;
        }
        if (frames.length === 0) return;
        if (frames.length !== 1) {
          fail("MALFORMED_RESPONSE");
          return;
        }

        let response: StudioHelloResponse;
        try {
          response = parseStudioHelloResponse(frames[0]!.body);
        } catch {
          fail("MALFORMED_RESPONSE");
          return;
        }
        if (response.requestId !== requestId || frames[0]!.header.runtimeEpoch !== response.runtimeEpoch) {
          fail("MALFORMED_RESPONSE");
          return;
        }
        if (!supportedProtocolVersions.includes(response.selectedProtocolVersion)) {
          fail("PROTOCOL_UNSUPPORTED");
          return;
        }
        if (!verifyChallengeProof(this.#token, challenge, response.runtimeInstanceId, response.challengeProof)) {
          fail("UNAUTHENTICATED");
          return;
        }
        if (
          isReconnect &&
          (response.runtimeInstanceId !== this.#runtimeInstanceId || response.runtimeEpoch !== this.#runtimeEpoch)
        ) {
          fail("IDENTITY_CHANGED");
          return;
        }

        settled = true;
        cleanupHandshakeListeners();
        this.#runtimeInstanceId = response.runtimeInstanceId;
        this.#runtimeEpoch = response.runtimeEpoch;
        this.#hello = response;
        this.#projection.beginConnection(response);
        this.#state = "negotiated";
        socket.once("error", () => socket.destroy());
        socket.once("close", () => this.#handleSocketClosed(socket));
        resolve(response);
      };

      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onHandshakeClose);
    });
  }

  #attachReadyListener(socket: Socket, decoder = new FrameDecoder()): void {
    const listener = (chunk: Buffer): void => {
      try {
        this.#processReadyFrames(decoder.push(chunk));
      } catch {
        socket.destroy();
      }
    };
    this.#readyDataListener = listener;
    socket.on("data", listener);
  }

  #processReadyFrames(frames: readonly DecodedFrame[]): void {
    const eventFrames: DecodedFrame[] = [];
    for (const frame of frames) {
      if (!this.#tryProcessReceiptFrame(frame)) eventFrames.push(frame);
    }
    if (this.#state !== "ready") return;
    for (const frame of eventFrames) {
      if (!this.#enqueueReadyEvent(frame)) break;
    }
    this.#drainReadyEvents();
  }

  #tryProcessReceiptFrame(frame: DecodedFrame): boolean {
    if (
      frame.body !== null &&
      typeof frame.body === "object" &&
      "type" in frame.body &&
      frame.body.type === "studio.receipt"
    ) {
      const receipt = parseStudioReceipt(frame.body);
      if (frame.header.runtimeEpoch !== receipt.runtimeEpoch || receipt.runtimeEpoch !== this.#runtimeEpoch) {
        throw new Error("Receipt epoch mismatch");
      }
      const pending = this.#pendingRequests.get(receipt.requestId);
      if (pending === undefined) throw new Error("Uncorrelated Studio receipt");
      pending.onReceipt?.(receipt);
      if (TERMINAL_RECEIPT_STATUSES.has(receipt.status)) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        this.#pendingRequests.delete(receipt.requestId);
        pending.resolve(receipt);
        this.#scheduleSnapshotRecovery();
      }
      return true;
    }
    return false;
  }

  #enqueueReadyEvent(frame: DecodedFrame): boolean {
    const queuedFrames = this.#readyEventQueue.length - this.#readyEventQueueHead;
    if (
      queuedFrames >= READY_EVENT_QUEUE_MAX_FRAMES ||
      this.#readyEventQueueBytes + frame.header.bodyLength > READY_EVENT_QUEUE_MAX_BYTES
    ) {
      this.#requireSnapshot("Studio event queue exceeded the Host limit; request a fresh snapshot");
      return false;
    }
    this.#readyEventQueue.push(frame);
    this.#readyEventQueueBytes += frame.header.bodyLength;
    return true;
  }

  #scheduleReadyEventDrain(): void {
    if (
      this.#readyEventDrainScheduled ||
      this.#state !== "ready" ||
      this.#readyEventQueueHead >= this.#readyEventQueue.length
    ) {
      return;
    }
    this.#readyEventDrainScheduled = true;
    setImmediate(() => {
      this.#readyEventDrainScheduled = false;
      try {
        this.#drainReadyEvents();
      } catch {
        this.#socket?.destroy();
      }
    });
  }

  #drainReadyEvents(): void {
    const deadline = Date.now() + READY_EVENT_DRAIN_BUDGET_MS;
    let processed = 0;
    while (
      this.#state === "ready" &&
      this.#readyEventQueueHead < this.#readyEventQueue.length &&
      processed < READY_EVENT_DRAIN_MAX_FRAMES &&
      Date.now() <= deadline
    ) {
      const frame = this.#readyEventQueue[this.#readyEventQueueHead++]!;
      this.#readyEventQueueBytes -= frame.header.bodyLength;
      this.#processReadyEventFrame(frame);
      processed += 1;
    }
    if (this.#readyEventQueueHead >= this.#readyEventQueue.length) {
      this.#clearReadyEventQueue();
    } else if (this.#readyEventQueueHead >= 1_024) {
      this.#readyEventQueue = this.#readyEventQueue.slice(this.#readyEventQueueHead);
      this.#readyEventQueueHead = 0;
    }
    this.#scheduleReadyEventDrain();
  }

  #processReadyEventFrame(frame: DecodedFrame): void {
    const event = parseStudioEventEnvelope(frame.body);
    if (frame.header.runtimeEpoch !== event.runtimeEpoch) throw new Error("Event epoch mismatch");
    const result = this.#projection.applyEvent(event);
    if (result === "gap" || result === "snapshot-required") {
      this.#requireSnapshot("Studio event sequence requires a fresh snapshot");
      return;
    }
    if (result === "applied" || result === "applied-unprojected") {
      try {
        this.options.onEvent?.(event);
      } catch {
        // Isolate the constructor event hook from the socket handler.
      }
      for (const listener of [...this.#eventListeners]) {
        try {
          listener(structuredClone(event));
        } catch {
          // Isolate sibling event listeners from the socket handler.
        }
      }
      if (result === "applied") {
        const snapshot = this.#projection.snapshot();
        if (snapshot !== undefined) this.#publishProjection(snapshot);
      }
    }
  }

  #requireSnapshot(_reason: string): void {
    if (this.#state === "snapshot-required") return;
    this.#state = "snapshot-required";
    this.#clearReadyEventQueue();
    this.options.onResyncRequired?.();
    for (const listener of [...this.#resyncListeners]) {
      try {
        listener();
      } catch {
        // Isolate resync subscribers from the socket handler.
      }
    }
    this.#scheduleSnapshotRecovery();
  }

  #scheduleSnapshotRecovery(): void {
    if (
      this.#snapshotRecoveryScheduled ||
      this.#state !== "snapshot-required" ||
      this.#pendingRequests.size > 0
    ) {
      return;
    }
    this.#snapshotRecoveryScheduled = true;
    setImmediate(() => {
      this.#snapshotRecoveryScheduled = false;
      if (this.#state !== "snapshot-required" || this.#pendingRequests.size > 0) return;
      void this.requestSnapshot().catch(() => {
        this.#socket?.destroy();
      });
    });
  }

  #clearReadyEventQueue(): void {
    this.#readyEventQueue = [];
    this.#readyEventQueueHead = 0;
    this.#readyEventQueueBytes = 0;
  }

  #detachReadyListener(socket = this.#socket): void {
    if (this.#readyDataListener !== undefined) socket?.off("data", this.#readyDataListener);
    this.#readyDataListener = undefined;
    this.#clearReadyEventQueue();
  }

  #handleSocketClosed(socket: Socket): void {
    this.#detachReadyListener(socket);
    if (this.#socket === socket) this.#socket = undefined;
    if (this.#state === "closed" || this.#state === "disconnected" || this.#state === "idle") return;
    this.#state = "disconnected";
    this.#rejectPending("OUTCOME_UNKNOWN");
    this.options.onDisconnect?.();
  }

  #rejectPending(code: "CONNECTION_FAILED" | "OUTCOME_UNKNOWN"): void {
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new StudioBridgeRequestError(code));
    }
    this.#pendingRequests.clear();
  }

  #publishProjection(snapshot: StudioSnapshotResponse["snapshot"]): void {
    const cloned = structuredClone(snapshot);
    this.options.onProjectionChanged?.(cloned);
    for (const listener of this.#projectionListeners) listener(structuredClone(cloned));
  }
}
