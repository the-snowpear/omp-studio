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
  /** When true, `subscribe` invokes stay pending until `resolveSubscribe()`. */
  delaySubscribe = false;
  readonly pending: Array<() => void> = [];

  async invoke(channel: string, ...args: readonly unknown[]): Promise<unknown> {
    this.invokes.push({ channel, args });
    if (this.rejectSubscribe && channel === DESKTOP_IPC_CHANNELS.subscribe) {
      throw new Error("simulated main-side validation failure");
    }
    if (this.delaySubscribe && channel === DESKTOP_IPC_CHANNELS.subscribe) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
    return undefined;
  }

  resolveSubscribe(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  /** Subscription ids the bridge registered, in call order. */
  get subscriptionIds(): string[] {
    return this.invokes
      .filter((entry) => entry.channel === DESKTOP_IPC_CHANNELS.subscribe)
      .map((entry) => (entry.args[0] as { subscriptionId: string }).subscriptionId);
  }

  /** Cancelled subscription ids, in call order. */
  get cancelledIds(): string[] {
    return this.invokes
      .filter((entry) => entry.channel === DESKTOP_IPC_CHANNELS.unsubscribe)
      .map((entry) => (entry.args[0] as { subscriptionId: string }).subscriptionId);
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
  emitPayload(payload: unknown): void {
    for (const listener of [...(this.listeners.get(DESKTOP_IPC_CHANNELS.event) ?? [])]) {
      listener(payload);
    }
  }

  /**
   * Deliver one Main -> Renderer event envelope. Defaults to addressing every
   * subscription this bridge registered, which is what Main does when all of
   * them share a scope.
   */
  emitEvent(event: ClientEvent, ids: readonly string[] = this.subscriptionIds): void {
    this.emitPayload({ subscriptionIds: [...ids], event });
  }

  /** Electron-shaped dispatch: first arg is a non-JSON IpcRendererEvent. */
  emitElectronEvent(event: ClientEvent, ids: readonly string[] = this.subscriptionIds): void {
    const ipcEvent = { sender: { send() {} } };
    for (const listener of [...(this.listeners.get(DESKTOP_IPC_CHANNELS.event) ?? [])]) {
      listener(ipcEvent, { subscriptionIds: [...ids], event });
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

  test("subscribe registers a new id with its scope and returns an unsubscribe", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const scope: SubscriptionScope = { scope: "runtime" };
    const unsubscribe = api.subscribe(scope, () => {});
    assert.equal(typeof unsubscribe, "function");
    assert.equal(bridge.invokes.length, 1);
    assert.equal(bridge.invokes[0]?.channel, DESKTOP_IPC_CHANNELS.subscribe);
    const payload = bridge.invokes[0]?.args[0] as { scope: SubscriptionScope; subscriptionId: string };
    assert.deepEqual(payload.scope, scope);
    assert.match(payload.subscriptionId, /^[A-Za-z0-9._-]{1,64}$/u);
    assert.equal(bridge.listeners.get(DESKTOP_IPC_CHANNELS.event)?.size ?? 0, 1);
  });

  test("two subscriptions get distinct ids", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    api.subscribe({ scope: "all" }, () => {});
    api.subscribe({ scope: "all" }, () => {});
    const ids = bridge.subscriptionIds;
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
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
    assert.deepEqual(bridge.cancelledIds, [bridge.subscriptionIds[0]], "cancels that one id at Main");

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
    // The Main-side cancellation is sent exactly once: cancelling is
    // idempotent, so a repeated call must not queue a second IPC message.
    assert.equal(bridge.cancelledIds.length, 1);
  });

  test("an unsubscribe before the subscribe invoke resolves still cancels that id", async () => {
    const bridge = new FakeBridge();
    bridge.delaySubscribe = true;
    const api = createDesktopIpcBridge(bridge);
    const received: ClientEvent[] = [];
    const unsubscribe = api.subscribe({ scope: "all" }, (event) => {
      received.push(event);
    });
    const [subscriptionId] = bridge.subscriptionIds;
    assert.ok(subscriptionId);
    // Registration is still in flight; the caller unsubscribes immediately.
    unsubscribe();
    assert.deepEqual(bridge.cancelledIds, [subscriptionId]);
    bridge.emitEvent(makeEvent({}), [subscriptionId]);
    assert.equal(received.length, 0, "cancelled before delivery: no callback");
    bridge.resolveSubscribe();
    await Promise.resolve();
    assert.deepEqual(bridge.cancelledIds, [subscriptionId], "still exactly one cancellation");
    bridge.emitEvent(makeEvent({ cursor: "2" }), [subscriptionId]);
    assert.equal(received.length, 0);
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
      bridge.emitPayload(payload);
    }
    // Envelopes Main would never send for this subscription are ignored too:
    // wrong ids, a non-object event, and an id list that is not an array.
    bridge.emitPayload({ subscriptionIds: ["someone-else"], event: makeEvent({}) });
    bridge.emitPayload({ subscriptionIds: bridge.subscriptionIds, event: null });
    bridge.emitPayload({ subscriptionIds: "not-a-list", event: makeEvent({}) });
    bridge.emitPayload({ event: makeEvent({}) });
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

describe("createDesktopIpcBridge: id-addressed delivery", () => {
  test("one envelope naming several ids delivers exactly once to each listener", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const first: ClientEvent[] = [];
    const second: ClientEvent[] = [];
    api.subscribe({ scope: "all" }, (event) => { first.push(event); });
    api.subscribe({ scope: "all" }, (event) => { second.push(event); });
    const [firstId, secondId] = bridge.subscriptionIds;
    assert.ok(firstId && secondId);
    // Main forwards one message for the shared scope, addressed to both ids.
    bridge.emitEvent(makeEvent({ cursor: "1" }), [firstId, secondId]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1, "a sibling over the same scope is not starved");
  });

  test("a listener ignores a copy addressed to a different id", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const mine: ClientEvent[] = [];
    api.subscribe({ scope: "all" }, (event) => { mine.push(event); });
    const [myId, otherId] = [bridge.subscriptionIds[0], "some-other-subscription"];
    assert.ok(myId);
    bridge.emitEvent(makeEvent({ cursor: "1" }), [otherId]);
    assert.equal(mine.length, 0);
    bridge.emitEvent(makeEvent({ cursor: "2" }), [myId]);
    assert.equal(mine.length, 1);
  });

  test("two scopes matching one event forward it once per subscription, never twice to one", () => {
    const bridge = new FakeBridge();
    const api = createDesktopIpcBridge(bridge);
    const all: ClientEvent[] = [];
    const runtime: ClientEvent[] = [];
    api.subscribe({ scope: "all" }, (event) => { all.push(event); });
    api.subscribe({ scope: "runtime" }, (event) => { runtime.push(event); });
    const [allId, runtimeId] = bridge.subscriptionIds;
    assert.ok(allId && runtimeId);
    const event = makeEvent({ cursor: "1", runtimeEpoch: 1 });
    // Main keeps one Host subscription per scope, so the event arrives twice
    // at the window but each envelope names exactly one id.
    bridge.emitEvent(event, [allId]);
    bridge.emitEvent(event, [runtimeId]);
    assert.equal(all.length, 1);
    assert.equal(runtime.length, 1);
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
      "platform",
      "onMenuCommand",
      "requestMicrophoneAccess",
      "openMicrophoneSettings",
      "applyUpdate",
      "cancelUpdate",
      "chooseArtifactDirectory", "importArtifact", "exportArtifact",
      "revealSkillshareToken", "beginMediaUpload", "appendLiveAudio", "attachLiveAudio", "detachLiveAudio", "appendMediaUpload", "finishMediaUpload", "abortMediaUpload",
      "attachBrowserObservation", "controlBrowserObservation", "detachBrowserObservation", "onBrowserObservation",
      "attachPrediction", "predictionInput", "detachPrediction", "importPredictionHistory", "onPrediction",
      "readComputerCapture",
      "listServiceDefinitions", "saveServiceDefinition", "removeServiceDefinition",
      "checkAppUpdate",
      "checkUpdates",
      "getUpdateSnapshot",
      "prepareUpdates",
      "subscribeUpdates",
      "clearAvatar",
      "copyImage",
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
      "reportPayloadHealth",
      "reportPerformanceSample",
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
      "setConversationViewState",
      "setUpdatePrefs",
      "startApp",
      "startRuntime",
      "subscribeUpdateProgress",
    ].sort();

    assert.deepEqual(Object.keys(chromeApi).sort(), expectedMethods);
  });

  test("the platform is fixed at preload time and anything but Windows or macOS reads as linux", () => {
    const fakeIpc = { invoke: async () => undefined, on: () => {}, removeListener: () => {} };
    assert.equal(createOmpStudioChromeApi(fakeIpc, undefined, "darwin").platform, "darwin");
    assert.equal(createOmpStudioChromeApi(fakeIpc, undefined, "win32").platform, "win32");
    assert.equal(createOmpStudioChromeApi(fakeIpc, undefined, "freebsd").platform, "linux");
  });

  test("menu commands arrive only from the fixed channel and only when allowlisted", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const fakeIpc = {
      invoke: async () => undefined,
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.set(channel, listener); },
      removeListener: (channel: string) => { listeners.delete(channel); },
    };
    const received: string[] = [];
    const unsubscribe = createOmpStudioChromeApi(fakeIpc, undefined, "darwin").onMenuCommand((command) => received.push(command));
    const deliver = listeners.get("omp-studio:desktop:menu-command");
    assert.ok(deliver);
    deliver({}, "view.commandPalette");
    deliver({}, "app.runArbitraryCode");
    deliver({}, { command: "file.newChat" });
    assert.deepEqual(received, ["view.commandPalette"]);
    unsubscribe();
    assert.equal(listeners.has("omp-studio:desktop:menu-command"), false);
  });
});
