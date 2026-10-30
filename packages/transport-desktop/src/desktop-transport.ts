/**
 * Renderer-side Desktop transport: forwards typed envelopes between the
 * Renderer and the Desktop shell's `OmpStudioDesktopApi` 1:1. Electron IPC
 * already copies payloads, so nothing is cloned here.
 *
 * `close()` is idempotent and unsubscribes every active listener; no
 * operation is accepted afterwards.
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

class TransportClosedError extends Error {
  constructor() {
    super("desktop transport is closed");
    this.name = "TransportClosedError";
  }
}

export class DesktopClientTransport implements ClientTransport {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly subscriptions = new Set<Unsubscribe>();

  constructor(private readonly api: OmpStudioDesktopApi) {}

  async bootstrap(): Promise<ClientBootstrap> {
    this.assertOpen();
    return this.api.bootstrap();
  }

  async query<TName extends QueryName>(request: ClientQueryRequest<TName>): Promise<ClientQueryResponse<TName>> {
    this.assertOpen();
    return this.api.query(request);
  }

  async command<TName extends CommandName>(request: ClientCommandRequest<TName>): Promise<ClientCommandAccepted<TName>> {
    this.assertOpen();
    return this.api.command(request);
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    this.assertOpen();
    // `stopApi` is the api-level cancellation: it drops this listener *and*
    // releases the Main-side registration behind it (preload -> `unsubscribe`
    // channel). Without that half, stopping a listener leaked a live Host
    // subscription and kept forwarding events nobody consumed.
    let active = true;
    const stopApi = this.api.subscribe(scope, (event) => {
      if (active) listener(event);
    });
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(unsubscribe);
      stopApi();
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    const active = [...this.subscriptions];
    this.subscriptions.clear();
    for (const unsubscribe of active) unsubscribe();
    this.closePromise = Promise.resolve().then(() => this.api.close());
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new TransportClosedError();
  }
}

/** Create a renderer-side `ClientTransport` bound to a Desktop shell api. */
export function createDesktopTransport(api: OmpStudioDesktopApi): ClientTransport {
  return new DesktopClientTransport(api);
}
