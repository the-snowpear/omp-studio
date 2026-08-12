/**
 * In-process semantic Desktop transport (FRONTEND_INTEGRATION.md §9, P0).
 *
 * The adapter forwards typed semantic envelopes between the Renderer and the
 * Desktop shell's `OmpStudioDesktopApi` without reinterpretation: request
 * shapes, subscription scopes, the returned unsubscribe and close all pass
 * through 1:1. It never invents channels, serializes envelopes or inspects
 * payload fields beyond the structural invariants below.
 *
 * Guarantees:
 * - Defensive deep cloning of requests, responses and events in both
 *   directions, so Renderer and shell cannot mutate shared payloads.
 * - `close()` is idempotent and unsubscribes every active listener; no
 *   operation is accepted afterwards.
 * - Unsubscribing stops event delivery immediately and is idempotent.
 * - Responses are validated against the structural P0 invariants that need
 *   no schema library: the response `queryName`/`commandName` must equal the
 *   request's, the `ok` flag must be a boolean, an ok response must carry
 *   `result`, an error response a well-formed `error`, and a command
 *   response must have `status` exactly `"accepted"`. The transport fails
 *   closed — any mismatch throws instead of surfacing malformed data.
 *
 * Browser-compatible: no Node, Electron or DOM globals; only the
 * `@omp-studio/client-contract` types are imported.
 */

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

import type { OmpStudioDesktopApi } from "./desktop-api.js";

/** Thrown when an operation is attempted on a closed transport. */
class TransportClosedError extends Error {
  constructor() {
    super("desktop transport is closed");
    this.name = "TransportClosedError";
  }
}

/** Thrown when an api response violates a structural P0 invariant. */
class TransportProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportProtocolError";
  }
}

/**
 * Deep-clone plain contract data. Contract payloads are JSON-ish values
 * (strings, numbers, booleans, arrays, plain objects, optional undefined),
 * so a recursive copy is enough; unlike a JSON round-trip it preserves
 * `undefined` values and `Date` instances.
 */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

const REQUIRED_API_METHODS: ReadonlyArray<keyof OmpStudioDesktopApi> = [
  "bootstrap",
  "query",
  "command",
  "subscribe",
  "close",
];

/**
 * Renderer-side adapter implementing `ClientTransport` over a Desktop shell
 * `OmpStudioDesktopApi`. Every call is guarded by the close state and the
 * structural response validation; payloads are cloned in both directions.
 */
export class DesktopClientTransport implements ClientTransport {
  private state: "open" | "closed" = "open";
  private closePromise: Promise<void> | null = null;
  private readonly subscriptions = new Set<Unsubscribe>();

  constructor(private readonly api: OmpStudioDesktopApi) {}

  async bootstrap(): Promise<ClientBootstrap> {
    this.assertOpen();
    const bootstrap = await this.api.bootstrap();
    if (bootstrap === null || typeof bootstrap !== "object") {
      throw new TransportProtocolError("desktop transport: bootstrap result is not an object");
    }
    return deepClone(bootstrap);
  }

  async query<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): Promise<ClientQueryResponse<TName>> {
    this.assertOpen();
    const response = await this.api.query(deepClone(request));
    this.assertQueryEnvelope(request, response);
    return deepClone(response);
  }

  async command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>> {
    this.assertOpen();
    const accepted = await this.api.command(deepClone(request));
    this.assertCommandAccepted(request, accepted);
    return deepClone(accepted);
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    this.assertOpen();
    let active = true;
    const stopApi = this.api.subscribe(deepClone(scope), (event) => {
      if (!active) {
        return;
      }
      listener(deepClone(event));
    });
    const unsubscribe = (): void => {
      if (!active) {
        return;
      }
      active = false;
      this.subscriptions.delete(unsubscribe);
      stopApi();
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.state = "closed";
    const active = [...this.subscriptions];
    this.subscriptions.clear();
    for (const unsubscribe of active) {
      unsubscribe();
    }
    this.closePromise = Promise.resolve().then(() => this.api.close());
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.state === "closed") {
      throw new TransportClosedError();
    }
  }

  private assertQueryEnvelope<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
    response: ClientQueryResponse<TName>,
  ): void {
    if (response === null || typeof response !== "object") {
      throw new TransportProtocolError("desktop transport: query response is not an object");
    }
    const envelope = response as { readonly ok?: unknown; readonly queryName?: unknown };
    if (typeof envelope.ok !== "boolean") {
      throw new TransportProtocolError("desktop transport: query response ok flag is not a boolean");
    }
    if (envelope.queryName !== request.queryName) {
      throw new TransportProtocolError(
        "desktop transport: query response queryName does not match the request",
      );
    }
    if (envelope.ok) {
      if (!("result" in envelope)) {
        throw new TransportProtocolError("desktop transport: query response is missing the result");
      }
    } else {
      const error = (response as { readonly error?: unknown }).error;
      if (error === null || typeof error !== "object") {
        throw new TransportProtocolError("desktop transport: query response error is not an object");
      }
      const clientError = error as { readonly code?: unknown; readonly message?: unknown };
      if (typeof clientError.code !== "string" || typeof clientError.message !== "string") {
        throw new TransportProtocolError(
          "desktop transport: query response error lacks code/message strings",
        );
      }
    }
  }

  private assertCommandAccepted<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
    accepted: ClientCommandAccepted<TName>,
  ): void {
    if (accepted === null || typeof accepted !== "object") {
      throw new TransportProtocolError("desktop transport: command response is not an object");
    }
    const envelope = accepted as {
      readonly commandName?: unknown;
      readonly status?: unknown;
      readonly requestId?: unknown;
      readonly acceptedAt?: unknown;
    };
    if (envelope.commandName !== request.commandName) {
      throw new TransportProtocolError(
        "desktop transport: command response commandName does not match the request",
      );
    }
    if (envelope.status !== "accepted") {
      throw new TransportProtocolError(
        'desktop transport: command response status is not exactly "accepted"',
      );
    }
    if (typeof envelope.requestId !== "string" || typeof envelope.acceptedAt !== "string") {
      throw new TransportProtocolError(
        "desktop transport: command response lacks requestId/acceptedAt strings",
      );
    }
  }
}

/**
 * Create a renderer-side `ClientTransport` bound to a Desktop shell api.
 * The api must implement every method of `OmpStudioDesktopApi`; any missing
 * method is rejected up front so a malformed shell surface fails closed at
 * construction instead of at first use.
 */
export function createDesktopTransport(api: OmpStudioDesktopApi): ClientTransport {
  if (api === null || typeof api !== "object") {
    throw new TypeError("createDesktopTransport: api must be an object");
  }
  for (const method of REQUIRED_API_METHODS) {
    if (typeof (api as unknown as Record<string, unknown>)[method] !== "function") {
      throw new TypeError(`createDesktopTransport: api.${method} must be a function`);
    }
  }
  return new DesktopClientTransport(api);
}
