/**
 * Platform-neutral StudioClient implementation over an injected
 * ClientTransport (FRONTEND_INTEGRATION.md §8).
 *
 * The client keeps its own reducer state fed by bootstrap and the event
 * stream so it can enforce §8.3 rules without asking the Renderer:
 * resync gating of sensitive mutations, terminal/no-regression bookkeeping,
 * and transport failures recorded as failed command states. Renderer
 * listeners receive only events accepted by the reducer, filtered exactly by
 * their subscription scope.
 *
 * Renderer injection is `StudioClient` only; this class adds two
 * client-side conveniences (`getState` / `onState`) that are not part of
 * the shared contract.
 */

import type {
  ClientBootstrap,
  ClientError,
  ClientEvent,
  ClientTransport,
  CommandHandle,
  CommandInput,
  CommandName,
  CommandOptions,
  ConversationTranscriptPage,
  ConversationTranscriptReadPage,
  QueryInput,
  QueryName,
  QueryResult,
  StudioClient,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";

import { createBrowserClockAndIds, type ClientClockAndIds } from "./clock.js";
import { CLIENT_CLOSED_ERROR, toClientError } from "./errors.js";
import { createInitialClientState, reduceClientState, type ClientAction, type ClientState } from "./reducer.js";
import { eventMatchesScope } from "./scope.js";

interface RendererSubscription {
  readonly scope: SubscriptionScope;
  readonly listener: (event: ClientEvent) => void;
}

/**
 * Official client-local transcript hydrate surface. These methods update
 * reducer state and are not transport envelopes — they live here rather
 * than on the shared `StudioClient` contract so Desktop/Web adapters stay
 * thin. Renderer should import this type instead of duck-typing.
 */
export interface ConversationHydrateClient {
  beginTranscriptHydrate(): number;
  hydrateTranscript(page: ConversationTranscriptPage, generation: number): void;
  prependTranscript(page: ConversationTranscriptPage, generation: number): void;
  hydrateArchiveTranscript?(page: ConversationTranscriptReadPage, generation: number): void;
  prependArchiveTranscript?(page: ConversationTranscriptReadPage, generation: number): void;
  failTranscriptHydrate(error: ClientError, generation: number): void;
}

export class StudioClientImpl implements StudioClient, ConversationHydrateClient {
  private readonly transport: ClientTransport;
  private readonly ids: ClientClockAndIds;
  private state: ClientState;
  private closed = false;
  private transportUnsubscribe: Unsubscribe | null = null;
  private bootstrapPromise: Promise<ClientBootstrap> | null = null;
  private bootstrapping = false;
  private readonly bufferedEvents: ClientEvent[] = [];
  private readonly listeners: RendererSubscription[] = [];
  private readonly stateListeners: Array<(state: ClientState) => void> = [];

  constructor(transport: ClientTransport, ids: ClientClockAndIds = createBrowserClockAndIds()) {
    this.transport = transport;
    this.ids = ids;
    this.state = createInitialClientState();
  }

  /** Current reducer state (client-side convenience; not in StudioClient). */
  getState(): ClientState {
    return this.state;
  }

  async bootstrap(): Promise<ClientBootstrap> {
    this.assertOpen();
    if (this.bootstrapPromise !== null) {
      return this.bootstrapPromise;
    }
    this.bootstrapping = true;
    this.ensureSubscribed();
    const run = (async (): Promise<ClientBootstrap> => {
      try {
        const bootstrap = await this.transport.bootstrap();
        this.applyAction({ type: "bootstrap.set", bootstrap, occurredAt: this.ids.now() });
        const pending = this.bufferedEvents.splice(0);
        for (const event of pending) {
          this.applyAction({ type: "event", event });
        }
        return bootstrap;
      } catch (error) {
        // Events buffered without a successful snapshot cannot be trusted;
        // discard them so a later retry starts from a clean baseline.
        this.bufferedEvents.length = 0;
        throw error;
      } finally {
        this.bootstrapping = false;
      }
    })();
    this.bootstrapPromise = run;
    try {
      return await run;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  /** Re-acquire a fresh snapshot and resume the event stream after a gap. */
  async resync(): Promise<ClientBootstrap> {
    return this.bootstrap();
  }

  async query<TName extends QueryName>(name: TName, input: QueryInput<TName>): Promise<QueryResult<TName>> {
    this.assertOpen();
    const response = await this.transport.query({ queryName: name, input });
    if (!response.ok) {
      throw response.error;
    }
    return response.result;
  }

  /** Start a transcript hydrate generation so a stale page cannot land after session switch. */
  beginTranscriptHydrate(): number {
    this.applyAction({ type: "conversation.beginHydrate" });
    return this.state.conversation.hydrateGeneration;
  }

  hydrateTranscript(page: ConversationTranscriptPage, generation: number): void {
    this.applyAction({ type: "conversation.hydrate", page, generation });
  }

  prependTranscript(page: ConversationTranscriptPage, generation: number): void {
    this.applyAction({ type: "conversation.prepend", page, generation });
  }

  hydrateArchiveTranscript(page: ConversationTranscriptReadPage, generation: number): void {
    this.applyAction({ type: "conversation.hydrateArchive", page, generation });
  }

  prependArchiveTranscript(page: ConversationTranscriptReadPage, generation: number): void {
    this.applyAction({ type: "conversation.prependArchive", page, generation });
  }

  failTranscriptHydrate(error: ClientError, generation: number): void {
    this.applyAction({ type: "conversation.error", error, generation });
  }

  async command<TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
    options?: CommandOptions,
  ): Promise<CommandHandle<TName>> {
    this.assertOpen();
    // The handle is created before the transport acknowledgement is awaited
    // so local_pending exists in reducer state immediately.
    const requestId = this.ids.newRequestId();
    const idempotencyKey = options?.idempotencyKey ?? this.ids.newIdempotencyKey();
    const issuedAt = this.ids.now();
    const handle: CommandHandle<TName> = {
      requestId,
      commandName: name,
      status: "local_pending",
      idempotencyKey,
      issuedAt,
    };
    // The reducer owns the issue-vs-block decision so the resync policy
    // lives in exactly one place.
    this.applyAction({ type: "command.issue", requestId, commandName: name, idempotencyKey, issuedAt });
    const entry = this.state.commands[requestId];
    if (entry !== undefined && entry.status === "failed") {
      throw entry.error;
    }
    try {
      const accepted = await this.transport.command({ commandName: name, input, idempotencyKey, requestId });
      if (accepted.requestId !== requestId) {
        // The host acknowledged a different request than the one issued:
        // the original was never accepted. Fail the original entry in
        // place — never issue a parallel command.
        throw {
          code: "TRANSPORT_ERROR",
          message: `acknowledgement requestId mismatch: expected ${requestId}, received ${accepted.requestId}`,
        };
      }
    } catch (error) {
      // The transport rejected the envelope or acknowledged a different
      // request: the command was never accepted under its own requestId.
      // Record a failed state, never accepted.
      const clientError = toClientError(error);
      this.applyAction({ type: "command.transportFailed", requestId, error: clientError, occurredAt: this.ids.now() });
      throw clientError;
    }
    return handle;
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.closed) {
      return () => {};
    }
    const subscription: RendererSubscription = { scope, listener };
    this.listeners.push(subscription);
    return () => {
      const index = this.listeners.indexOf(subscription);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to reducer state updates (client-side convenience; not in the
   * shared StudioClient contract). Lets the Renderer keep a single state
   * store that also observes transport failures and resync gating, which
   * have no host-issued event kind.
   */
  onState(listener: (state: ClientState) => void): Unsubscribe {
    this.stateListeners.push(listener);
    return () => {
      const index = this.stateListeners.indexOf(listener);
      if (index >= 0) {
        this.stateListeners.splice(index, 1);
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.applyAction({ type: "close" });
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = null;
    this.listeners.length = 0;
    this.stateListeners.length = 0;
    await this.transport.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw CLIENT_CLOSED_ERROR;
    }
  }

  private ensureSubscribed(): void {
    if (this.transportUnsubscribe === null) {
      this.transportUnsubscribe = this.transport.subscribe({ scope: "all" }, (event) => {
        if (this.bootstrapping) {
          this.bufferedEvents.push(event);
          return;
        }
        this.applyAction({ type: "event", event });
      });
    }
  }

  private applyAction(action: ClientAction): void {
    const previous = this.state;
    const next = reduceClientState(this.state, action);
    if (next !== this.state) {
      this.state = next;
      for (const listener of this.stateListeners) {
        listener(this.state);
      }
    }
    if (action.type === "event" && this.shouldDeliverEvent(previous, next, action.event)) {
      for (const { scope, listener } of this.listeners) {
        if (eventMatchesScope(action.event, scope)) {
          listener(action.event);
        }
      }
    }
    if (
      action.type === "event" &&
      !previous.connection.resyncRequired &&
      next.connection.resyncRequired &&
      !this.bootstrapping &&
      !this.closed
    ) {
      queueMicrotask(() => {
        if (!this.closed && this.state.connection.resyncRequired) {
          void this.bootstrap().catch(() => {
            // Keep the reducer in resync_required; a later manual resync can retry.
          });
        }
      });
    }
  }

  private shouldDeliverEvent(previous: ClientState, next: ClientState, event: ClientEvent): boolean {
    // A stale/duplicate event leaves state unchanged. A gap changes only the
    // resync flag while deliberately dropping the event payload.
    if (next === previous || next.connection.cursor !== event.cursor) {
      return false;
    }
    return true;
  }
}
