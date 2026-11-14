import type { RuntimeViewOperation, RuntimeViewResultMap } from "@omp-studio/studio-protocol";
import type { TimeTravelCaptureRequest, TimeTravelCaptureResult } from "@omp-studio/studio-protocol";
import type { SessionOwnerState } from "@omp-studio/studio-protocol";
import type { ContextViewOperation, ContextViewResultMap, ComputerWorkspaceQuery, ComputerWorkspaceResultMap, StudioComputerQueryRequest, StudioComputerQueryResponse, StudioComputerEventEnvelope } from "@omp-studio/studio-protocol";
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
  onTimeTravelCapture?: (request: TimeTravelCaptureRequest) => Promise<void>;
  requestTimeoutMs?: number;
  /**
   * Diagnose non-fatal consumer/protocol-frame problems without tearing down
   * the Bridge. Transport-level failures still disconnect as before.
   */
  onInternalError?: (error: Error, source: "projection" | "event" | "receipt" | "frame") => void;
}

interface PendingComputerQuery {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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

export class StudioBridgeClient {
  #state: StudioBridgeClientState = "idle";
  #socket: Socket | undefined;
  #token: string;
  #runtimeInstanceId: RuntimeInstanceId | undefined;
  #runtimeEpoch: RuntimeEpoch | undefined;
  #hello: StudioHelloResponse | undefined;
  #readyDataListener: ((chunk: Buffer) => void) | undefined;
  #readyDecoder: FrameDecoder | undefined;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pendingComputerQueries = new Map<string, PendingComputerQuery>();
  readonly #computerListeners = new Set<(event: StudioComputerEventEnvelope) => void>();
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
    this.#readyDecoder = undefined;
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
    this.#readyDecoder = undefined;
    this.#rejectPending("OUTCOME_UNKNOWN");
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#token = "";
  }

  async requestSnapshot(): Promise<StudioSnapshotResponse> {
    if (this.#state !== "negotiated" && this.#state !== "snapshot-required" && this.#state !== "ready") {
      throw new Error(`Cannot request Studio Bridge snapshot from ${this.#state}`);
    }
    const socket = this.#socket;
    const hello = this.#hello;
    const runtimeEpoch = this.#runtimeEpoch;
    if (socket === undefined || hello === undefined || runtimeEpoch === undefined) {
      throw new Error("Studio Bridge negotiation is incomplete");
    }
    this.#detachReadyListener();
    this.#state = "snapshotting";
    const requestId = (this.options.createRequestId ?? randomUUID)();
    // A gap can leave the beginning of the next frame buffered. Snapshot
    // recovery changes the listener, not the authenticated byte stream.
    const decoder = this.#readyDecoder ?? new FrameDecoder();
    const request: StudioRequest = {
      type: "studio.request",
      requestId: requestId as RequestId,
      runtimeEpoch,
      operation: { kind: "runtime.snapshot", ...(this.options.onTimeTravelCapture && this.#hello?.capabilityManifest.capabilities.some(capability => capability.id === "timeTravel.capture" && capability.grade !== "unavailable") ? { timeTravelCapture: true } : {}) },
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
        this.#readyDecoder = undefined;
        this.#rejectPending("OUTCOME_UNKNOWN");
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
        let response: StudioSnapshotResponse;
        try {
          // In-flight commands and boundary requests remain live while only
          // their event projection is paused. Do not drop their control frames.
          for (const frame of frames.slice(0, snapshotIndex < 0 ? frames.length : snapshotIndex)) {
            this.#processControlFrame(frame);
          }
          if (snapshotIndex < 0) return;
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
        for (const receipt of response.terminalReceipts) {
          if (receipt.runtimeEpoch === runtimeEpoch) this.#receiveReceipt(receipt);
        }
        this.#publishProjection(response.snapshot);
        for (const frame of frames.slice(snapshotIndex + 1)) this.#processReadyFrame(frame);
        if (["ready", "snapshot-required"].includes(this.#state)) this.#attachReadyListener(socket, decoder);
        resolve(response);
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.write(encodeFrame(`snapshot:${requestId}`, runtimeEpoch, request));
    });
  }

  async invoke(request: StudioRequest, onReceipt?: (receipt: StudioReceipt) => void, timeoutMs: number | null | undefined = this.options.requestTimeoutMs): Promise<StudioReceipt> {
    if (this.#state !== "ready") throw new Error(`Cannot invoke Studio Bridge command from ${this.#state}`);
    if (request.runtimeEpoch !== this.#runtimeEpoch) throw new Error("Studio Bridge request Runtime epoch is stale");
    if (this.#pendingRequests.has(request.requestId)) throw new Error(`Duplicate request id ${request.requestId}`);
    const socket = this.#socket;
    if (socket === undefined) throw new Error("Studio Bridge connection is unavailable");

    return new Promise<StudioReceipt>((resolve, reject) => {
      const timer =
        timeoutMs == null
          ? undefined
          : setTimeout(() => {
              this.#pendingRequests.delete(request.requestId);
              reject(new StudioBridgeRequestError("OUTCOME_UNKNOWN"));
            }, timeoutMs);
      this.#pendingRequests.set(request.requestId, {
        resolve,
        reject,
        ...(onReceipt === undefined ? {} : { onReceipt }),
        ...(timer === undefined ? {} : { timer }),
      });
      try {
        let wireRequest = request;
        if (request.operation.kind === "interaction.respond" && request.operation.leaseGeneration !== undefined &&
          !this.#hello?.capabilityManifest.capabilities.some(capability => capability.id === "remoteUi.leaseGeneration" && capability.grade !== "unavailable")) {
          const { leaseGeneration: _leaseGeneration, ...operation } = request.operation;
          wireRequest = { ...request, operation };
        }
        socket.write(encodeFrame(`request:${request.requestId}`, request.runtimeEpoch, wireRequest));
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

  async updateOwner(state: SessionOwnerState): Promise<void> {
    // Older Runtimes close the pipe on unknown operations. Owner notifications
    // are optional and must be negotiated before the first snapshot publishes.
    if (!this.#hello?.capabilityManifest.capabilities.some(
      capability => capability.id === "session.owner.update" && capability.grade !== "unavailable",
    )) return;
    const snapshot = this.#projection.snapshot();
    if (this.#state !== "ready" || !snapshot || this.#runtimeEpoch === undefined) return;
    await this.invoke({ type: "studio.request", requestId: (this.options.createRequestId ?? randomUUID)() as RequestId, runtimeEpoch: this.#runtimeEpoch, operation: { kind: "session.owner.update", sessionId: snapshot.sessionId, state } });
  }

  async readRuntimeView<K extends RuntimeViewOperation["kind"]>(operation: Extract<RuntimeViewOperation, { kind: K }>): Promise<RuntimeViewResultMap[K]> {
    if (this.#state !== "ready" || this.#runtimeEpoch === undefined) throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime view unavailable");
    const receipt = await this.invoke({ type: "studio.request", requestId: (this.options.createRequestId ?? randomUUID)() as RequestId, runtimeEpoch: this.#runtimeEpoch, operation });
    if (receipt.status !== "completed") throw new StudioHostError(receipt.error?.code ?? "OUTCOME_UNKNOWN", receipt.error?.message ?? "Runtime view failed");
    return receipt.result as RuntimeViewResultMap[K];
  }

  async readContext<K extends ContextViewOperation["kind"]>(operation: Extract<ContextViewOperation, { kind: K }>): Promise<ContextViewResultMap[K]> {
    if (this.#state !== "ready" || this.#runtimeEpoch === undefined) throw new StudioHostError("OUTCOME_UNKNOWN", "Context unavailable");
    const receipt = await this.invoke({ type: "studio.request", requestId: (this.options.createRequestId ?? randomUUID)() as RequestId, runtimeEpoch: this.#runtimeEpoch, operation });
    if (receipt.status !== "completed") throw new StudioHostError(receipt.error?.code ?? "OUTCOME_UNKNOWN", receipt.error?.message ?? "Context read failed");
    return receipt.result as ContextViewResultMap[K];
  }

  /** Independent query channel: no StudioReceipt, arbiter command, or ledger entry. */
  async readComputer<K extends ComputerWorkspaceQuery["kind"]>(operation: Extract<ComputerWorkspaceQuery, { kind: K }>): Promise<ComputerWorkspaceResultMap[K]> {
    if (!this.#hello?.capabilityManifest.capabilities.some(capability => capability.id === operation.kind && capability.grade !== "unavailable")) {
      throw new StudioHostError("CAPABILITY_UNAVAILABLE", operation.kind + " is not supported by this Runtime");
    }
    const runtimeEpoch = this.#runtimeEpoch;
    const socket = this.#socket;
    if (this.#state !== "ready" || runtimeEpoch === undefined || socket === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Computer workspace requires a connected Runtime");
    }
    const requestId = (this.options.createRequestId ?? randomUUID)() as RequestId;
    if (this.#pendingComputerQueries.has(requestId)) throw new Error("Duplicate Computer query request id");
    const request: StudioComputerQueryRequest<K> = { type: "computer.query", requestId, runtimeEpoch, operation };
    return new Promise<ComputerWorkspaceResultMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingComputerQueries.delete(requestId);
        reject(new StudioHostError("OUTCOME_UNKNOWN", "Computer workspace query timed out"));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.#pendingComputerQueries.set(requestId, { timer, reject, resolve: result => resolve(result as ComputerWorkspaceResultMap[K]) });
      try {
        socket.write(encodeFrame("computer-query:" + requestId, runtimeEpoch, request));
      } catch {
        clearTimeout(timer);
        this.#pendingComputerQueries.delete(requestId);
        reject(new StudioBridgeRequestError("CONNECTION_FAILED"));
      }
    });
  }

  onComputerEvent(listener: (event: StudioComputerEventEnvelope) => void): () => void {
    this.#computerListeners.add(listener);
    return () => this.#computerListeners.delete(listener);
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

  async predict(input: PredictionQuery): Promise<PredictionResult> {
    if(this.#state !== "ready" || this.#runtimeEpoch === undefined) throw new StudioHostError("OUTCOME_UNKNOWN", "Prediction unavailable");
    const receipt = await this.invoke({type:"studio.request",requestId:(this.options.createRequestId ?? randomUUID)() as RequestId,runtimeEpoch:this.#runtimeEpoch,operation:{kind:"prediction.query",...input}});
    if(receipt.status !== "completed") throw new StudioHostError("OUTCOME_UNKNOWN", "Prediction unavailable"); return receipt.result as PredictionResult;
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

  /** Reversible operator-close gate. Older Runtimes must never receive an unknown operation. */
  async confirmClose(): Promise<boolean> {
    if (!this.#hello?.capabilityManifest.capabilities.some(capability => capability.id === "runtime.close.confirm" && capability.grade !== "unavailable")) return true;
    const snapshot = this.#projection.snapshot();
    const runtimeEpoch = this.#runtimeEpoch;
    if (this.#state !== "ready" || !snapshot || runtimeEpoch === undefined) return true;
    const receipt = await this.invoke({
      type: "studio.request",
      requestId: (this.options.createRequestId ?? randomUUID)() as RequestId,
      runtimeEpoch,
      operation: { kind: "runtime.close.confirm", sessionId: snapshot.sessionId },
    }, undefined, null);
    if (this.#runtimeEpoch !== runtimeEpoch || this.#projection.snapshot()?.sessionId !== snapshot.sessionId) return true;
    if (receipt.status !== "completed") throw new StudioBridgeRequestError("OUTCOME_UNKNOWN");
    return (receipt.result as RuntimeViewResultMap["runtime.close.confirm"] | undefined)?.allowed !== false;
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
    this.#readyDecoder = undefined;
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
        this.#readyDecoder = decoder;
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
    this.#readyDecoder = decoder;
    const listener = (chunk: Buffer): void => {
      try {
        for (const frame of decoder.push(chunk)) this.#processReadyFrame(frame);
      } catch (error) {
        this.#report(error, "frame");
        socket.destroy();
      }
    };
    this.#readyDataListener = listener;
    socket.on("data", listener);
  }

  #report(error: unknown, source: "projection" | "event" | "receipt" | "frame"): void {
    try {
      this.options.onInternalError?.(error instanceof Error ? error : new Error(String(error)), source);
    } catch {
      // Diagnostics must never influence the transport.
    }
  }

  // Private channel validation stops at the envelope; service-owned metadata is
  // not reparsed or copied into the global Studio projection.
  #processComputerFrame(frame: DecodedFrame): boolean {
    if (!frame.body || typeof frame.body !== "object") return false;
    const body = frame.body as Record<string, unknown>;
    if (body.type !== "computer.result" && body.type !== "computer.event") return false;
    if (body.runtimeEpoch !== frame.header.runtimeEpoch) throw new Error("Computer frame epoch mismatch");
    if (body.runtimeEpoch !== this.#runtimeEpoch) return true;
    if (body.type === "computer.result") {
      if (typeof body.requestId !== "string" || typeof body.ok !== "boolean") throw new Error("Invalid Computer result envelope");
      const response = body as unknown as StudioComputerQueryResponse;
      if (!response.ok && (!response.error || typeof response.error.code !== "string" || typeof response.error.message !== "string")) {
        throw new Error("Invalid Computer error envelope");
      }
      const pending = this.#pendingComputerQueries.get(response.requestId);
      if (!pending) return true;
      clearTimeout(pending.timer);
      this.#pendingComputerQueries.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new StudioHostError(response.error.code, response.error.message));
    } else {
      if (!Number.isSafeInteger(body.stateVersion) || typeof body.occurredAt !== "string" || !body.event || typeof body.event !== "object") {
        throw new Error("Invalid Computer event envelope");
      }
      for (const listener of [...this.#computerListeners]) {
        try { listener(body as unknown as StudioComputerEventEnvelope); }
        catch (error) { this.#report(error, "event"); }
      }
    }
    return true;
  }

  #processTimeTravelFrame(frame: DecodedFrame): boolean {
    if (frame.body && typeof frame.body === "object" && "type" in frame.body && frame.body.type === "timeTravel.capture.request") {
      const request = frame.body as TimeTravelCaptureRequest;
      if (request.runtimeEpoch !== this.#runtimeEpoch || frame.header.runtimeEpoch !== this.#runtimeEpoch) return true;
      const socket = this.#socket;
      const send = (error?: string) => {
        if (!socket || socket.destroyed || socket !== this.#socket) return;
        const result: TimeTravelCaptureResult = { type: "timeTravel.capture.result", requestId: request.requestId, runtimeEpoch: request.runtimeEpoch, ...(error === undefined ? {} : { error }) };
        socket.write(encodeFrame(`time-travel:${request.requestId}`, request.runtimeEpoch as RuntimeEpoch, result));
      };
      void Promise.resolve().then(() => this.options.onTimeTravelCapture?.(request)).then(() => send(), error => send(error instanceof Error ? error.message : String(error)));
      return true;
    }
    return false;
  }

  #receiveReceipt(receipt: StudioReceipt): boolean {
    const pending = this.#pendingRequests.get(receipt.requestId);
    if (pending === undefined) return false;
    try {
      pending.onReceipt?.(receipt);
    } catch (error) {
      this.#report(error, "receipt");
    }
    if (TERMINAL_RECEIPT_STATUSES.has(receipt.status)) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.#pendingRequests.delete(receipt.requestId);
      pending.resolve(receipt);
    }
    return true;
  }

  #processControlFrame(frame: DecodedFrame): boolean {
    if (this.#processComputerFrame(frame) || this.#processTimeTravelFrame(frame)) return true;
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
      // A receipt for a request this connection never sent (for example a late
      // reply from the Runtime's previous epoch) carries no state. Ignoring it
      // is safe; throwing here used to destroy the whole Bridge.
      if (!this.#receiveReceipt(receipt)) {
        this.#report(new Error("Uncorrelated Studio receipt"), "receipt");
      }
      return true;
    }
    return false;
  }

  #processReadyFrame(frame: DecodedFrame): void {
    if (this.#processControlFrame(frame)) return;
    const event = parseStudioEventEnvelope(frame.body);
    if (frame.header.runtimeEpoch !== event.runtimeEpoch) throw new Error("Event epoch mismatch");
    if (this.#state !== "ready") return;
    const revisionBefore = this.#projection.snapshotRevision();
    const result = this.#projection.applyEvent(event);
    if (result === "gap") {
      this.#rejectComputerQueries();
      this.#state = "snapshot-required";
      this.options.onResyncRequired?.();
      for (const listener of [...this.#resyncListeners]) {
        try {
          listener();
        } catch {
          // Isolate resync subscribers from the socket handler.
        }
      }
      return;
    }
    if (result === "applied") {
      try {
        this.options.onEvent?.(event);
      } catch (error) {
        this.#report(error, "event");
      }
      // One clone per dispatch, not one per listener: the envelope is read-only
      // downstream (each fanout re-parses it into fresh objects), and a
      // `conversation.tool.updated` carries up to 256 KiB of accumulated output.
      // The listener set is still copied so a listener that unsubscribes mid
      // dispatch cannot skip its siblings.
      const listeners = [...this.#eventListeners];
      if (listeners.length > 0) {
        const delivered = structuredClone(event);
        for (const listener of listeners) {
          try {
            listener(delivered);
          } catch (error) {
            this.#report(error, "event");
          }
        }
      }
      // A pure `conversation.message.delta` advances `eventSeq` without touching
      // the operator snapshot, so republishing here would deep-clone an unchanged
      // read model — and the whole command ledger with it — once per streamed
      // token. Every real state change still arrives as its own `state.changed` /
      // `session.telemetry.changed` envelope and publishes exactly once.
      if (this.#projection.snapshotRevision() !== revisionBefore) {
        const snapshot = this.#projection.snapshot();
        if (snapshot !== undefined) this.#publishProjection(snapshot);
      }
    }
  }

  #detachReadyListener(socket = this.#socket): void {
    if (this.#readyDataListener !== undefined) socket?.off("data", this.#readyDataListener);
    this.#readyDataListener = undefined;
  }

  #handleSocketClosed(socket: Socket): void {
    this.#detachReadyListener(socket);
    if (this.#socket === socket) {
      this.#socket = undefined;
      this.#readyDecoder = undefined;
    }
    if (this.#state === "closed" || this.#state === "disconnected" || this.#state === "idle") return;
    this.#state = "disconnected";
    this.#rejectPending("OUTCOME_UNKNOWN");
    this.options.onDisconnect?.();
  }

  #rejectComputerQueries(): void {
    for (const pending of this.#pendingComputerQueries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new StudioHostError("OUTCOME_UNKNOWN", "Computer workspace connection changed"));
    }
    this.#pendingComputerQueries.clear();
  }

  #rejectPending(code: "CONNECTION_FAILED" | "OUTCOME_UNKNOWN"): void {
    this.#rejectComputerQueries();
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new StudioBridgeRequestError(code));
    }
    this.#pendingRequests.clear();
  }

  /**
   * One copy, shared by every subscriber. The copy stays because
   * `requestSnapshot` publishes the parsed response's snapshot, which the caller
   * also receives — the published object must not alias anything a caller holds.
   * Cloning again *per listener* was pure waste: the projection read model is
   * read-only and, in production, `onProjectionChanged` is unset and
   * `#projectionListeners` has exactly one member.
   */
  #publishProjection(snapshot: StudioSnapshotResponse["snapshot"]): void {
    let published: StudioSnapshotResponse["snapshot"];
    try {
      published = structuredClone(snapshot);
    } catch (error) {
      this.#report(error, "projection");
      return;
    }
    try {
      this.options.onProjectionChanged?.(published);
    } catch (error) {
      this.#report(error, "projection");
    }
    for (const listener of [...this.#projectionListeners]) {
      try {
        listener(published);
      } catch (error) {
        this.#report(error, "projection");
      }
    }
  }
}
import { type PredictionQuery, type PredictionResult } from "@omp-studio/studio-protocol";
