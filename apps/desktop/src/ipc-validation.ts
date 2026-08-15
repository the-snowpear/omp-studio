/**
 * Electron-free Desktop IPC bridge helpers (FRONTEND_INTEGRATION.md §9.1).
 *
 * This module is shared by the sandboxed preload and, by convention, the
 * renderer type declarations: it imports no Electron runtime, so tests can
 * exercise the exact bridge surface headlessly with a fake sender.
 *
 * Security posture: the bridge is the ONLY renderer-visible Desktop API. It
 * exposes the fixed named method set (`bootstrap` / `query` / `command` /
 * `subscribe` / `close`) over the fixed internal channel constants from
 * `@omp-studio/transport-desktop` — never a caller-provided channel and
 * never a generic `invoke`. The underlying sender object is never exposed:
 * `ipcRenderer` stays inside the preload closure.
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
import { eventMatchesScope } from "@omp-studio/host-client-api";
import { DESKTOP_IPC_CHANNELS } from "@omp-studio/transport-desktop";
import type { OmpStudioDesktopApi } from "@omp-studio/transport-desktop";

/**
 * Fixed window global under which the preload exposes the Desktop bridge.
 * The renderer reads `window.ompStudio` (never `ipcRenderer`).
 */
export const DESKTOP_BRIDGE_GLOBAL = "ompStudio" as const;

/**
 * Minimal sender surface the bridge needs from the IPC layer. Electron's
 * `ipcRenderer` satisfies it structurally; a fake can be substituted in
 * tests. `on`/`removeListener` MUST receive the same listener reference so
 * the unsubscribe removes the exact registered listener.
 */
export interface DesktopIpcBridge {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: readonly unknown[]) => void): void;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: readonly unknown[]) => void,
  ): void;
}

/**
 * Build the renderer-facing `OmpStudioDesktopApi` over a fixed-channel IPC
 * sender. Every method maps 1:1 to a named `DESKTOP_IPC_CHANNELS` constant;
 * the returned object is frozen so the exposed surface cannot be widened at
 * runtime.
 *
 * `subscribe` returns an unsubscribe that removes the exact listener from
 * the fixed event channel (Set-style identity removal, no catch-all
 * removal). Scope filtering happens per listener with the shared
 * `eventMatchesScope` semantics, so out-of-scope events forwarded to the
 * window for a sibling subscription are never delivered to this listener.
 * The Main-side registration is fire-and-forget: the contract's unsubscribe
 * is synchronous, and Main additionally tears subscriptions down per window.
 */
export function createDesktopIpcBridge(bridge: DesktopIpcBridge): OmpStudioDesktopApi {
  const api: OmpStudioDesktopApi = {
    bootstrap(): Promise<ClientBootstrap> {
      return bridge.invoke(DESKTOP_IPC_CHANNELS.bootstrap) as Promise<ClientBootstrap>;
    },

    query<TName extends QueryName>(
      request: ClientQueryRequest<TName>,
    ): Promise<ClientQueryResponse<TName>> {
      return bridge.invoke(DESKTOP_IPC_CHANNELS.query, request) as Promise<
        ClientQueryResponse<TName>
      >;
    },

    command<TName extends CommandName>(
      request: ClientCommandRequest<TName>,
    ): Promise<ClientCommandAccepted<TName>> {
      return bridge.invoke(DESKTOP_IPC_CHANNELS.command, request) as Promise<
        ClientCommandAccepted<TName>
      >;
    },

    subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
      const onEvent = (first: unknown, ...rest: readonly unknown[]): void => {
        // Electron `ipcRenderer.on` delivers `(IpcRendererEvent, payload)`.
        // Tests and a wrapped preload may deliver the payload as the first arg.
        const payload = rest.length > 0 ? rest[0] : first;
        if (payload === null || typeof payload !== "object") {
          return;
        }
        const event = payload as ClientEvent;
        if (eventMatchesScope(event, scope)) {
          listener(event);
        }
      };
      bridge.on(DESKTOP_IPC_CHANNELS.event, onEvent);
      // Register the scope at Main. The unsubscribe contract is
      // synchronous, so the ack is not awaited; a Main-side rejection
      // (invalid scope) means no window subscription was registered.
      void bridge.invoke(DESKTOP_IPC_CHANNELS.subscribe, scope).catch(() => {
        // Swallowed: the local listener simply stays inert.
      });
      return () => {
        bridge.removeListener(DESKTOP_IPC_CHANNELS.event, onEvent);
      };
    },

    close(): Promise<void> {
      return bridge.invoke(DESKTOP_IPC_CHANNELS.close) as Promise<void>;
    },
  };

  return Object.freeze(api) as OmpStudioDesktopApi;
}
