/**
 * Narrow typed surface the Desktop shell exposes to the Renderer.
 *
 * P0 shape: an in-process semantic adapter that mirrors `ClientTransport`
 * method-for-method. There is deliberately no generic `invoke(channel,
 * payload)` escape hatch — every capability is a named, typed method, so the
 * Renderer can never address an arbitrary channel. The P1 Electron Main
 * implementation behind this interface must keep the same method set; IPC
 * channel names never appear in this package.
 *
 * The contract carries only public facts — opaque identities, epochs,
 * versions and pre-redacted text (FRONTEND_INTEGRATION.md §8). It never
 * contains Bridge tokens, private endpoints, PIDs, process handles or
 * session/workspace paths.
 */

import type {
  ClientBootstrap,
  ClientContextScope,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientEvent,
  ClientQueryRequest,
  ClientQueryResponse,
  CommandName,
  QueryName,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";

/** Desktop shell surface consumed by the renderer-side transport adapter. */
export interface OmpStudioDesktopApi {
  openContext?(scope: ClientContextScope): Promise<string>;
  bootstrap(contextId?: string): Promise<ClientBootstrap>;
  query<TName extends QueryName>(
    request: ClientQueryRequest<TName>, contextId?: string,
  ): Promise<ClientQueryResponse<TName>>;
  command<TName extends CommandName>(
    request: ClientCommandRequest<TName>, contextId?: string,
  ): Promise<ClientCommandAccepted<TName>>;
  /**
   * Register one subscription. The returned `Unsubscribe` must cancel exactly
   * that registration on the Main side (not "everything for this window"),
   * and must stay safe to call twice — `DesktopClientTransport` relies on it
   * to release subscriptions one at a time, and Main tears the rest down on
   * window destroy / navigation.
   */
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void, contextId?: string): Unsubscribe;
  close(contextId?: string): Promise<void>;
}
