/**
 * P1-1 Desktop IPC subscription lifecycle tests (FRONTEND_INTEGRATION.md §9).
 *
 * The leak being defended against: a Renderer that stopped listening used to
 * leave its Host subscription alive in Main, because `unsubscribe` only
 * removed the local `ipcRenderer` listener and Main had no id to cancel. These
 * tests pin the contract that replaced it:
 *
 * - every `subscribe` owns exactly one `subscriptionId`;
 * - cancelling one id leaves its siblings (including siblings over the same
 *   scope) untouched;
 * - a cancellation that arrives before its registration still leaves no
 *   orphan Host subscription;
 * - cancelling twice is safe, and an unknown id is a silent no-op;
 * - window destroy / navigation / renderer crash tears down every id, and
 *   nothing is sent to a destroyed WebContents afterwards;
 * - N subscribe / N unsubscribe returns the Host subscription count to its
 *   baseline instead of growing without bound.
 *
 * `registerDesktopIpc` imports `electron` at module load; the data-URL loader
 * registered below stubs that module, so the test runs under plain
 * `node --test` with no Electron binary.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";

// ---- Electron stub (data-URL loader, registered before any app import) ----
const ELECTRON_STUB = "data:text/javascript," + encodeURIComponent(`
  export const ipcMain = {};
  export const contextBridge = {};
  export const ipcRenderer = {};
`);
register(
  "data:text/javascript," +
    encodeURIComponent(
      `const STUB = ${JSON.stringify(ELECTRON_STUB)};
       export async function resolve(specifier, context, nextResolve) {
         if (specifier === "electron") return { url: STUB, shortCircuit: true };
         return nextResolve(specifier, context);
       }`,
    ),
);

// Static imports resolve before the loader hook above runs, so the
// Electron-coupled module must be loaded dynamically after registration.
const { registerDesktopIpc } = await import("../src/ipc.js");

import type {
  ClientBootstrap,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientQueryRequest,
  ClientQueryResponse,
  ClientEvent,
  ClientTransport,
  CommandName,
  QueryName,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";
import { DESKTOP_IPC_CHANNELS } from "@omp-studio/transport-desktop";

import type { DesktopIpcHandle, DesktopIpcOptions, DesktopSender } from "../src/ipc.js";

// ---- Fakes ---------------------------------------------------------------

interface HostListener {
  readonly scope: SubscriptionScope;
  readonly listener: (event: ClientEvent) => void;
  active: boolean;
}

interface FakeFacade extends ClientTransport {
  readonly observed: HostListener[];
  /** Live Host subscriptions: the number that must return to its baseline. */
  activeCount(): number;
  /** Total Host subscriptions ever created (monotonic). */
  subscribeCalls(): number;
  emit(event: ClientEvent): void;
}

function makeFacade(): FakeFacade {
  const observed: HostListener[] = [];
  return {
    observed,
    activeCount: () => observed.filter((entry) => entry.active).length,
    subscribeCalls: () => observed.length,
    emit(event: ClientEvent) {
      for (const entry of [...observed]) {
        if (entry.active) entry.listener(event);
      }
    },
    async bootstrap() {
      return { ok: true } as unknown as ClientBootstrap;
    },
    async query<TName extends QueryName>(_request: ClientQueryRequest<TName>) {
      return { ok: true, queryName: "home.get", result: { ok: true } } as unknown as ClientQueryResponse<TName>;
    },
    async command<TName extends CommandName>(_request: ClientCommandRequest<TName>) {
      return { status: "accepted" } as unknown as ClientCommandAccepted<TName>;
    },
    subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
      const entry: HostListener = { scope, listener, active: true };
      observed.push(entry);
      return () => {
        entry.active = false;
      };
    },
    async close() {},
  };
}

interface FakeSender extends DesktopSender {
  destroyed: boolean;
  readonly sent: Array<{ channel: string; payload: unknown }>;
  readonly listeners: Map<string, Set<(...args: readonly unknown[]) => void>>;
  fire(event: string): void;
  listenerCount(event: string): number;
}

function makeSender(id: number): FakeSender {
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const add = (event: string, listener: (...args: readonly unknown[]) => void): void => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
  };
  return {
    id,
    destroyed: false,
    sent: [],
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return "https://studio.invalid/index.html";
    },
    on: add,
    once: add,
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
    fire(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

interface FakeIpcMain {
  readonly handlers: Map<string, (event: { sender: FakeSender }, ...args: unknown[]) => unknown>;
  readonly removed: string[];
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

function makeIpcMain(): FakeIpcMain {
  return {
    handlers: new Map(),
    removed: [],
    handle(channel, listener) {
      this.handlers.set(channel, listener as (event: { sender: FakeSender }, ...args: unknown[]) => unknown);
    },
    removeHandler(channel) {
      this.removed.push(channel);
      this.handlers.delete(channel);
    },
  };
}

const EVENT_BASE = {
  authorityEpoch: 1,
  stateVersion: 2,
  cursor: "3",
  occurredAt: "2026-08-12T00:00:00.000Z",
};

function stateEvent(cursor = "3"): ClientEvent {
  return { kind: "state.changed", ...EVENT_BASE, cursor } as ClientEvent;
}

function runtimeEvent(cursor = "4"): ClientEvent {
  return { kind: "state.changed", ...EVENT_BASE, cursor, runtimeEpoch: 1 } as ClientEvent;
}

interface Harness {
  readonly ipc: FakeIpcMain;
  readonly facade: FakeFacade;
  readonly handle: DesktopIpcHandle;
  subscribe(sender: FakeSender, subscriptionId: string, scope: SubscriptionScope): Promise<unknown>;
  unsubscribe(sender: FakeSender, subscriptionId: string): Promise<unknown>;
  close(sender: FakeSender): Promise<unknown>;
  /** `{ subscriptionIds }` of every event envelope sent to `sender`. */
  envelopes(sender: FakeSender): string[][];
}

function harness(trusted: (sender: DesktopSender) => boolean = () => true): Harness {
  const ipc = makeIpcMain();
  const facade = makeFacade();
  const handle = registerDesktopIpc({
    facade,
    isTrustedSender: trusted,
    ipcMain: ipc as unknown as NonNullable<DesktopIpcOptions["ipcMain"]>,
  });
  const invoke = async (channel: string, sender: FakeSender, ...args: unknown[]): Promise<unknown> => {
    const handler = ipc.handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return await handler({ sender }, ...args);
  };
  return {
    ipc,
    facade,
    handle,
    subscribe: (sender, subscriptionId, scope) =>
      invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope, subscriptionId }),
    unsubscribe: (sender, subscriptionId) =>
      invoke(DESKTOP_IPC_CHANNELS.unsubscribe, sender, { subscriptionId }),
    close: (sender) => invoke(DESKTOP_IPC_CHANNELS.close, sender),
    envelopes(sender) {
      return sender.sent
        .filter((entry) => entry.channel === DESKTOP_IPC_CHANNELS.event)
        .map((entry) => (entry.payload as { subscriptionIds: string[] }).subscriptionIds);
    },
  };
}

// ---- Id-scoped subscription lifecycle -------------------------------------

describe("desktop ipc subscriptions: one id per subscription", () => {
  test("each subscribe returns its own id and both ids receive one event copy", async () => {
    const rig = harness();
    const sender = makeSender(1);
    const a = await rig.subscribe(sender, "sub-a", { scope: "all" });
    const b = await rig.subscribe(sender, "sub-b", { scope: "all" });
    assert.deepEqual(a, { ok: true, subscriptionId: "sub-a" });
    assert.deepEqual(b, { ok: true, subscriptionId: "sub-b" });
    // Same scope: ONE Host subscription serves both renderer ids.
    assert.equal(rig.facade.activeCount(), 1);
    assert.equal(rig.facade.subscribeCalls(), 1);

    rig.facade.emit(stateEvent());
    assert.deepEqual(rig.envelopes(sender), [["sub-a", "sub-b"]], "one envelope covers both ids");
    assert.equal(sender.sent.length, 1, "one IPC message per event, not one per subscription");
    rig.handle.dispose();
  });

  test("distinct scopes register distinct Host subscriptions", async () => {
    const rig = harness();
    const sender = makeSender(1);
    await rig.subscribe(sender, "sub-all", { scope: "all" });
    await rig.subscribe(sender, "sub-runtime", { scope: "runtime" });
    assert.equal(rig.facade.activeCount(), 2);
    rig.facade.emit(runtimeEvent());
    const envelopes = rig.envelopes(sender);
    assert.equal(envelopes.length, 2);
    assert.deepEqual(envelopes.flat().sort(), ["sub-all", "sub-runtime"]);
    rig.handle.dispose();
  });

  test("cancelling one id leaves a sibling over the same scope live", async () => {
    const rig = harness();
    const sender = makeSender(1);
    await rig.subscribe(sender, "sub-a", { scope: "all" });
    await rig.subscribe(sender, "sub-b", { scope: "all" });

    assert.deepEqual(await rig.unsubscribe(sender, "sub-a"), { ok: true, cancelled: true });
    assert.equal(rig.facade.activeCount(), 1, "the shared Host subscription survives for sub-b");
    rig.facade.emit(stateEvent("5"));
    assert.deepEqual(rig.envelopes(sender).at(-1), ["sub-b"]);

    assert.deepEqual(await rig.unsubscribe(sender, "sub-b"), { ok: true, cancelled: true });
    assert.equal(rig.facade.activeCount(), 0, "last id over the scope releases the Host subscription");
    rig.facade.emit(stateEvent("6"));
    assert.deepEqual(rig.envelopes(sender), [["sub-b"]], "no forwarding after the last cancel");
    rig.handle.dispose();
  });

  test("registering the same id twice does not double delivery", async () => {
    const rig = harness();
    const sender = makeSender(1);
    await rig.subscribe(sender, "sub-a", { scope: "all" });
    await rig.subscribe(sender, "sub-a", { scope: "all" });
    assert.equal(rig.facade.activeCount(), 1);
    rig.facade.emit(stateEvent());
    assert.deepEqual(rig.envelopes(sender), [["sub-a"]], "the id appears once per event");
    assert.equal(sender.sent.length, 1);
    rig.handle.dispose();
  });
});

describe("desktop ipc subscriptions: cancellation is idempotent and race-safe", () => {
  test("cancelling twice is safe and reports the second call as a no-op", async () => {
    const rig = harness();
    const sender = makeSender(1);
    await rig.subscribe(sender, "sub-a", { scope: "all" });
    assert.deepEqual(await rig.unsubscribe(sender, "sub-a"), { ok: true, cancelled: true });
    assert.deepEqual(await rig.unsubscribe(sender, "sub-a"), { ok: true, cancelled: false });
    assert.equal(rig.facade.activeCount(), 0);
    rig.handle.dispose();
  });

  test("an unknown id resolves successfully instead of throwing", async () => {
    const rig = harness();
    const sender = makeSender(1);
    assert.deepEqual(await rig.unsubscribe(sender, "never-registered"), {
      ok: true,
      cancelled: false,
    });
    assert.equal(rig.facade.activeCount(), 0);
    rig.handle.dispose();
  });

  test("a cancellation that lands before its registration leaves no orphan", async () => {
    const rig = harness();
    const sender = makeSender(1);
    // Renderer called unsubscribe while the subscribe invoke was still in
    // flight: Main sees the cancellation first.
    assert.deepEqual(await rig.unsubscribe(sender, "sub-early"), { ok: true, cancelled: false });
    const registered = await rig.subscribe(sender, "sub-early", { scope: "all" });
    assert.deepEqual(registered, { ok: true, subscriptionId: "sub-early" });
    assert.equal(rig.facade.activeCount(), 0, "the late registration cancelled itself");
    rig.facade.emit(stateEvent());
    assert.deepEqual(rig.envelopes(sender), []);
    rig.handle.dispose();
  });

  test("the remembered cancellation set is bounded and does not block new ids", async () => {
    const rig = harness();
    const sender = makeSender(1);
    for (let index = 0; index < 2_000; index += 1) {
      await rig.unsubscribe(sender, `ghost-${index}`);
    }
    // The early-cancel memory is a FIFO: old ids fall out, new ones still work
    // and a live registration always wins.
    await rig.subscribe(sender, "live", { scope: "all" });
    assert.equal(rig.facade.activeCount(), 1);
    rig.facade.emit(stateEvent());
    assert.deepEqual(rig.envelopes(sender), [["live"]]);
    rig.handle.dispose();
  });
});

describe("desktop ipc subscriptions: window teardown fallbacks", () => {
  for (const event of ["destroyed", "did-navigate", "render-process-gone"]) {
    test(`${event} tears down every subscription of that window`, async () => {
      const rig = harness();
      const sender = makeSender(1);
      await rig.subscribe(sender, "sub-a", { scope: "all" });
      await rig.subscribe(sender, "sub-b", { scope: "runtime" });
      assert.equal(rig.facade.activeCount(), 2);
      sender.fire(event);
      assert.equal(rig.facade.activeCount(), 0);
      rig.facade.emit(runtimeEvent());
      assert.deepEqual(rig.envelopes(sender), []);
      rig.handle.dispose();
    });
  }

  test("window teardown listeners do not accumulate across navigation cycles", async () => {
    const rig = harness();
    const sender = makeSender(1);
    for (let index = 0; index < 10; index += 1) {
      await rig.subscribe(sender, `sub-${index}`, { scope: "all" });
      sender.fire("did-navigate");
      assert.equal(rig.facade.activeCount(), 0, "each navigation released its scope");
    }
    assert.equal(sender.listenerCount("did-navigate"), 0, "detached after teardown");
    assert.equal(sender.listenerCount("destroyed"), 0);
    assert.equal(sender.listenerCount("render-process-gone"), 0);
    rig.handle.dispose();
  });

  test("nothing is sent once the WebContents reports itself destroyed", async () => {
    const rig = harness();
    const sender = makeSender(1);
    await rig.subscribe(sender, "sub-a", { scope: "all" });
    sender.destroyed = true;
    rig.facade.emit(stateEvent());
    assert.deepEqual(sender.sent, []);
    assert.equal(rig.facade.activeCount(), 0, "the destroy path also released the Host subscription");
    rig.handle.dispose();
  });

  test("the close channel still tears down only that window", async () => {
    const rig = harness();
    const senderA = makeSender(1);
    const senderB = makeSender(2);
    await rig.subscribe(senderA, "sub-a", { scope: "all" });
    await rig.subscribe(senderB, "sub-b", { scope: "all" });
    await rig.close(senderA);
    assert.equal(rig.facade.activeCount(), 1);
    rig.facade.emit(stateEvent());
    assert.deepEqual(rig.envelopes(senderA), []);
    assert.deepEqual(rig.envelopes(senderB), [["sub-b"]], "the other window is untouched");
    rig.handle.dispose();
  });

  test("dispose releases every window subscription", async () => {
    const rig = harness();
    const senderA = makeSender(1);
    const senderB = makeSender(2);
    await rig.subscribe(senderA, "sub-a", { scope: "all" });
    await rig.subscribe(senderB, "sub-b", { scope: "runtime" });
    rig.handle.dispose();
    assert.equal(rig.facade.activeCount(), 0);
  });
});

describe("desktop ipc subscriptions: bounded subscription count", () => {
  test("N subscriptions followed by N cancellations returns to the baseline", async () => {
    const rig = harness();
    const sender = makeSender(1);
    const baseline = rig.facade.activeCount();
    for (let round = 0; round < 200; round += 1) {
      await rig.subscribe(sender, `sub-${round}`, round % 2 === 0 ? { scope: "all" } : { scope: "runtime" });
      assert.ok(rig.facade.activeCount() <= 2, "distinct scopes are shared, not multiplied");
      await rig.unsubscribe(sender, `sub-${round}`);
      assert.equal(rig.facade.activeCount(), baseline, `round ${round} returned to baseline`);
    }
    const hostSubscriptions = rig.facade.subscribeCalls();
    rig.handle.dispose();
    assert.equal(rig.facade.activeCount(), 0);
    assert.ok(hostSubscriptions <= 400, "Host work is proportional, not unbounded");
  });

  test("a reloaded window starts from a clean subscription table", async () => {
    const rig = harness();
    const sender = makeSender(1);
    for (let index = 0; index < 5; index += 1) await rig.subscribe(sender, `sub-${index}`, { scope: "all" });
    assert.equal(rig.facade.activeCount(), 1);
    sender.fire("did-navigate");
    await rig.subscribe(sender, "sub-new", { scope: "all" });
    assert.equal(rig.facade.activeCount(), 1);
    rig.facade.emit(stateEvent());
    assert.deepEqual(rig.envelopes(sender), [["sub-new"]], "stale ids from the old document are gone");
    rig.handle.dispose();
  });
});

describe("desktop ipc subscriptions: envelope validation", () => {
  test("subscribe requires a subscription id and rejects smuggled fields", async () => {
    const rig = harness();
    const sender = makeSender(1);
    const invoke = async (payload: unknown): Promise<unknown> => {
      const handler = rig.ipc.handlers.get(DESKTOP_IPC_CHANNELS.subscribe);
      assert.ok(handler);
      return await handler({ sender }, payload);
    };
    await assert.rejects(() => invoke({ scope: "all" }), /subscription: expected a subscription id/);
    await assert.rejects(() => invoke({ scope: "all", subscriptionId: "" }), /subscription id/);
    await assert.rejects(() => invoke({ scope: "all", subscriptionId: "x".repeat(65) }), /subscription id/);
    await assert.rejects(
      () => invoke({ scope: "all", subscriptionId: "sub-a", windowId: 1 }),
      /subscription: unexpected field/,
    );
    await assert.rejects(() => invoke({ scope: "allx", subscriptionId: "sub-a" }));
    assert.equal(rig.facade.activeCount(), 0);
    rig.handle.dispose();
  });

  test("unsubscribe requires exactly a subscription id", async () => {
    const rig = harness();
    const sender = makeSender(1);
    const invoke = async (payload: unknown): Promise<unknown> => {
      const handler = rig.ipc.handlers.get(DESKTOP_IPC_CHANNELS.unsubscribe);
      assert.ok(handler);
      return await handler({ sender }, payload);
    };
    await assert.rejects(() => invoke({ scope: "all" }), /subscription cancellation/);
    await assert.rejects(() => invoke({ subscriptionId: "sub-a", scope: "all" }), /unexpected field/);
    rig.handle.dispose();
  });

  test("untrusted senders cannot subscribe or unsubscribe", async () => {
    const rig = harness(() => false);
    const sender = makeSender(1);
    await assert.rejects(() => rig.subscribe(sender, "sub-a", { scope: "all" }), /untrusted sender/);
    await assert.rejects(() => rig.unsubscribe(sender, "sub-a"), /untrusted sender/);
    assert.equal(rig.facade.activeCount(), 0);
    rig.handle.dispose();
  });

  test("the unsubscribe channel is registered and removed with the handle", () => {
    const rig = harness();
    assert.ok(rig.ipc.handlers.has(DESKTOP_IPC_CHANNELS.unsubscribe));
    rig.handle.dispose();
    assert.ok(rig.ipc.removed.includes(DESKTOP_IPC_CHANNELS.unsubscribe));
    assert.equal(rig.ipc.handlers.size, 0);
  });
});
