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
 *
 * Subscription lifecycle (P1-1):
 * - Every `subscribe` call owns exactly one `subscriptionId`, chosen here in
 *   the preload before the IPC call is made. Main echoes it back and keeps
 *   the Host subscription behind it keyed by that id.
 * - The returned `unsubscribe` removes the local event listener (identity
 *   removal, idempotent) and then cancels exactly that id at Main. Because
 *   the id is known synchronously, calling it before the registration
 *   `invoke` resolves cannot leave an orphan: the two IPC calls are queued in
 *   order, and Main treats a cancellation for an unknown id as final (see
 *   `apps/desktop/src/ipc.ts`, which also refuses to register ids that were
 *   already cancelled).
 * - Events travel as `{ subscriptionIds, event }`, so a window with several
 *   subscriptions over the same scope receives one copy per event and each
 *   listener only reacts to the ids it owns — no duplicate delivery.
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
// Keep the sandboxed preload on the Node-free client dependency graph.
import { eventMatchesScope } from "@omp-studio/client";
import {
  DESKTOP_IPC_CHANNELS,
  isPlainObject,
  parseSubscriptionScope,
  ValidationError,
} from "@omp-studio/transport-desktop";
import type { OmpStudioDesktopApi } from "@omp-studio/transport-desktop";

/**
 * Fixed window global under which the preload exposes the Desktop bridge.
 * The renderer reads `window.ompStudio` (never `ipcRenderer`).
 */
export const DESKTOP_BRIDGE_GLOBAL = "ompStudio" as const;

/**
 * Opaque per-subscription id. Chosen by the preload, bounded in length and
 * charset so Main can reject junk without inspecting scope semantics.
 */
export const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

const MAX_EVENT_IDS = 32;

let subscriptionSequence = 0;

/** Monotonic, collision-resistant enough: one process owns one window. */
export function nextSubscriptionId(): string {
  subscriptionSequence = (subscriptionSequence + 1) % 0xffff;
  return `s${subscriptionSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseSubscriptionId(value: unknown, what: string): string {
  if (typeof value !== "string" || !SUBSCRIPTION_ID_PATTERN.test(value)) {
    throw new ValidationError(`${what}: expected a subscription id`);
  }
  return value;
}

/**
 * `subscribe` payload: `{ scope, subscriptionId }`. Extra fields are rejected
 * so a payload cannot smuggle a window id, authority epoch or client
 * identity through this channel.
 */
export function parseSubscriptionRegistration(value: unknown): {
  readonly subscriptionId: string;
  readonly scope: SubscriptionScope;
} {
  if (!isPlainObject(value)) {
    throw new ValidationError("subscription: expected a plain object");
  }
  if (Object.keys(value).some((key) => key !== "scope" && key !== "subscriptionId")) {
    throw new ValidationError("subscription: unexpected field");
  }
  return {
    subscriptionId: parseSubscriptionId(value.subscriptionId, "subscription"),
    scope: parseSubscriptionScope(value.scope),
  };
}

/** `unsubscribe` payload: `{ subscriptionId }` and nothing else. */
export function parseSubscriptionCancellation(value: unknown): { readonly subscriptionId: string } {
  if (!isPlainObject(value)) {
    throw new ValidationError("subscription cancellation: expected a plain object");
  }
  if (Object.keys(value).some((key) => key !== "subscriptionId")) {
    throw new ValidationError("subscription cancellation: unexpected field");
  }
  return { subscriptionId: parseSubscriptionId(value.subscriptionId, "subscription cancellation") };
}

/**
 * Outbound event envelope. `subscriptionIds` names the renderer subscriptions
 * that this single Host event satisfies, so one IPC message covers every
 * listener on that scope and a listener never sees its own event twice.
 */
export interface SubscriptionEventEnvelope {
  readonly subscriptionIds: readonly string[];
  readonly event: ClientEvent;
}

export function isSubscriptionEventEnvelope(value: unknown): value is SubscriptionEventEnvelope {
  if (!isPlainObject(value)) return false;
  const ids = value.subscriptionIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_EVENT_IDS) return false;
  if (ids.some((id) => typeof id !== "string")) return false;
  const event = value.event;
  return event !== null && typeof event === "object" && !Array.isArray(event);
}

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
 * `subscribe` returns an unsubscribe that removes the exact listener from the
 * fixed event channel (Set-style identity removal, no catch-all removal) and
 * cancels that one subscription at Main. Scope filtering happens twice: Main
 * only forwards scopes that were registered, and the listener re-checks
 * `eventMatchesScope` so a poisoned payload cannot cross scopes. The Main-side
 * registration is fire-and-forget because the contract's unsubscribe is
 * synchronous; a registration Main rejected (invalid scope, window already
 * gone) simply never delivers, and the matching cancellation resolves as an
 * idempotent no-op.
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
      // The id is chosen here, before any IPC: a cancellation can therefore
      // name the registration even if it happens synchronously after this
      // call and before the registration round-trip completes.
      const subscriptionId = nextSubscriptionId();
      const onEvent = (first: unknown, ...rest: readonly unknown[]): void => {
        // Electron `ipcRenderer.on` delivers `(IpcRendererEvent, payload)`.
        // Tests and a wrapped preload may deliver the payload as the first arg.
        const payload = rest.length > 0 ? rest[0] : first;
        if (!isSubscriptionEventEnvelope(payload)) {
          return;
        }
        // One event may be addressed to several subscriptions sharing a scope;
        // only the owner of this id delivers it.
        if (!payload.subscriptionIds.includes(subscriptionId)) {
          return;
        }
        if (eventMatchesScope(payload.event, scope)) {
          listener(payload.event);
        }
      };
      bridge.on(DESKTOP_IPC_CHANNELS.event, onEvent);
      // Fire-and-forget: the unsubscribe contract is synchronous. A rejected
      // registration (invalid scope) means Main never forwards, so the local
      // listener stays inert; the paired cancellation below is idempotent.
      void bridge
        .invoke(DESKTOP_IPC_CHANNELS.subscribe, { scope, subscriptionId })
        .catch(() => undefined);
      let cancelled = false;
      return () => {
        // Local removal first: no further delivery even if the Host races us.
        // `removeListener` is identity-based and idempotent, so a repeated
        // call is safe (Electron cannot leak a listener that is not there).
        bridge.removeListener(DESKTOP_IPC_CHANNELS.event, onEvent);
        if (cancelled) return;
        cancelled = true;
        // Cancel exactly this id. Ordering is guaranteed per channel, and Main
        // records cancellations it saw before the registration, so an early
        // cancellation cannot leave an orphan Host subscription behind.
        void bridge
          .invoke(DESKTOP_IPC_CHANNELS.unsubscribe, { subscriptionId })
          .catch(() => undefined);
      };
    },

    close(): Promise<void> {
      return bridge.invoke(DESKTOP_IPC_CHANNELS.close) as Promise<void>;
    },
  };

  return Object.freeze(api) as OmpStudioDesktopApi;
}
