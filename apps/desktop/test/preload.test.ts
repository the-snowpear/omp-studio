/**
 * P1 preload bridge security tests (FRONTEND_INTEGRATION.md §9.1).
 *
 * The sandboxed preload exposes exactly one frozen `OmpStudioDesktopApi`
 * object (window.ompStudio) built by `createDesktopIpcBridge` over a
 * fixed-channel sender. These tests exercise the bridge headlessly with a
 * fake sender: no Electron import, no display. They defend the preload's
 * hard guarantees — named methods only (no generic invoke), fixed channels
 * only, exact-listener unsubscribe, per-listener scope filtering and no
 * sender exposure.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ClientEvent, SubscriptionScope } from "@omp-studio/client-contract";
import { DESKTOP_IPC_CHANNELS } from "@omp-studio/transport-desktop";

import {
  createDesktopIpcBridge,
  DESKTOP_BRIDGE_GLOBAL,
  type DesktopIpcBridge,
} from "../src/ipc-validation.js";
import type { OmpStudioDesktopApi } from "@omp-studio/transport-desktop";
import { createOmpStudioChromeApi } from "../src/chrome-api.js";

interface RecordedInvoke {
  readonly channel: string;
  readonly args: readonly unknown[];
}

/** Fake sender recording every invoke/on/removeListener call. */
class FakeBridge implements DesktopIpcBridge {
  readonly invokes: RecordedInvoke[] = [];
  readonly removed: Array<{ channel: string; listener: unknown }> = [];
  readonly listeners = new Map<string, Set<(event: unknown, ...args: readonly unknown[]) => void>>();
  rejectSubscribe = false;

  async invoke(channel: string, ...args: readonly unknown[]): Promise<unknown> {
    this.invokes.push({ channel, args });
    if (this.rejectSubscribe && channel === DESKTOP_IPC_CHANNELS.subscribe) {
      throw new Error("simulated main-side validation failure");
    }
    return undefined;
  }

  on(channel: string, listener: (event: unknown, ...args: readonly unknown[]) => void): void {
    let set = this.listeners.get(channel);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
  }

  removeListener(
    channel: string,
    listener: (event: unknown, ...args: readonly unknown[]) => void,
  ): void {
    this.removed.push({ channel, listener });
    this.listeners.get(channel)?.delete(listener);
  }

  /** Fire a payload at every registered listener of the event channel. */
  emitEvent(payload: unknown): void {
    for (const listener of [...(this.listeners.get(DESKTOP_IPC_CHANNELS.event) ?? [])]) {
      listener(payload);
    }
  }

  /** Electron-shaped dispatch: first arg is a non-JSON IpcRendererEvent. */
  emitElectronEvent(payload: unknown): void {
    const ipcEvent = { sender: { send() {} } };
    for (const listener of [...(this.listeners.get(DESKTOP_IPC_CHANNELS.event) ?? [])]) {
      listener(ipcEvent, payload);
    }
  }
}

const EVENT_BASE = {
  authorityEpoch: 1,
  stateVersion: 2,
  cursor: "3",
  occurredAt: "2026-08-12T00:00:00.000Z",
};

function makeEvent(overrides: object): ClientEvent {
  return { kind: "state.changed", ...EVENT_BASE, ...overrides } as unknown as ClientEvent;
}

describe("createDesktopIpcBridge: fixed named surface, no generic invoke", () => {
  test("exposes exactly the five named methods, frozen, with no invoke escape hatch", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    assert.deepEqual(Object.keys(api).sort(), ["bootstrap", "close", "command", "query", "subscribe"]);
    assert.ok(Object.isFrozen(api));
    assert.equal((api as unknown as Record<string, unknown>).invoke, undefined);
    assert.equal((api as unknown as Record<string, unknown>).bridge, undefined);
    assert.equal((api as unknown as Record<string, unknown>).ipcRenderer, undefined);
  });

  test("exposes the bridge under the documented window global", () => {
    assert.equal(DESKTOP_BRIDGE_GLOBAL, "ompStudio");
  });
});

describe("createDesktopIpcBridge: named methods route to fixed channels", () => {
  test("bootstrap and close invoke their channels with no payload", async () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    await api.bootstrap();
    await api.close();
    assert.deepEqual(bridge.invokes, [
      { channel: DESKTOP_IPC_CHANNELS.bootstrap, args: [] },
      { channel: DESKTOP_IPC_CHANNELS.close, args: [] },
    ]);
  });

  test("query and command pass the envelope as the only payload", async () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const query = { queryName: "home.get" as const, input: {} };
    const command = {
      commandName: "session.drop" as const,
      input: { threadId: "t-1" as const },
      idempotencyKey: "idem-1" as const,
      requestId: "req-1" as const,
    } as unknown as Parameters<OmpStudioDesktopApi["command"]>[0];
    await api.query(query);
    await api.command(command);
    assert.deepEqual(bridge.invokes, [
      { channel: DESKTOP_IPC_CHANNELS.query, args: [query] },
      { channel: DESKTOP_IPC_CHANNELS.command, args: [command] },
    ]);
  });

  test("subscribe registers the scope on the subscribe channel and returns an unsubscribe", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const scope: SubscriptionScope = { scope: "runtime" };
    const unsubscribe = api.subscribe(scope, () => {});
    assert.equal(typeof unsubscribe, "function");
    assert.deepEqual(bridge.invokes, [{ channel: DESKTOP_IPC_CHANNELS.subscribe, args: [scope] }]);
    assert.equal(bridge.listeners.get(DESKTOP_IPC_CHANNELS.event)?.size ?? 0, 1);
  });
});

describe("createDesktopIpcBridge: unsubscribe removes the exact listener", () => {
  test("removing one listener leaves the sibling listener active", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const receivedA: ClientEvent[] = [];
    const receivedB: ClientEvent[] = [];
    const unsubscribeA = api.subscribe({ scope: "all" }, (event) => {
      receivedA.push(event);
    });
    const unsubscribeB = api.subscribe({ scope: "all" }, (event) => {
      receivedB.push(event);
    });
    const event = makeEvent({});
    bridge.emitEvent(event);
    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);

    unsubscribeA();
    assert.equal(bridge.removed.length, 1);
    assert.equal(bridge.listeners.get(DESKTOP_IPC_CHANNELS.event)?.size ?? 0, 1);

    bridge.emitEvent(makeEvent({ cursor: "4" }));
    assert.equal(receivedA.length, 1, "unsubscribed listener must not fire again");
    assert.equal(receivedB.length, 2, "sibling listener stays subscribed");
    void unsubscribeB;
  });

  test("unsubscribe passes the exact registered listener reference to removeListener", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const unsubscribe = api.subscribe({ scope: "all" }, () => {});
    const registered = [...(bridge.listeners.get(DESKTOP_IPC_CHANNELS.event) ?? [])];
    assert.equal(registered.length, 1);
    unsubscribe();
    assert.equal(bridge.removed.length, 1);
    assert.equal(bridge.removed[0]?.channel, DESKTOP_IPC_CHANNELS.event);
    assert.equal(bridge.removed[0]?.listener, registered[0], "identity removal, not a wrapper");
  });

  test("a second unsubscribe is a safe no-op remove of the same listener", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const unsubscribe = api.subscribe({ scope: "all" }, () => {});
    unsubscribe();
    unsubscribe();
    assert.equal(bridge.removed.length, 2);
    assert.equal(bridge.removed[0]?.listener, bridge.removed[1]?.listener);
  });

  test("a rejected subscription registration does not break the unsubscribe", () => {
    const bridge = new FakeBridge();
    bridge.rejectSubscribe = true;
    const api = createDesktopIpcBridge(bridge);
    const received: ClientEvent[] = [];
    const unsubscribe = api.subscribe({ scope: "all" }, (event) => {
      received.push(event);
    });
    unsubscribe();
    assert.equal(bridge.removed.length, 1);
    bridge.emitEvent(makeEvent({}));
    assert.equal(received.length, 0);
  });
});

describe("createDesktopIpcBridge: per-listener scope filtering", () => {
  test("runtime scope delivers only events that carry a runtime epoch", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const received: ClientEvent[] = [];
    api.subscribe({ scope: "runtime" }, (event) => {
      received.push(event);
    });
    bridge.emitEvent(makeEvent({ cursor: "1" }));
    bridge.emitEvent(makeEvent({ cursor: "2", runtimeEpoch: 0 }));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.cursor, "2");
  });

  test("command scope delivers only lifecycle events of its requestId", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const received: ClientEvent[] = [];
    api.subscribe({ scope: "command", requestId: "req-1" } as SubscriptionScope, (event) => {
      received.push(event);
    });
    bridge.emitEvent(makeEvent({ cursor: "1" }));
    bridge.emitEvent(
      makeEvent({
        kind: "command.accepted",
        cursor: "2",
        accepted: { commandName: "session.drop", requestId: "req-1", status: "accepted", acceptedAt: "2026-08-12T00:00:00.000Z" },
      }),
    );
    bridge.emitEvent(
      makeEvent({
        kind: "command.accepted",
        cursor: "3",
        accepted: { commandName: "session.drop", requestId: "req-other", status: "accepted", acceptedAt: "2026-08-12T00:00:00.000Z" },
      }),
    );
    assert.equal(received.length, 1);
    assert.equal(received[0]?.cursor, "2");
  });

  test("all scope delivers every event and thread scope delivers none", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const all: ClientEvent[] = [];
    const thread: ClientEvent[] = [];
    api.subscribe({ scope: "all" }, (event) => {
      all.push(event);
    });
    api.subscribe({ scope: "thread", threadId: "t-1" } as SubscriptionScope, (event) => {
      thread.push(event);
    });
    bridge.emitEvent(makeEvent({ cursor: "1" }));
    assert.equal(all.length, 1);
    assert.equal(thread.length, 0);
  });

  test("null and primitive event payloads are dropped without touching listeners", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const received: ClientEvent[] = [];
    api.subscribe({ scope: "all" }, (event) => {
      received.push(event);
    });
    for (const payload of [null, undefined, "tampered", 42, true]) {
      bridge.emitEvent(payload);
    }
    assert.equal(received.length, 0);
  });

  test("Electron (ipcEvent, payload) dispatch delivers the envelope, not the IPC event", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const received: ClientEvent[] = [];
    api.subscribe({ scope: "all" }, (event) => {
      received.push(event);
    });
    const event = makeEvent({ cursor: "e1" });
    bridge.emitElectronEvent(event);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.cursor, "e1");
    assert.equal("sender" in (received[0] as object), false);
  });
});

describe("createOmpStudioChromeApi: fixed named surface, frozen object", () => {
  test("exposes exactly the expected named methods and is frozen", () => {
    const fakeIpc = {
      invoke: async () => undefined,
      on: () => {},
      removeListener: () => {},
    };
    const chromeApi = createOmpStudioChromeApi(fakeIpc);
    assert.ok(Object.isFrozen(chromeApi));

    const expectedMethods = [
      "applyUpdate",
      "cancelUpdate",
      "checkAppUpdate",
      "checkUpdates",
      "clearAvatar",
      "copyImage",
      "downloadAppUpdate",
      "exportLogs",
      "getAppVersion",
      "getPathForFile",
      "getUpdatePrefs",
      "importLocalUpdate",
      "listFileOpeners",
      "loadAvatar",
      "notify",
      "openFile",
      "openFileWith",
      "openLogDir",
      "openProjectDirectory",
      "openProjectInEditor",
      "openUrl",
      "pickPlanSavePath",
      "quitAndInstallUpdate",
      "rollbackUpdate",
      "rollbackRuntimeUpdate",
      "pruneRuntimeUpdates",
      "resolveDroppedPaths",
      "resolveFileAbsolutePath",
      "revealFileInFileManager",
      "sampleProcessMemory",
      "saveAvatar",
      "saveImage",
      "setTheme",
      "setUpdatePrefs",
      "startApp",
      "startRuntime",
      "subscribeUpdateProgress",
    ].sort();

    assert.deepEqual(Object.keys(chromeApi).sort(), expectedMethods);
  });
});
