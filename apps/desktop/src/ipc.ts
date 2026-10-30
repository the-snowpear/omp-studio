/**
 * Main-process Desktop IPC bridge (FRONTEND_INTEGRATION.md §9).
 *
 * Registers handlers for exactly the fixed `DESKTOP_IPC_CHANNELS` set —
 * bootstrap / query / command / subscribe / unsubscribe / close — with no
 * generic `ipcMain.handle(channel, payload)` surface. Inbound envelopes are
 * parsed down to their known fields; input checks belong to the facade.
 *
 * Security posture:
 * - Client identity is bound from `IpcMainInvokeEvent.sender` only; the
 *   renderer never supplies identity, window ids or authority fields.
 * - Calls from destroyed or untrusted WebContents are rejected up front.
 * - A null facade (composition failed to build) fails every channel closed:
 *   bootstrap/query/command/subscribe reject, close resolves as a no-op —
 *   the window stays open in read-only state.
 * - Subscriptions are window-bound and individually cancellable, and torn
 *   down on window destroy, main-frame navigation (reload), a crashed
 *   renderer process and the close request, so a reloaded page can never
 *   observe stale events. Renderer `close` never shuts down the Host facade —
 *   only app quit does.
 * - The facade (`ClientTransport`) is the only host-facing seam; no Bridge
 *   token, endpoint, process handle or path ever appears in this module's
 *   payloads.
 *
 * Subscription lifecycle (P1-1 — the leak this module used to have):
 * - The renderer picks a `subscriptionId` per `subscribe` call (see
 *   `./ipc-validation.ts`), so cancellation names exactly one subscription
 *   instead of a whole window.
 * - Subscriptions with the same scope share ONE Host subscription; each event
 *   is forwarded once per (window, scope) as `{ subscriptionIds, event }`
 *   instead of once per subscription. That is what removes the duplicate
 *   delivery a window with N listeners over `{ scope: "all" }` used to get,
 *   and it bounds the Host subscription count by the number of distinct
 *   scopes rather than by renderer call sites.
 * - `unsubscribe` is idempotent: an unknown id resolves as "already
 *   cancelled". A cancellation that arrives before its registration is
 *   remembered (bounded FIFO) and the late registration cancels itself, so a
 *   registration/cancellation race cannot leave an orphan.
 * - Every teardown path marks the window closed before touching Host state,
 *   and forwarding re-checks both that flag and `sender.isDestroyed()`, so
 *   nothing is ever sent to a destroyed WebContents.
 */

import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from "electron";

import type { ClientEvent, ClientTransport, SubscriptionScope, Unsubscribe } from "@omp-studio/client-contract";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_LIMITS,
  isPlainObject,
  parseClientCommandRequest,
  parseClientQueryRequest,
} from "@omp-studio/transport-desktop";

import {
  parseSubscriptionCancellation,
  parseSubscriptionRegistration,
} from "./ipc-validation.js";

/**
 * Electron-neutral view of the IPC event sender. WebContents satisfies it
 * structurally, and tests can pass a minimal fake without pulling in the
 * full Electron `WebContents` surface. Lifecycle hooks are optional so a
 * fake only has to implement what the test exercises.
 */
export interface DesktopSender {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  send?(channel: string, payload: unknown): void;
  on?(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  once?(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): unknown;
}

/**
 * WebContents events that end a renderer document's subscription lifetime.
 * `destroyed` is Electron's web-contents-destroyed notification.
 */
const WINDOW_TEARDOWN_EVENTS = ["destroyed", "did-navigate", "render-process-gone"] as const;

/** Registration inputs. `ipcMain` is injectable for tests and defaults to Electron's. */
export interface DesktopIpcOptions {
  /**
   * Facade serving every renderer request; one instance per composition.
   * Null when the Host composition failed to build: the window still opens
   * in read-only state and every channel fails closed (all calls reject,
   * `close` resolves as a no-op). Contract-shaped "unavailable" responses
   * are the facade's job when it exists; a null facade has no authority,
   * surface or manifest to report, so honest rejection beats fabrication.
   */
  readonly facade: ClientTransport | null;
  /** Window allow-list: true only for the app's own Studio WebContents. */
  readonly isTrustedSender: (sender: DesktopSender) => boolean;
  readonly ipcMain?: IpcMain | undefined;
}

/** Live handle returned by {@link registerDesktopIpc}. */
export interface DesktopIpcHandle {
  /**
   * Remove every handler and tear down every window subscription. Does not
   * close the facade and does not shut down the Host — Main does that on
   * app quit.
   */
  dispose(): void;
}

/** One Host subscription shared by every renderer id that registered its scope. */
interface ScopeSubscription {
  readonly ids: Set<string>;
  hostUnsubscribe: Unsubscribe | undefined;
  disposed: boolean;
}

interface WindowSubscriptions {
  readonly sender: DesktopSender;
  /** subscriptionId -> canonical scope key */
  readonly byId: Map<string, string>;
  /** canonical scope key -> shared Host subscription */
  readonly byScope: Map<string, ScopeSubscription>;
  detach(): void;
  readonly detachListeners: Array<() => void>;
  closed: boolean;
}

/**
 * Cancellations remembered without a live registration. Bounded: an
 * identifier is 1–64 characters, and only the torn-down-window / early-cancel
 * paths add entries, so the set cannot grow with normal subscribe/unsubscribe
 * traffic.
 */
const MAX_REMEMBERED_CANCELLATIONS = 1_024;

/**
 * Ids per outbound envelope, shared with the preload's envelope guard
 * (`DESKTOP_IPC_LIMITS`, `@omp-studio/transport-desktop`). A bigger scope
 * fan-out is split across several envelopes, never dropped — and the preload
 * accepts exactly the envelopes this size allows.
 */
const MAX_IDS_PER_EVENT = DESKTOP_IPC_LIMITS.maxSubscriptionIdsPerEvent;

/**
 * Electron `ipcMain.handle` stringifies a thrown plain object as
 * `[object Object]`. ClientError is `{ code, message }` — wrap it in Error
 * so the renderer sees the actual Host message.
 */
function throwIpcError(error: unknown): never {
  if (error instanceof Error) {
    throw error;
  }
  if (isPlainObject(error) && typeof error.code === "string" && typeof error.message === "string") {
    const wrapped = new Error(error.message);
    wrapped.name = error.code;
    throw wrapped;
  }
  throw new Error("desktop ipc: host rejected the request");
}

/**
 * Stable per-scope key. Scopes are flat records of primitives; sorting the
 * keys keeps `{ scope: "command", requestId }` from registering twice.
 */
function canonicalScopeKey(scope: SubscriptionScope): string {
  const record = scope as unknown as Record<string, unknown>;
  return JSON.stringify(record, Object.keys(record).sort());
}

/**
 * Register the fixed Desktop IPC surface for one facade. Calling twice with
 * the same `ipcMain` throws (Electron rejects duplicate handlers); dispose
 * first when swapping facades (e.g. after a composition reload).
 */
export function registerDesktopIpc(options: DesktopIpcOptions): DesktopIpcHandle {
  const ipc = options.ipcMain ?? ipcMain;
  const facade = options.facade;
  const windows = new Map<number, WindowSubscriptions>();
  const cancelled = new Set<string>();

  function assertTrustedSender(sender: DesktopSender): void {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) {
      throw new Error("desktop ipc: untrusted sender");
    }
  }

  /** Fail closed when the Host composition never built. */
  function requireFacade(): ClientTransport {
    if (facade === null) {
      throw new Error("desktop ipc: host unavailable");
    }
    return facade;
  }

  function rememberCancellation(subscriptionId: string): void {
    cancelled.delete(subscriptionId);
    cancelled.add(subscriptionId);
    if (cancelled.size > MAX_REMEMBERED_CANCELLATIONS) {
      const oldest = cancelled.values().next();
      if (!oldest.done) cancelled.delete(oldest.value);
    }
  }

  function trackWindow(sender: DesktopSender): WindowSubscriptions {
    const existing = windows.get(sender.id);
    if (existing !== undefined) return existing;
    const window: WindowSubscriptions = {
      sender,
      byId: new Map(),
      byScope: new Map(),
      detachListeners: [],
      detach() {},
      closed: false,
    };
    const teardown = (): void => disposeWindow(window);
    for (const event of WINDOW_TEARDOWN_EVENTS) {
      // Prefer `on` + explicit `removeListener`: `once` leaves a listener per
      // navigation cycle behind, and a window can navigate many times.
      if (typeof sender.on === "function") {
        sender.on(event, teardown);
        window.detachListeners.push(() => sender.removeListener?.(event, teardown));
      } else if (typeof sender.once === "function") {
        sender.once(event, teardown);
      }
    }
    windows.set(sender.id, window);
    return window;
  }

  function disposeScope(scope: ScopeSubscription): void {
    if (scope.disposed) return;
    scope.disposed = true;
    const stop = scope.hostUnsubscribe;
    scope.hostUnsubscribe = undefined;
    scope.ids.clear();
    stop?.();
  }

  function disposeWindow(window: WindowSubscriptions): void {
    if (window.closed) return;
    // Closed is set first: a Host event that arrives during teardown must not
    // reach a window whose renderer is already gone.
    window.closed = true;
    for (const scope of [...window.byScope.values()]) disposeScope(scope);
    window.byScope.clear();
    window.byId.clear();
    for (const detach of window.detachListeners.splice(0)) detach();
    if (windows.get(window.sender.id) === window) windows.delete(window.sender.id);
  }

  function forward(window: WindowSubscriptions, scope: ScopeSubscription, event: ClientEvent): void {
    if (window.closed || scope.disposed || scope.ids.size === 0) return;
    const sender = window.sender;
    if (sender.isDestroyed()) {
      // The renderer is gone but the destroy event has not run yet: tear down
      // now instead of dropping events silently on the floor.
      disposeWindow(window);
      return;
    }
    const ids = [...scope.ids];
    for (let index = 0; index < ids.length; index += MAX_IDS_PER_EVENT) {
      const slice = ids.slice(index, index + MAX_IDS_PER_EVENT);
      sender.send?.(DESKTOP_IPC_CHANNELS.event, { subscriptionIds: slice, event });
    }
  }

  function openScope(target: ClientTransport, window: WindowSubscriptions, scope: SubscriptionScope): ScopeSubscription {
    const entry: ScopeSubscription = { ids: new Set(), hostUnsubscribe: undefined, disposed: false };
    entry.hostUnsubscribe = target.subscribe(scope, (event: ClientEvent) => {
      forward(window, entry, event);
    });
    return entry;
  }

  function register(sender: DesktopSender, target: ClientTransport, request: { subscriptionId: string; scope: SubscriptionScope }): void {
    const window = trackWindow(sender);
    // Same id twice: the first registration stands. Re-registering would
    // double-deliver to that listener and orphan the earlier Host subscription.
    if (window.byId.has(request.subscriptionId)) return;
    const key = canonicalScopeKey(request.scope);
    let scope = window.byScope.get(key);
    if (scope === undefined) {
      scope = openScope(target, window, request.scope);
      window.byScope.set(key, scope);
    }
    scope.ids.add(request.subscriptionId);
    window.byId.set(request.subscriptionId, key);
    // A cancellation that arrived before this registration (renderer called
    // unsubscribe before the subscribe invoke resolved, or a reordering IPC
    // layer) must not survive as an orphan: register then cancel immediately.
    if (cancelled.delete(request.subscriptionId)) {
      cancelSubscription(window, request.subscriptionId);
    }
  }

  function cancelSubscription(window: WindowSubscriptions, subscriptionId: string): boolean {
    const key = window.byId.get(subscriptionId);
    if (key === undefined) return false;
    window.byId.delete(subscriptionId);
    const scope = window.byScope.get(key);
    if (scope === undefined) return true;
    scope.ids.delete(subscriptionId);
    if (scope.ids.size === 0) {
      window.byScope.delete(key);
      disposeScope(scope);
    }
    return true;
  }

  /**
   * Cancel by id for one sender. Unknown windows/ids are not an error: the
   * subscription is already unreachable, which is exactly what the caller
   * asked for. The id is remembered so a registration that lands later still
   * cancels itself.
   */
  function cancel(sender: DesktopSender, subscriptionId: string): boolean {
    const window = windows.get(sender.id);
    if (window === undefined) {
      rememberCancellation(subscriptionId);
      return false;
    }
    if (!cancelSubscription(window, subscriptionId)) {
      rememberCancellation(subscriptionId);
      return false;
    }
    return true;
  }

  ipc.handle(DESKTOP_IPC_CHANNELS.bootstrap, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event.sender);
    try {
      const bootstrap = await requireFacade().bootstrap();
      if (!isPlainObject(bootstrap)) {
        throw new Error("desktop ipc: invalid bootstrap response");
      }
      return bootstrap;
    } catch (error) {
      throwIpcError(error);
    }
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.query, async (event: IpcMainInvokeEvent, payload: unknown) => {
    assertTrustedSender(event.sender);
    try {
      return await requireFacade().query(parseClientQueryRequest(payload));
    } catch (error) {
      throwIpcError(error);
    }
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.command, async (event: IpcMainInvokeEvent, payload: unknown) => {
    assertTrustedSender(event.sender);
    try {
      return await requireFacade().command(parseClientCommandRequest(payload));
    } catch (error) {
      throwIpcError(error);
    }
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.subscribe, (event: IpcMainInvokeEvent, payload: unknown) => {
    const sender = event.sender as unknown as DesktopSender;
    assertTrustedSender(sender);
    const request = parseSubscriptionRegistration(payload);
    register(sender, requireFacade(), request);
    return { ok: true, subscriptionId: request.subscriptionId };
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.unsubscribe, (event: IpcMainInvokeEvent, payload: unknown) => {
    const sender = event.sender as unknown as DesktopSender;
    assertTrustedSender(sender);
    const request = parseSubscriptionCancellation(payload);
    return { ok: true, cancelled: cancel(sender, request.subscriptionId) };
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.close, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event.sender);
    // Renderer close only drops this window's subscriptions. Host lifetime is
    // owned by Main (`composition.ts`: reload must not touch Host; quit does).
    const window = windows.get((event.sender as unknown as DesktopSender).id);
    if (window !== undefined) disposeWindow(window);
  });

  return Object.freeze({
    dispose(): void {
      for (const window of [...windows.values()]) disposeWindow(window);
      windows.clear();
      cancelled.clear();
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.bootstrap);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.query);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.command);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.subscribe);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.unsubscribe);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.close);
    },
  });
}
