import type {
  AgentTranscriptPage,
  CommandId,
  CommandLedgerEntry,
  ConversationOpenResult,
  ConversationTarget,
  ConversationTranscriptPage,
  OpaqueCursor,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StudioPendingInteraction,
  StudioReceipt,
  StudioRequest,
} from "@omp-studio/studio-protocol";
import { StudioBridgeClient } from "./bridge-client.js";
import { BtwEventFanout, type StudioBtwForward } from "./btw-events.js";
import { CommandLedger } from "./command-ledger.js";
import { StudioHostError } from "./command-arbiter.js";
import {
  ConversationEventFanout,
  type StudioConversationForward,
} from "./conversation-events.js";
import {
  InteractionEventFanout,
  type StudioInteractionForward,
} from "./interaction-events.js";
import { TelemetryEventFanout, type StudioTelemetryForward } from "./telemetry-events.js";
import { RuntimePublicationStore, type RuntimePublication } from "./runtime-publication.js";

const TERMINAL = new Set<CommandLedgerEntry["status"]>(["completed", "failed", "rejected", "outcome_unknown"]);

export class StudioRuntimeSessionController {
  readonly #unsubscribeProjection: () => void;
  readonly #unsubscribeEvent: () => void;
  readonly #unsubscribeResync: () => void;
  readonly #conversation = new ConversationEventFanout();
  readonly #interaction = new InteractionEventFanout();
  readonly #telemetry = new TelemetryEventFanout();
  readonly #btw = new BtwEventFanout();
  readonly #publicationListeners = new Set<(publication: RuntimePublication) => void>();

  constructor(
    private readonly bridge: StudioBridgeClient,
    private readonly ledger: CommandLedger,
    private readonly publications = new RuntimePublicationStore(),
  ) {
    this.#unsubscribeProjection = bridge.onProjectionChanged((snapshot) => {
      this.#publish(snapshot);
    });
    this.#unsubscribeEvent = bridge.onEvent((envelope) => {
      this.#conversation.forward(envelope);
      this.#telemetry.forward(envelope);
      this.#btw.forward(envelope);
      this.#interaction.forward(envelope, (commandId) => this.requestIdForCommandId(commandId));
    });
    this.#unsubscribeResync = bridge.onResyncRequired(() => {
      this.#conversation.emitResync("conversation gap; re-read open transcripts");
    });
  }

  #publish(snapshot: Parameters<RuntimePublicationStore["publish"]>[0]): RuntimePublication {
    const publication = this.publications.publish(snapshot, this.ledger.snapshot());
    for (const listener of [...this.#publicationListeners]) {
      try {
        listener(publication);
      } catch {
        // Isolate publication consumers from the Bridge/ledger path.
      }
    }
    return publication;
  }

  async refresh(): Promise<RuntimePublication> {
    const response = await this.bridge.requestSnapshot();
    for (const receipt of response.terminalReceipts) {
      if (this.ledger.getByRequestId(receipt.requestId) !== undefined) this.ledger.reconcileReceipt(receipt);
    }
    return this.#publish(response.snapshot);
  }

  async invoke(request: StudioRequest): Promise<StudioReceipt> {
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot === undefined) throw new Error("Runtime snapshot is required before command invocation");
    const provisionalCommandId = request.requestId as unknown as CommandId;
    this.ledger.request(provisionalCommandId, request, snapshot.runtimeId, snapshot.stateVersion);
    this.#publish(snapshot);
    try {
      return await this.bridge.invoke(request, (receipt) => {
        this.ledger.reconcileReceipt(receipt);
        const current = this.bridge.projectionSnapshot();
        if (current !== undefined) this.#publish(current);
      });
    } catch (error) {
      const entry = this.ledger.getByRequestId(request.requestId);
      if (entry !== undefined && !TERMINAL.has(entry.status)) {
        this.ledger.transition(entry.commandId, "outcome_unknown", { errorCode: "OUTCOME_UNKNOWN" });
        const current = this.bridge.projectionSnapshot();
        if (current !== undefined) this.#publish(current);
      }
      throw error;
    }
  }

  /**
   * Read the active-branch transcript. This is a query, not a Composer
   * command: it is not recorded on the command ledger.
   */
  async readTranscript(
    input: { readonly cursor?: OpaqueCursor; readonly limit?: number } = {},
  ): Promise<ConversationTranscriptPage> {
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot is required before transcript read");
    }
    const page = await this.bridge.readTranscript(input);
    const current = this.bridge.projectionSnapshot();
    if (current === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot disappeared during transcript read");
    }
    if (page.runtimeEpoch !== current.runtimeEpoch) {
      throw new StudioHostError(
        "RUNTIME_EPOCH_STALE",
        "Transcript page runtime epoch does not match the current session",
      );
    }
    if (page.sessionId !== current.sessionId) {
      throw new StudioHostError("CURSOR_STALE", "Transcript page session does not match the current session");
    }
    return page;
  }

  /**
   * Read one page of a per-agent transcript from the Runtime Agent Hub.
   * Query, not a Composer command: it is not recorded on the command ledger.
   * The page carries its own generation-bound signed cursor.
   */
  async readAgentTranscript(input: {
    readonly agentId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): Promise<AgentTranscriptPage> {
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot is required before agent transcript read");
    }
    const page = await this.bridge.readAgentTranscript(input);
    const current = this.bridge.projectionSnapshot();
    if (current === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot disappeared during agent transcript read");
    }
    if (page.agentId !== input.agentId) {
      throw new StudioHostError("CURSOR_STALE", "Agent transcript page does not match the requested agent");
    }
    return page;
  }

  /**
   * Read one ConversationItem page for a child agent. Query, not a Composer
   * command. The child's sessionId is expected and must not match the main
   * snapshot session.
   */
  async readAgentConversation(input: {
    readonly agentId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): Promise<ConversationTranscriptPage> {
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot is required before agent conversation read");
    }
    const page = await this.bridge.readAgentConversation(input);
    const current = this.bridge.projectionSnapshot();
    if (current === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot disappeared during agent conversation read");
    }
    if (page.runtimeEpoch !== current.runtimeEpoch) {
      throw new StudioHostError(
        "RUNTIME_EPOCH_STALE",
        "Agent conversation page runtime epoch does not match the current session",
      );
    }
    if (page.sessionId === current.sessionId) {
      throw new StudioHostError("CURSOR_STALE", "Agent conversation page belongs to the parent session");
    }
    return page;
  }

  /**
   * Read the latest page and then atomically capture the bounded live recovery
   * state. Callers subscribe before invoking this method and discard buffered
   * events through `live.watermark` to close the query/subscription race.
   */
  async openConversation(input: {
    readonly target: ConversationTarget;
    readonly limit?: number;
  }): Promise<ConversationOpenResult> {
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot === undefined) {
      throw new StudioHostError("OUTCOME_UNKNOWN", "Runtime snapshot is required before conversation open");
    }
    let page: ConversationTranscriptPage;
    let target: ConversationOpenResult["target"];
    if (input.target.kind === "session") {
      if (input.target.sessionId !== snapshot.sessionId) {
        throw new StudioHostError("CURSOR_STALE", "Conversation target is not the active Runtime session");
      }
      page = await this.readTranscript(input.limit === undefined ? {} : { limit: input.limit });
      target = {
        kind: "session",
        sessionId: input.target.sessionId,
        conversationSessionId: page.sessionId,
      };
    } else {
      if (input.target.parentSessionId !== snapshot.sessionId) {
        throw new StudioHostError("CURSOR_STALE", "Agent conversation parent is not the active Runtime session");
      }
      page = await this.readAgentConversation({
        agentId: input.target.agentId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      target = {
        kind: "agent",
        parentSessionId: input.target.parentSessionId,
        agentId: input.target.agentId,
        conversationSessionId: page.sessionId,
      };
    }
    const replay = this.#conversation.snapshot(page.sessionId);
    const live = replay.status === "resyncRequired"
      ? replay
      : {
          status: "complete" as const,
          watermark: replay.watermark,
          events: replay.events.map(({ streamSeq, envelope }) => ({
            streamSeq,
            eventSeq: Number(envelope.eventSeq),
            stateVersion: Number(envelope.stateVersion),
            occurredAt: envelope.occurredAt,
            update: envelope.event,
          })),
        };
    return { target, page, live };
  }

  onConversationEvent(listener: (event: StudioConversationForward) => void): () => void {
    return this.#conversation.onEvent(listener);
  }

  replayConversationEvents(sessionId: SessionId, listener: (event: StudioConversationForward) => void): void {
    this.#conversation.replay(sessionId, listener);
  }

  onConversationResync(listener: (reason: string) => void): () => void {
    return this.#conversation.onResync(listener);
  }

  onInteractionEvent(listener: (event: StudioInteractionForward) => void): () => void {
    return this.#interaction.onEvent(listener);
  }

  onTelemetryEvent(listener: (event: StudioTelemetryForward) => void): () => void {
    return this.#telemetry.onEvent(listener);
  }

  onBtwEvent(listener: (event: StudioBtwForward) => void): () => void {
    return this.#btw.onEvent(listener);
  }

  requestIdForCommandId(commandId: CommandId): string | undefined {
    return this.ledger.get(commandId)?.requestId ?? this.ledger.getByRequestId(String(commandId))?.requestId;
  }

  messagesCursor(): OpaqueCursor | undefined {
    return this.bridge.messagesCursor();
  }

  runtimeLost(runtimeId: RuntimeId, runtimeEpoch: RuntimeEpoch): CommandLedgerEntry[] {
    const changed = this.ledger.markRuntimeLost(runtimeId, runtimeEpoch);
    const snapshot = this.bridge.projectionSnapshot();
    if (snapshot !== undefined) this.#publish(snapshot);
    this.#conversation.emitResync("runtime lost; re-read open transcripts");
    return changed;
  }

  publication(): RuntimePublication | undefined {
    return this.publications.current();
  }

  /** Recover the Runtime-owned pending interaction when a resident session is reattached. */
  pendingInteraction(): StudioPendingInteraction | undefined {
    return this.publications.current()?.snapshot.pendingInteraction;
  }

  onPublication(listener: (publication: RuntimePublication) => void): () => void {
    this.#publicationListeners.add(listener);
    return () => {
      this.#publicationListeners.delete(listener);
    };
  }

  dispose(): void {
    this.#unsubscribeProjection();
    this.#unsubscribeEvent();
    this.#unsubscribeResync();
    this.#publicationListeners.clear();
    this.#conversation.dispose();
    this.#interaction.dispose();
    this.#telemetry.dispose();
    this.#btw.dispose();
  }
}
