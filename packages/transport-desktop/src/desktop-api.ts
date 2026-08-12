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
