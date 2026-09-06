/**
 * Main-process Desktop IPC bridge (FRONTEND_INTEGRATION.md §9).
 *
 * Registers handlers for exactly the fixed `DESKTOP_IPC_CHANNELS` set —
 * bootstrap / query / command / subscribe / close — with no generic
 * `ipcMain.handle(channel, payload)` surface. Every inbound payload is
 * parsed with the `@omp-studio/transport-desktop` strict validators before
 * it reaches the facade; every outbound response/event is asserted before
 * it crosses back to the preload.
 *
 * Security posture:
 * - Client identity is bound from `IpcMainInvokeEvent.sender` only; the
 *   renderer never supplies identity, window ids or authority fields.
 * - Calls from destroyed or untrusted WebContents are rejected up front.
 * - A null facade (composition failed to build) fails every channel closed:
 *   bootstrap/query/command/subscribe reject, close resolves as a no-op —
 *   the window stays open in read-only state.
 * - Subscriptions are window-bound and torn down on window destroy,
 *   main-frame navigation (reload) and the close request, so a reloaded
 *   page can never observe stale events. Renderer `close` never shuts
 *   down the Host facade — only app quit does.
 * - The facade (`ClientTransport`) is the only host-facing seam; no Bridge
 *   token, endpoint, process handle or path ever appears in this module's
 *   payloads.
 */

import { ipcMain, type IpcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import type { ClientEvent, ClientTransport, SubscriptionScope, Unsubscribe } from "@omp-studio/client-contract";
import {
  DESKTOP_IPC_CHANNELS,
  assertClientCommandAccepted,
  assertClientEvent,
  assertClientQueryResponse,
  isPlainObject,
  parseClientCommandRequest,
  parseClientQueryRequest,
  parseSubscriptionScope,
} from "@omp-studio/transport-desktop";

/**
 * Electron-neutral view of the IPC event sender. WebContents satisfies it
 * structurally, and tests can pass a minimal fake without pulling in the
 * full Electron `WebContents` surface.
 */
export interface DesktopSender {
  isDestroyed(): boolean;
  getURL(): string;
}

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

interface WindowSubscriptions {
  readonly subscriptions: Set<Unsubscribe>;
  readonly teardown: () => void;
}

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
 * Register the fixed Desktop IPC surface for one facade. Calling twice with
 * the same `ipcMain` throws (Electron rejects duplicate handlers); dispose
 * first when swapping facades (e.g. after a composition reload).
 */
export function registerDesktopIpc(options: DesktopIpcOptions): DesktopIpcHandle {
  const ipc = options.ipcMain ?? ipcMain;
  const facade = options.facade;
  const windows = new Map<number, WindowSubscriptions>();

  function assertTrustedSender(sender: WebContents): void {
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

  function trackWindow(sender: WebContents): WindowSubscriptions {
    const existing = windows.get(sender.id);
    if (existing !== undefined) {
      return existing;
    }
    const subscriptions = new Set<Unsubscribe>();
    const teardown = (): void => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      subscriptions.clear();
      windows.delete(sender.id);
    };
    // Reload keeps the same WebContents but a fresh preload/renderer:
    // drop stale window subscriptions so the new page starts clean.
    sender.once("destroyed", teardown);
    sender.once("did-navigate", teardown);
    const entry: WindowSubscriptions = { subscriptions, teardown };
    windows.set(sender.id, entry);
    return entry;
  }

  function subscribeWindow(target: ClientTransport, sender: WebContents, scope: SubscriptionScope): void {
    const entry = trackWindow(sender);
    const unsubscribe = target.subscribe(scope, (event: ClientEvent) => {
      assertClientEvent(event);
      if (!sender.isDestroyed()) {
        sender.send(DESKTOP_IPC_CHANNELS.event, event);
      }
    });
    entry.subscriptions.add(unsubscribe);
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
      const request = parseClientQueryRequest(payload);
      const response = await requireFacade().query(request);
      assertClientQueryResponse(response);
      return response;
    } catch (error) {
      throwIpcError(error);
    }
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.command, async (event: IpcMainInvokeEvent, payload: unknown) => {
    assertTrustedSender(event.sender);
    try {
      const request = parseClientCommandRequest(payload);
      const accepted = await requireFacade().command(request);
      assertClientCommandAccepted(accepted);
      return accepted;
    } catch (error) {
      throwIpcError(error);
    }
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.subscribe, (event: IpcMainInvokeEvent, payload: unknown) => {
    assertTrustedSender(event.sender);
    const scope = parseSubscriptionScope(payload);
    subscribeWindow(requireFacade(), event.sender, scope);
    return { ok: true };
  });

  ipc.handle(DESKTOP_IPC_CHANNELS.close, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event.sender);
    // Renderer close only drops this window's subscriptions. Host lifetime is
    // owned by Main (`composition.ts`: reload must not touch Host; quit does).
    windows.get(event.sender.id)?.teardown();
  });

  return Object.freeze({
    dispose(): void {
      for (const entry of windows.values()) {
        entry.teardown();
      }
      windows.clear();
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.bootstrap);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.query);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.command);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.subscribe);
      ipc.removeHandler(DESKTOP_IPC_CHANNELS.close);
    },
  });
}
