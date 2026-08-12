import type {
  ClientBootstrap,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientEvent,
  ClientQueryRequest,
  ClientQueryResponse,
  ClientTransport,
  CommandName,
  QueryName,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";

import { cloneEnvelopeValue } from "./clone.js";
import { WebTransportError } from "./errors.js";

/**
 * In-process browser-port boundary implemented by the embedder (P0).
 *
 * Structurally identical to {@link ClientTransport}: every method is a typed
 * semantic operation; there is no generic request(path, payload) surface and
 * no URL/channel names. P2 replaces the object's internals with HTTP and
 * WebSocket; the adapter and the contracts it enforces do not change.
 */
export interface OmpStudioWebApi {
  bootstrap(): Promise<ClientBootstrap>;
  query<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): Promise<ClientQueryResponse<TName>>;
  command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>>;
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

type EventListener = (event: ClientEvent) => void;

/**
 * P0 semantic web transport over an {@link OmpStudioWebApi}.
 *
 * Envelopes are forwarded verbatim, with defensive cloning in both
 * directions and fail-closed response checks:
 *
 * - requests are cloned before forwarding; results and events are cloned
 *   before delivery, so neither side observes the other's mutations;
 * - a query response must be an object whose `ok` flag is a boolean, whose
 *   `queryName` matches the request, that owns `result` when ok and a
 *   well-formed `error` (object with string `code`/`message`) otherwise;
 * - a command acknowledgement must be an object whose `commandName`
 *   matches the request, whose `status` is exactly `"accepted"`, and that
 *   carries string `requestId`/`acceptedAt`;
 * - bootstrap must resolve to an object. Any violation throws
 *   {@link WebTransportError} instead of surfacing a plausible result;
 * - after `close()`: `bootstrap`/`query`/`command` reject and `subscribe`
 *   throws synchronously; active listeners are unsubscribed (api-side too)
 *   and callbacks never fire after unsubscribe or close;
 * - `close()` is idempotent and always calls `api.close()` exactly once;
 *   its rejection propagates but the transport stays closed.
 */
export class WebClientTransport implements ClientTransport {
  readonly #api: OmpStudioWebApi;
  #closed = false;
  /** Teardowns of live subscriptions; empty once closed. */
  readonly #subscriptions = new Set<Unsubscribe>();
  #apiClose: Promise<void> | null = null;

  constructor(api: OmpStudioWebApi) {
    this.#api = api;
  }

  async bootstrap(): Promise<ClientBootstrap> {
    this.#throwIfClosed();
    const bootstrap = await this.#api.bootstrap();
    this.#throwIfClosed();
    if (bootstrap === null || typeof bootstrap !== "object") {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        "bootstrap result is not an object",
      );
    }
    return cloneEnvelopeValue(bootstrap);
  }

  async query<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): Promise<ClientQueryResponse<TName>> {
    this.#throwIfClosed();
    const response = await this.#api.query(cloneEnvelopeValue(request));
    this.#throwIfClosed();
    this.#assertQueryEnvelope(request, response);
    return cloneEnvelopeValue(response);
  }

  async command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>> {
    this.#throwIfClosed();
    const accepted = await this.#api.command(cloneEnvelopeValue(request));
    this.#throwIfClosed();
    this.#assertCommandAccepted(request, accepted);
    return cloneEnvelopeValue(accepted);
  }

  subscribe(scope: SubscriptionScope, listener: EventListener): Unsubscribe {
    this.#throwIfClosed();
    let teardown: Unsubscribe = () => {};
    // Delivery is gated on live membership, so events arriving after
    // unsubscribe or close are dropped before the listener ever runs.
    const wrapped: EventListener = (event) => {
      if (this.#subscriptions.has(teardown)) {
        listener(cloneEnvelopeValue(event));
      }
    };
    const apiUnsubscribe = this.#api.subscribe(cloneEnvelopeValue(scope), wrapped);
    if (typeof apiUnsubscribe !== "function") {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        "api subscribe must return an unsubscribe function",
      );
    }
    teardown = () => {
      if (!this.#subscriptions.has(teardown)) {
        return;
      }
      this.#subscriptions.delete(teardown);
      try {
        apiUnsubscribe();
      } catch {
        // Local delivery guarantees never depend on api-side teardown.
      }
    };
    this.#subscriptions.add(teardown);
    return teardown;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      if (this.#apiClose !== null) {
        await this.#apiClose;
      }
      return;
    }
    this.#closed = true;
    for (const teardown of [...this.#subscriptions]) {
      teardown();
    }
    this.#apiClose = this.#api.close();
    await this.#apiClose;
  }

  #assertQueryEnvelope<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
    response: ClientQueryResponse<TName>,
  ): void {
    if (response === null || typeof response !== "object") {
      throw new WebTransportError("TRANSPORT_ERROR", "query response is not an object");
    }
    const envelope = response as { readonly ok?: unknown; readonly queryName?: unknown };
    if (typeof envelope.ok !== "boolean") {
      throw new WebTransportError("TRANSPORT_ERROR", "query response ok flag is not a boolean");
    }
    if (envelope.queryName !== request.queryName) {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        `query response name mismatch: expected "${String(request.queryName)}", received "${String(envelope.queryName)}"`,
      );
    }
    if (envelope.ok) {
      if (!("result" in envelope)) {
        throw new WebTransportError("TRANSPORT_ERROR", "query response is missing the result");
      }
    } else {
      const error = (response as { readonly error?: unknown }).error;
      if (error === null || typeof error !== "object") {
        throw new WebTransportError("TRANSPORT_ERROR", "query response error is not an object");
      }
      const clientError = error as { readonly code?: unknown; readonly message?: unknown };
      if (typeof clientError.code !== "string" || typeof clientError.message !== "string") {
        throw new WebTransportError(
          "TRANSPORT_ERROR",
          "query response error lacks code/message strings",
        );
      }
    }
  }

  #assertCommandAccepted<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
    accepted: ClientCommandAccepted<TName>,
  ): void {
    if (accepted === null || typeof accepted !== "object") {
      throw new WebTransportError("TRANSPORT_ERROR", "command response is not an object");
    }
    const envelope = accepted as {
      readonly commandName?: unknown;
      readonly status?: unknown;
      readonly requestId?: unknown;
      readonly acceptedAt?: unknown;
    };
    if (envelope.commandName !== request.commandName) {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        `command response name mismatch: expected "${String(request.commandName)}", received "${String(envelope.commandName)}"`,
      );
    }
    if (envelope.status !== "accepted") {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        `command acknowledgement status must be exactly "accepted", received "${String(envelope.status)}"`,
      );
    }
    if (typeof envelope.requestId !== "string" || typeof envelope.acceptedAt !== "string") {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        "command response lacks requestId/acceptedAt strings",
      );
    }
  }

  #throwIfClosed(): void {
    if (this.#closed) {
      throw new WebTransportError("UNAVAILABLE", "transport is closed");
    }
  }
}

/** Creates a {@link ClientTransport} over an in-process {@link OmpStudioWebApi}. */
export function createWebTransport(api: OmpStudioWebApi): ClientTransport {
  return new WebClientTransport(api);
}
