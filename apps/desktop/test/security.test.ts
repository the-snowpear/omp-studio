/**
 * P1 Desktop Main-side security tests (FRONTEND_INTEGRATION.md §9.1).
 *
 * Two surfaces are exercised headlessly (no GUI, no display):
 *
 * 1. `registerDesktopIpc` (apps/desktop/src/ipc.ts): the fixed channel
 *    surface — handlers exist for exactly the DESKTOP_IPC_CHANNELS set and
 *    nothing else; untrusted/destroyed senders are rejected before the
 *    facade; strict inbound validation rejects identity-smuggling and
 *    malformed envelopes; outbound responses/events are asserted; window
 *    subscriptions tear down on close, on WebContents destroy, on
 *    navigation and on dispose.
 *
 * 2. `security.ts` helpers (Electron-free): secure webPreferences on every
 *    created window (caller webPreferences never honored), CSP without
 *    `unsafe-eval`, navigation/new-window policy that denies untrusted
 *    URLs, and the secure-window factory.
 *
 * `registerDesktopIpc` imports `electron` at module load; the data-URL
 * loader registered below stubs that module with a recording fake, so the
 * test runs under plain `node --test` with no Electron binary. The
 * `ipcMain` instance is also injectable through `DesktopIpcOptions`, and
 * every test passes its own fake.
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
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

// Static imports above resolved before the loader hook was registered, so the
// Electron-coupled module must be loaded dynamically after registration.
const { registerDesktopIpc } = await import("../src/ipc.js");

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
} from "@omp-studio/client-contract";
import { DESKTOP_IPC_CHANNELS } from "@omp-studio/transport-desktop";

import type { DesktopIpcHandle, DesktopIpcOptions, DesktopSender } from "../src/ipc.js";
import {
  RENDERER_CSP,
  createSecureWindow,
  installCspHeaders,
  installNavigationGuards,
  isTrustedRendererUrl,
  rendererOriginFor,
  rendererCspFor,
  rendererDevServerUrl,
  resolveRendererEntry,
  resolveRendererEntryFrom,
  secureWebPreferences,
  type CreateSecureWindowDeps,
  type NavigationGuardedWindow,
  type WindowLike,
} from "../src/security.js";

// ---- Fakes ---------------------------------------------------------------

interface FakeSender {
  readonly id: number;
  destroyed: boolean;
  readonly sent: Array<{ channel: string; payload: unknown }>;
  readonly onceListeners: Map<string, Set<() => void>>;
  isDestroyed(): boolean;
  getURL(): string;
  once(event: string, listener: () => void): void;
  send(channel: string, payload: unknown): void;
  fireOnce(event: string): void;
}

function makeSender(id: number): FakeSender {
  const onceListeners = new Map<string, Set<() => void>>();
  return {
    id,
    destroyed: false,
    sent: [],
    onceListeners,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return "https://studio.invalid/index.html";
    },
    once(event: string, listener: () => void) {
      let set = onceListeners.get(event);
      if (set === undefined) {
        set = new Set();
        onceListeners.set(event, set);
      }
      set.add(listener);
    },
    send(channel: string, payload: unknown) {
      this.sent.push({ channel, payload });
    },
    fireOnce(event: string) {
      for (const listener of [...(onceListeners.get(event) ?? [])]) {
        listener();
      }
      onceListeners.delete(event);
    },
  };
}

interface FakeIpcMain {
  readonly handlers: Map<string, (event: { sender: FakeSender }, ...args: unknown[]) => Promise<unknown> | unknown>;
  readonly removed: string[];
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

function makeIpcMain(): FakeIpcMain {
  return {
    handlers: new Map(),
    removed: [],
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      this.handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      this.removed.push(channel);
      this.handlers.delete(channel);
    },
  };
}

interface FakeFacade extends ClientTransport {
  readonly calls: string[];
  subscribeListeners: Array<{ scope: SubscriptionScope; listener: (event: ClientEvent) => void }>;
  unsubscribed: number;
  bootstrapResult: ClientBootstrap;
  queryResult: ClientQueryResponse;
  commandResult: ClientCommandAccepted;
  commandError: unknown;
}

function makeFacade(): FakeFacade {
  return {
    calls: [],
    subscribeListeners: [],
    unsubscribed: 0,
    bootstrapResult: { ok: true } as unknown as ClientBootstrap,
    queryResult: { ok: true, queryName: "home.get", result: { ok: true } } as unknown as ClientQueryResponse,
    commandResult: {
      commandName: "session.drop",
      requestId: "req-1",
      status: "accepted",
      acceptedAt: "2026-08-12T00:00:00.000Z",
    } as unknown as ClientCommandAccepted,
    commandError: undefined,
    async bootstrap() {
      this.calls.push("bootstrap");
      return this.bootstrapResult;
    },
    async query<TName extends QueryName>(request: ClientQueryRequest<TName>) {
      this.calls.push(`query:${request.queryName}`);
      return this.queryResult as ClientQueryResponse<TName>;
    },
    async command<TName extends CommandName>(request: ClientCommandRequest<TName>) {
      this.calls.push(`command:${request.commandName}`);
      if (this.commandError !== undefined) throw this.commandError;
      return this.commandResult as ClientCommandAccepted<TName>;
    },
    subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void) {
      this.calls.push(`subscribe:${scope.scope}`);
      this.subscribeListeners.push({ scope, listener });
      return () => {
        this.unsubscribed += 1;
      };
    },
    async close() {
      this.calls.push("close");
    },
  };
}

interface Registered {
  ipc: FakeIpcMain;
  facade: FakeFacade;
  handle: DesktopIpcHandle;
  invoke(channel: string, sender: FakeSender, ...args: unknown[]): Promise<unknown>;
}

function registerIpc(trusted: (sender: DesktopSender) => boolean = () => true): Registered {
  const ipc = makeIpcMain();
  const facade = makeFacade();
  const handle = registerDesktopIpc({
    facade,
    isTrustedSender: trusted,
    ipcMain: ipc as unknown as NonNullable<DesktopIpcOptions["ipcMain"]>,
  });
  return {
    ipc,
    facade,
    handle,
    async invoke(channel, sender, ...args) {
      const handler = ipc.handlers.get(channel);
      assert.ok(handler, `no handler for ${channel}`);
      return handler({ sender }, ...args);
    },
  };
}

const EVENT_BASE = {
  authorityEpoch: 1,
  stateVersion: 2,
  cursor: "3",
  occurredAt: "2026-08-12T00:00:00.000Z",
};

function validEvent(): ClientEvent {
  return { kind: "state.changed", ...EVENT_BASE } as ClientEvent;
}

function validConversationEvent(): ClientEvent {
  return {
    kind: "conversation.changed",
    ...EVENT_BASE,
    runtimeEpoch: 1,
    sessionId: "session-1",
    streamSeq: 1,
    eventSeq: 1,
    update: {
      kind: "conversation.message.started",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-1",
      role: "assistant",
      createdAt: "2026-08-29T00:00:00.000Z",
    },
  } as ClientEvent;
}

// ---- Main IPC surface ----------------------------------------------------

describe("registerDesktopIpc: fixed channel surface", () => {
  const INBOUND = [
    DESKTOP_IPC_CHANNELS.bootstrap,
    DESKTOP_IPC_CHANNELS.query,
    DESKTOP_IPC_CHANNELS.command,
    DESKTOP_IPC_CHANNELS.subscribe,
    DESKTOP_IPC_CHANNELS.close,
  ];

  test("registers handlers for exactly the five inbound channels and never the event channel", () => {
    const { ipc, handle } = registerIpc();
    assert.deepEqual([...ipc.handlers.keys()].sort(), [...INBOUND].sort());
    assert.equal(ipc.handlers.has(DESKTOP_IPC_CHANNELS.event), false, "event is outbound only");
    assert.equal(ipc.handlers.size, INBOUND.length);
    handle.dispose();
  });

  test("dispose removes exactly the five inbound handlers", () => {
    const { ipc, handle } = registerIpc();
    handle.dispose();
    assert.deepEqual([...ipc.removed].sort(), [...INBOUND].sort());
    assert.equal(ipc.handlers.size, 0);
  });
});

describe("registerDesktopIpc: sender trust", () => {
  test("rejects an untrusted sender on every channel before the facade is touched", async () => {
    const { invoke, facade, handle } = registerIpc(() => false);
    const sender = makeSender(1);
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      if (channel === DESKTOP_IPC_CHANNELS.event) continue; // Main -> Renderer only
      await assert.rejects(() => invoke(channel, sender), /untrusted sender/);
    }
    assert.deepEqual(facade.calls, []);
    handle.dispose();
  });

  test("rejects a destroyed sender even when the allow-list trusts it", async () => {
    const sender = makeSender(1);
    sender.destroyed = true;
    const { invoke, facade, handle } = registerIpc((candidate) => candidate === sender);
    await assert.rejects(
      () => invoke(DESKTOP_IPC_CHANNELS.query, sender, { queryName: "home.get", input: {} }),
      /untrusted sender/,
    );
    assert.deepEqual(facade.calls, []);
    handle.dispose();
  });
});

describe("registerDesktopIpc: inbound validation before dispatch", () => {
  test("identity-smuggling envelope fields never reach the facade", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await assert.rejects(() =>
      invoke(DESKTOP_IPC_CHANNELS.query, sender, {
        queryName: "home.get",
        input: {},
        windowId: sender.id,
      }),
    );
    await assert.rejects(() =>
      invoke(DESKTOP_IPC_CHANNELS.command, sender, {
        commandName: "session.drop",
        input: { threadId: "t" },
        idempotencyKey: "k",
        requestId: "r",
        authority: "A",
      }),
    );
    await assert.rejects(() =>
      invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all", windowId: 1 }),
    );
    assert.deepEqual(facade.calls, []);
    handle.dispose();
  });

  test("prototype pollution payloads fail closed at the boundary", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    const polluted = JSON.parse('{"queryName":"home.get","input":{},"__proto__":{"x":1}}');
    await assert.rejects(() => invoke(DESKTOP_IPC_CHANNELS.query, sender, polluted));
    assert.deepEqual(facade.calls, []);
    assert.equal(({} as Record<string, unknown>).x, undefined);
    handle.dispose();
  });

  test("malformed query, command and scope payloads are rejected before the facade", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await assert.rejects(() => invoke(DESKTOP_IPC_CHANNELS.query, sender, { queryName: "nope.get", input: {} }));
    await assert.rejects(() =>
      invoke(DESKTOP_IPC_CHANNELS.command, sender, {
        commandName: "session.drop",
        input: { threadId: "t" },
        idempotencyKey: "k",
      }),
    );
    await assert.rejects(() => invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "allx" }));
    assert.deepEqual(facade.calls, []);
    handle.dispose();
  });
});

describe("registerDesktopIpc: valid named-method routes", () => {
  test("a valid query reaches the facade and the asserted response is returned", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    const result = await invoke(DESKTOP_IPC_CHANNELS.query, sender, {
      queryName: "home.get",
      input: {},
    });
    assert.deepEqual(facade.calls, ["query:home.get"]);
    assert.equal((result as { ok: boolean }).ok, true);
    handle.dispose();
  });

  test("a valid command reaches the facade and the asserted acceptance is returned", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    const result = await invoke(DESKTOP_IPC_CHANNELS.command, sender, {
      commandName: "session.drop",
      input: { threadId: "t-1" },
      idempotencyKey: "idem-1",
      requestId: "req-1",
    });
    assert.deepEqual(facade.calls, ["command:session.drop"]);
    assert.equal((result as { status: string }).status, "accepted");
    handle.dispose();
  });

  test("plain ClientError from command is rethrown as Error with the Host message", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    facade.commandError = { code: "UNAVAILABLE", message: "session.resume requires a Runtime snapshot" };
    await assert.rejects(
      () =>
        invoke(DESKTOP_IPC_CHANNELS.command, sender, {
          commandName: "session.resume",
          input: { threadId: "t-1" },
          idempotencyKey: "idem-1",
          requestId: "req-1",
        }),
      (error: unknown) =>
        error instanceof Error && error.message === "session.resume requires a Runtime snapshot" && error.name === "UNAVAILABLE",
    );
    handle.dispose();
  });

  test("bootstrap returns only plain-object responses", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    facade.bootstrapResult = { ok: true } as unknown as ClientBootstrap;
    const result = await invoke(DESKTOP_IPC_CHANNELS.bootstrap, sender);
    assert.equal((result as { ok: boolean }).ok, true);
    facade.bootstrapResult = "leaked-secret" as unknown as ClientBootstrap;
    await assert.rejects(() => invoke(DESKTOP_IPC_CHANNELS.bootstrap, sender), /invalid bootstrap response/);
    handle.dispose();
  });

  test("outbound assertions reject malformed facade responses", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    facade.queryResult = { ok: true, queryName: "home.get" } as unknown as ClientQueryResponse;
    await assert.rejects(() =>
      invoke(DESKTOP_IPC_CHANNELS.query, sender, { queryName: "home.get", input: {} }),
    );
    facade.commandResult = {
      commandName: "session.drop",
      requestId: "req-1",
      status: "rejected",
      acceptedAt: "2026-08-12T00:00:00.000Z",
    } as unknown as ClientCommandAccepted;
    await assert.rejects(() =>
      invoke(DESKTOP_IPC_CHANNELS.command, sender, {
        commandName: "session.drop",
        input: { threadId: "t-1" },
        idempotencyKey: "idem-1",
        requestId: "req-1",
      }),
    );
    handle.dispose();
  });
});

describe("registerDesktopIpc: window-bound event forwarding and teardown", () => {
  test("subscription events are asserted and forwarded to the sender on the event channel", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    assert.deepEqual(facade.calls, ["subscribe:all"]);
    const registered = facade.subscribeListeners[0];
    assert.ok(registered);
    registered.listener(validEvent());
    assert.deepEqual(sender.sent, [{ channel: DESKTOP_IPC_CHANNELS.event, payload: validEvent() }]);
    handle.dispose();
  });

  test("conversation.changed preserves streamSeq across Desktop IPC", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    const registered = facade.subscribeListeners[0];
    assert.ok(registered);
    const event = validConversationEvent();
    assert.doesNotThrow(() => registered.listener(event));
    assert.deepEqual(sender.sent, [{ channel: DESKTOP_IPC_CHANNELS.event, payload: event }]);
    handle.dispose();
  });

  test("malformed events fail closed and are never forwarded", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    const registered = facade.subscribeListeners[0];
    assert.ok(registered);
    assert.throws(() =>
      registered.listener({ kind: "auth.tampered", ...EVENT_BASE } as unknown as ClientEvent),
    );
    assert.deepEqual(sender.sent, []);
    handle.dispose();
  });

  test("events are not forwarded to a destroyed sender", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    const registered = facade.subscribeListeners[0];
    assert.ok(registered);
    sender.destroyed = true;
    registered.listener(validEvent());
    assert.deepEqual(sender.sent, []);
    handle.dispose();
  });

  test("the close channel tears down the window subscription without closing the Host facade", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    await invoke(DESKTOP_IPC_CHANNELS.close, sender);
    assert.deepEqual(facade.calls, ["subscribe:all"]);
    assert.equal(facade.unsubscribed, 1);
    handle.dispose();
  });

  test("WebContents destroy tears down the window subscription", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    assert.equal(facade.unsubscribed, 0);
    sender.fireOnce("destroyed");
    assert.equal(facade.unsubscribed, 1);
    handle.dispose();
  });

  test("main-frame navigation (reload) tears down the window subscription", async () => {
    const { invoke, facade, handle } = registerIpc();
    const sender = makeSender(1);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, sender, { scope: "all" });
    sender.fireOnce("did-navigate");
    assert.equal(facade.unsubscribed, 1);
    handle.dispose();
  });

  test("dispose tears down every window subscription", async () => {
    const { invoke, facade, handle } = registerIpc();
    const senderA = makeSender(1);
    const senderB = makeSender(2);
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, senderA, { scope: "all" });
    await invoke(DESKTOP_IPC_CHANNELS.subscribe, senderB, { scope: "all" });
    handle.dispose();
    assert.equal(facade.unsubscribed, 2);
  });
});

// ---- Window security (security.ts) ---------------------------------------

describe("secureWebPreferences: every secure flag fixed", () => {
  test("sets the full secure baseline and preserves the absolute preload path", () => {
    const prefs = secureWebPreferences("C:\\app\\preload.cjs");
    assert.deepEqual(prefs, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: "C:\\app\\preload.cjs",
    });
  });
});

describe("RENDERER_CSP: no unsafe-eval", () => {
  test("the policy bans eval, inline scripts and object/plugin sources", () => {
    assert.ok(!RENDERER_CSP.includes("unsafe-eval"));
    assert.ok(!RENDERER_CSP.includes("unsafe-inline") || RENDERER_CSP.includes("script-src 'self'"));
    assert.match(RENDERER_CSP, /script-src 'self'/);
    assert.match(RENDERER_CSP, /object-src 'none'/);
    assert.match(RENDERER_CSP, /default-src 'self'/);
  });

  test("installCspHeaders injects the policy on every http(s) response", () => {
    let captured: { responseHeaders: Record<string, string[]> } | undefined;
    const session = {
      webRequest: {
        onHeadersReceived(
          listener: (
            details: { responseHeaders?: Record<string, string[]> },
            callback: (response: { responseHeaders: Record<string, string[]> }) => void,
          ) => void,
        ) {
          listener({ responseHeaders: { "X-Frame-Options": ["DENY"] } }, (response) => {
            captured = response;
          });
        },
      },
    };
    installCspHeaders(session, RENDERER_CSP);
    assert.ok(captured);
    assert.deepEqual(captured?.responseHeaders["Content-Security-Policy"], [RENDERER_CSP]);
    assert.deepEqual(captured?.responseHeaders["X-Frame-Options"], ["DENY"], "existing headers kept");
  });
});

test("rendererCspFor keeps packaged CSP strict and permits Vite refresh only in dev", () => {
  const packaged = rendererCspFor({ kind: "file", path: "C:\\app\\index.html" });
  assert.match(packaged, /script-src 'self'(?:;|\s)/u);
  assert.match(packaged, /connect-src 'self';/u);
  assert.equal(packaged.includes("localhost"), false);
  assert.equal(packaged.includes("127.0.0.1"), false);
  const dev = rendererCspFor({ kind: "url", url: "http://127.0.0.1:5173" });
  assert.match(dev, /script-src 'self' 'unsafe-inline'/u);
  assert.match(dev, /connect-src .*127\.0\.0\.1:5173/u);
  assert.ok(!dev.includes("unsafe-eval"));
});

test("rendererDevServerUrl ignores the developer Vite override when packaged", () => {
  assert.equal(rendererDevServerUrl(true, "http://127.0.0.1:5173"), undefined);
  assert.equal(rendererDevServerUrl(false, "http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(rendererDevServerUrl(false, ""), undefined);
});

describe("navigation and new-window policy", () => {
  test("isTrustedRendererUrl allows only the selected packaged renderer document", () => {
    assert.equal(isTrustedRendererUrl("file:///C:/app/index.html", "file:///C:/app/index.html"), true);
    assert.equal(isTrustedRendererUrl("file:///C:/app/other.html", "file:///C:/app/index.html"), false);
    assert.equal(isTrustedRendererUrl("file:///C:/app/index.html#settings", "file:///C:/app/index.html"), true);
    assert.equal(isTrustedRendererUrl("file:///C:/app/../evil/index.html", "file:///C:/app/index.html"), false);
    assert.equal(isTrustedRendererUrl("file://attacker/C:/app/index.html", "file:///C:/app/index.html"), false);
    assert.equal(isTrustedRendererUrl("data:text/html,untrusted", "null"), false);
    assert.equal(isTrustedRendererUrl("https://evil.example/phish", "file:///C:/app/index.html"), false);
    assert.equal(isTrustedRendererUrl("javascript:alert(1)", "file:///C:/app/index.html"), false);
    assert.equal(isTrustedRendererUrl("", "file:///C:/app/index.html"), false);
    assert.equal(isTrustedRendererUrl("not a url", "file:///C:/app/index.html"), false);
  });

  test("isTrustedRendererUrl requires an exact origin match for the dev server", () => {
    const allowed = "http://localhost:5173";
    assert.equal(isTrustedRendererUrl("http://localhost:5173/", allowed), true);
    assert.equal(isTrustedRendererUrl("http://localhost:5173/foo?x=1", allowed), true);
    assert.equal(isTrustedRendererUrl("https://localhost:5173/", allowed), false, "scheme must match");
    assert.equal(isTrustedRendererUrl("http://localhost:9999/", allowed), false, "port must match");
    assert.equal(isTrustedRendererUrl("http://evil.example/", allowed), false);
    assert.equal(isTrustedRendererUrl("", allowed), false);
    assert.equal(isTrustedRendererUrl("data:text/html,<script>1</script>", allowed), false);
  });

  test("installNavigationGuards prevents untrusted navigation and denies every new window", () => {
    const events = new Map<string, Set<(...args: unknown[]) => unknown>>();
    const fakeWindow: NavigationGuardedWindow = {
      on(event, listener) {
        let set = events.get(event);
        if (set === undefined) {
          set = new Set();
          events.set(event, set);
        }
        set.add(listener as (...args: unknown[]) => unknown);
        return undefined;
      },
    };
    installNavigationGuards(fakeWindow, "file:///C:/app/index.html");

    const willNavigate = events.get("will-navigate");
    const openHandler = events.get("setWindowOpenHandler");
    assert.ok(willNavigate);
    assert.ok(openHandler);

    let prevented = false;
    const untrusted = { preventDefault: () => { prevented = true; } };
    for (const listener of [...(willNavigate ?? [])]) {
      listener(untrusted, "https://evil.example/");
    }
    assert.equal(prevented, true, "untrusted navigation must be prevented");

    let allowed = true;
    const trusted = { preventDefault: () => { allowed = false; } };
    for (const listener of [...(willNavigate ?? [])]) {
      listener(trusted, "file:///C:/app/index.html");
    }
    assert.equal(allowed, true, "trusted in-origin navigation stays allowed");

    for (const listener of [...(openHandler ?? [])]) {
      assert.deepEqual(listener({ url: "https://evil.example/" }), { action: "deny" });
      assert.deepEqual(listener({ url: "file:///C:/app/index.html" }), { action: "deny" });
    }
  });
});

describe("createSecureWindow: caller webPreferences are never honored", () => {
  class FakeBrowserWindow implements WindowLike {
    options: Record<string, unknown>;
    shown = false;
    loaded = "";
    readonly listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
    readonly webContents = {
      on: (event: "did-finish-load" | "did-fail-load", listener: () => void): unknown => {
        this.on(`webContents:${event}`, listener);
        return this;
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
    async loadFile(path: string): Promise<void> {
      this.loaded = `file:${path}`;
    }
    async loadURL(url: string): Promise<void> {
      this.loaded = `url:${url}`;
    }
    once(event: string, listener: () => void): unknown {
      this.on(event, listener);
      return this;
    }
    on(event: string, listener: (...args: unknown[]) => unknown): unknown {
      let set = this.listeners.get(event);
      if (set === undefined) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener);
      return this;
    }
    show(): void {
      this.shown = true;
    }
    fire(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }
    fireRenderer(event: "did-finish-load" | "did-fail-load"): void {
      this.fire(`webContents:${event}`);
    }
  }

  test("secure webPreferences overwrite any caller-provided ones", () => {
    const window = createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as new (
        options: { width: number; webPreferences: { nodeIntegration: boolean; contextIsolation: boolean } },
      ) => WindowLike & NavigationGuardedWindow,
      windowOptions: {
        width: 800,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      },
      preloadPath: "C:\\app\\preload.cjs",
      target: { kind: "file", path: "C:\\app\\index.html" },
      allowedOrigin: "file:///C:/app/index.html",
    }) as unknown as FakeBrowserWindow;
    const received = window.options.webPreferences as Record<string, unknown>;
    assert.equal(received.contextIsolation, true);
    assert.equal(received.nodeIntegration, false);
    assert.equal(received.sandbox, true);
    assert.equal(received.webSecurity, true);
    assert.equal(received.allowRunningInsecureContent, false);
    assert.equal(received.webviewTag, false);
    assert.equal(received.preload, "C:\\app\\preload.cjs");
    assert.equal(window.options.width, 800, "non-security options pass through");
    window.fire("ready-to-show");
    assert.equal(window.shown, true);
  });

  test("shows the window when WebContents finishes or fails to load", () => {
    const finishWindow = createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as new (options: object) => WindowLike & NavigationGuardedWindow,
      windowOptions: {},
      preloadPath: "C:\\app\\preload.cjs",
      target: { kind: "file", path: "C:\\app\\renderer\\index.html" },
      allowedOrigin: "file:///C:/app/index.html",
      deferLoad: true,
    }) as unknown as FakeBrowserWindow;
    finishWindow.fireRenderer("did-finish-load");
    assert.equal(finishWindow.shown, true);

    const failedWindow = createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as new (options: object) => WindowLike & NavigationGuardedWindow,
      windowOptions: {},
      preloadPath: "C:\\app\\preload.cjs",
      target: { kind: "file", path: "C:\\app\\renderer\\index.html" },
      allowedOrigin: "file:///C:/app/index.html",
      deferLoad: true,
    }) as unknown as FakeBrowserWindow;
    failedWindow.fireRenderer("did-fail-load");
    assert.equal(failedWindow.shown, true);
  });

  test("loads the renderer target and installs navigation guards", () => {
    const window = createSecureWindow({
      BrowserWindow: FakeBrowserWindow as unknown as new (options: object) => WindowLike & NavigationGuardedWindow,
      windowOptions: {},
      preloadPath: "C:\\app\\preload.cjs",
      target: { kind: "file", path: "C:\\app\\renderer\\index.html" },
      allowedOrigin: "file:///C:/app/index.html",
    }) as unknown as FakeBrowserWindow;
    assert.equal(window.loaded, "file:C:\\app\\renderer\\index.html");
    assert.ok(window.listeners.has("will-navigate"));
    assert.ok(window.listeners.has("setWindowOpenHandler"));
    let prevented = false;
    window.fire("will-navigate", { preventDefault: () => { prevented = true; } }, "https://evil.example/");
    assert.equal(prevented, true);
  });
});

describe("renderer entry resolution", () => {
  test("resolveRendererEntry prefers the explicit dev server URL", () => {
    assert.deepEqual(resolveRendererEntry("C:\\app\\dist", "http://localhost:5173"), {
      kind: "url",
      url: "http://localhost:5173",
    });
  });

  test("resolveRendererEntry falls back to the workspace renderer bundle", () => {
    const target = resolveRendererEntry("C:\\app\\desktop\\dist", undefined);
    assert.equal(target.kind, "file");
    assert.ok((target as { path: string }).path.endsWith("renderer\\dist\\index.html"));
    assert.equal(rendererOriginFor(target), pathToFileURL((target as { path: string }).path).href);
  });

  test("resolveRendererEntry maps the packaged asar onto extraResources renderer", () => {
    const target = resolveRendererEntry("C:\\Program Files\\OMP Studio\\resources\\app.asar", undefined);
    assert.equal(target.kind, "file");
    assert.equal(
      (target as { path: string }).path,
      "C:\\Program Files\\OMP Studio\\resources\\renderer\\dist\\index.html",
    );
  });

  test("resolveRendererEntryFrom maps payload directory to file target with file:// origin", () => {
    const payloadDist = "C:\\Users\\alice\\AppData\\Local\\omp-studio\\payload\\versions\\0.1.4\\renderer";
    const target = resolveRendererEntryFrom(payloadDist, undefined);
    assert.equal(target.kind, "file");
    assert.equal(target.path, "C:\\Users\\alice\\AppData\\Local\\omp-studio\\payload\\versions\\0.1.4\\renderer\\index.html");
    const origin = rendererOriginFor(target);
    assert.equal(origin, pathToFileURL(target.path).href);
    const fileUrl = new URL(`file:///${target.path.replace(/\\/g, "/")}`).toString();
    assert.equal(isTrustedRendererUrl(fileUrl, origin), true);
  });

  test("rendererOriginFor derives the exact dev origin and fails closed on junk", () => {
    assert.equal(rendererOriginFor({ kind: "url", url: "http://localhost:5173/" }), "http://localhost:5173");
    assert.equal(rendererOriginFor({ kind: "url", url: "not a url" }), "null");
  });
});
