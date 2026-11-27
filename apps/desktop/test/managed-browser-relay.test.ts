import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import type { ManagedBrowserEvent } from "@omp-studio/studio-protocol";

const ELECTRON_STUB = "data:text/javascript," + encodeURIComponent(`
  import { EventEmitter } from "node:events";
  let nextWebContentsId = 1;
  export const createdWebContents = [];
  export const windowFocusCalls = [];
  export const browserWindows = [];
  class FakeDebugger extends EventEmitter {
    #attached = false;
    commands = [];
    isAttached() { return this.#attached; }
    attach() { this.#attached = true; }
    detach() {
      const was = this.#attached;
      this.#attached = false;
      if (was) this.emit("detach", {}, "target_closed");
    }
    async sendCommand(method, params, sessionId) {
      this.commands.push({ method, params, sessionId });
      return { ok: true, method, params, sessionId };
    }
  }
  class FakeWebContents extends EventEmitter {
    id = nextWebContentsId++;
    #url = "about:blank";
    #title = "";
    #zoom = 1;
    #throttled = false;
    #destroyed = false;
    #devtools = false;
    #focused = false;
    debugger = new FakeDebugger();
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    focus() { this.#focused = true; windowFocusCalls.push(this.id); }
    isFocused() { return this.#focused; }
    isDestroyed() { return this.#destroyed; }
    isDevToolsOpened() { return this.#devtools; }
    openDevTools() { this.#devtools = true; this.emit("devtools-opened"); }
    closeDevTools() { this.#devtools = false; this.emit("devtools-closed"); }
    setZoomFactor(zoom) { this.#zoom = zoom; }
    getZoomFactor() { return this.#zoom; }
    getURL() { return this.#url; }
    getTitle() { return this.#title; }
    getBackgroundThrottling() { return this.#throttled; }
    setBackgroundThrottling(value) { this.#throttled = value; }
    async capturePage() { return { toPNG: () => Buffer.alloc(0) }; }
    async loadURL(url) { this.#url = url; this.#title = url; }
    setWindowOpenHandler() {}
    close() {
      if (this.#destroyed) return;
      this.#destroyed = true;
      this.emit("destroyed");
    }
  }
  export class View {
    #bounds = { x: 0, y: 0, width: 0, height: 0 };
    children = [];
    setBounds(bounds) { this.#bounds = bounds; }
    getBounds() { return this.#bounds; }
    setVisible() {}
    addChildView(child) { this.children.push(child); }
    removeChildView(child) { this.children = this.children.filter(item => item !== child); }
  }
  export class WebContentsView {
    webContents = new FakeWebContents();
    constructor() { createdWebContents.push(this.webContents); }
    setBounds() {}
    setVisible() {}
    setBackgroundColor() {}
  }
  export class BrowserWindow extends EventEmitter {
    contentView = new View();
    webContents = new FakeWebContents();
    #destroyed = false;
    constructor(options) {
      super();
      this.options = options;
      browserWindows.push(this);
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.#destroyed; }
    isVisible() { return false; }
    isMinimized() { return false; }
    destroy() { this.#destroyed = true; this.emit("closed"); }
  }
  export const session = {
    fromPartition() {
      return {
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
        on() {},
        removeListener() {},
        fetch() { return Promise.resolve(new Response(null, { status: 404 })); },
      };
    },
  };
  export const nativeImage = { createFromBuffer() { return { isEmpty: () => true }; } };
  export const Menu = { buildFromTemplate() { return { popup() {} }; } };
  export const Notification = class extends EventEmitter { static isSupported() { return false; } show() {} };
  export const dialog = { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) };
  export const shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder() {} };
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

const electronStub = (await import("electron")) as unknown as {
  createdWebContents: Array<{
    id: number;
    debugger: EventEmitter & {
      commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }>;
      isAttached(): boolean;
    };
  }>;
  windowFocusCalls: number[];
};
const { DesktopManagedBrowser } = await import("../src/managed-browser.js");
const { ManagedBrowserRelay } = await import("../src/managed-browser-relay.js");

interface RelayMessage {
  t: string;
  id?: number;
  [key: string]: unknown;
}

async function startMockRelayServer(context: TestContext, opts: { token?: string; acceptControl?: boolean } = {}) {
  const token = opts.token ?? randomBytes(32).toString("hex");
  const prefix = `/managed/${token}`;
  const messages: RelayMessage[] = [];
  const rejectedOrigins: string[] = [];
  const requestOrigins: Array<string | undefined> = [];
  const rpcWaiters = new Map<number, { resolve(value: RelayMessage): void; reject(err: Error): void }>();
  const messageWaiters = new Set<{ match: (msg: RelayMessage) => boolean; resolve(msg: RelayMessage): void }>();
  let extSocket: ServerWebSocket | undefined;
  let nextRpcId = 1;

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(`${prefix}/`)) {
      res.writeHead(404).end("Not found");
      return;
    }
    const path = url.pathname.slice(prefix.length).replace(/\/+$/, "") || "/";
    if (path === "/json/list" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    res.writeHead(404).end("Not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;
    requestOrigins.push(origin);
    if (!url.pathname.startsWith(`${prefix}/`)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const path = url.pathname.slice(prefix.length).replace(/\/+$/, "") || "/";
    if (path !== "/ext") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // Mirror v19.2.1 tools/browser/relay/server.ts Origin enforcement.
    if (origin && !origin.startsWith("chrome-extension://")) {
      rejectedOrigins.push(origin);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      extSocket = ws;
      ws.on("message", raw => {
        const msg = JSON.parse(String(raw)) as RelayMessage;
        messages.push(msg);
        if (msg.t === "studioControl" && opts.acceptControl !== false) {
          ws.send(JSON.stringify({ t: "studioControlResult", id: msg.id, ok: true }));
        } else if (msg.t === "rpcResult" && typeof msg.id === "number") {
          const waiter = rpcWaiters.get(msg.id);
          if (waiter) {
            rpcWaiters.delete(msg.id);
            waiter.resolve(msg);
          }
        }
        for (const waiter of [...messageWaiters]) {
          if (waiter.match(msg)) {
            messageWaiters.delete(waiter);
            waiter.resolve(msg);
          }
        }
      });
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}${prefix}`;

  context.after(async () => {
    extSocket?.close();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  return {
    endpoint,
    messages,
    rejectedOrigins,
    requestOrigins,
    sendRaw(payload: unknown) {
      assert.ok(extSocket, "extension socket must be connected");
      extSocket.send(JSON.stringify(payload));
    },
    waitFor(match: (msg: RelayMessage) => boolean, timeoutMs = 3000): Promise<RelayMessage> {
      const existing = messages.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          messageWaiters.delete(waiter);
          reject(new Error("Timed out waiting for relay message"));
        }, timeoutMs);
        const waiter = {
          match,
          resolve(msg: RelayMessage) {
            clearTimeout(timer);
            resolve(msg);
          },
        };
        messageWaiters.add(waiter);
      });
    },
    async rpc(op: string, params: Record<string, unknown> = {}): Promise<RelayMessage> {
      assert.ok(extSocket, "extension socket must be connected");
      const id = nextRpcId++;
      const reply = new Promise<RelayMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          rpcWaiters.delete(id);
          reject(new Error(`RPC ${op} timed out`));
        }, 3000);
        rpcWaiters.set(id, {
          resolve(msg) {
            clearTimeout(timer);
            resolve(msg);
          },
          reject,
        });
      });
      extSocket.send(JSON.stringify({ t: "rpc", id, op, ...params }));
      return reply;
    },
  };
}

async function createHarness(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-managed-relay-"));
  const browserDir = join(root, "browser");
  const downloadsDir = join(root, "downloads");
  const mediaDir = join(root, "media");
  await mkdir(join(mediaDir, "managed-browser"), { recursive: true });

  const manager = new DesktopManagedBrowser({
    directory: browserDir,
    downloadsDirectory: downloadsDir,
    windowFor: () => undefined,
  });
  const events: ManagedBrowserEvent[] = [];
  const unsubscribe = manager.subscribe(event => events.push(event));
  const relay = new ManagedBrowserRelay({ manager, directory: () => mediaDir });

  context.after(async () => {
    unsubscribe();
    await relay.dispose();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  return { root, mediaDir, manager, relay, events };
}

test("v19.2.1 hello capabilities, /managed/<token> scoping, Origin check, and createTab({ active: false })", async context => {
  const { mediaDir, manager, events } = await createHarness(context);
  const server = await startMockRelayServer(context);
  const sessionId = "chat-bg-tab";

  // Non-matching or malformed descriptors must be ignored without connecting.
  await writeFile(
    join(mediaDir, "managed-browser", "ignored-bad-path.json"),
    JSON.stringify({
      version: 1,
      sessionId,
      generation: "bad-1",
      endpoint: server.endpoint.replace("/managed/", "/wrong/"),
      pid: process.pid,
    }),
  );
  await writeFile(
    join(mediaDir, "managed-browser", "ignored-bad-pid.json"),
    JSON.stringify({
      version: 1,
      sessionId,
      generation: "bad-2",
      endpoint: server.endpoint,
      pid: 0,
    }),
  );

  const key = createHash("sha256").update(sessionId).digest("hex");
  await writeFile(
    join(mediaDir, "managed-browser", `${key}-gen-1.json`),
    JSON.stringify({
      version: 1,
      sessionId,
      generation: "gen-1",
      endpoint: server.endpoint,
      pid: process.pid,
    }),
  );

  const hello = await server.waitFor(msg => msg.t === "hello");
  assert.equal(hello.discardedTabsProtocol, 1);
  assert.equal(typeof hello.instanceId, "string");
  assert.equal(typeof hello.browserSession, "string");
  assert.match(String(hello.browserVersion), /^Chrome\//);
  assert.deepEqual(hello.attachedTabIds, []);
  // Extension-only v19.2.1 capabilities remain intentionally omitted on Electron embedded host.
  for (const flag of ["ompVersion", "ompBuild", "reloadProtocol", "downloadsProtocol", "overlayProtocol", "panelProtocol"]) {
    assert.equal(flag in hello, false, `hello should omit ${flag}`);
  }
  // WebSocket /ext upgrade did not send a forbidden non-extension Origin header.
  assert.deepEqual(server.rejectedOrigins, []);
  assert.deepEqual(server.requestOrigins, [undefined]);

  // Wait for studioControl handshake completion.
  const deadline = Date.now() + 2000;
  while ((await manager.read(sessionId)).connection !== "connected" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await manager.read(sessionId)).connection, "connected");

  // 1. Create the initial foreground tab (active omitted -> selected).
  const firstReply = await server.rpc("createTab", { url: "https://example.com/one" });
  assert.equal(firstReply.ok, true);
  const firstTab = (firstReply.result as { tab: { tabId: number; studioPageId: string; active: boolean } }).tab;
  assert.equal(firstTab.active, true);
  assert.equal((await manager.read(sessionId)).activePageId, firstTab.studioPageId);

  // 2. Create a background tab with active: false — must NOT steal activePageId or emit transient focus.
  const eventStart = events.length;
  const focusCountBefore = electronStub.windowFocusCalls.length;
  const bgReply = await server.rpc("createTab", { url: "https://example.com/two", active: false });
  assert.equal(bgReply.ok, true);
  const bgTab = (bgReply.result as { tab: { tabId: number; studioPageId: string; active: boolean; url: string } }).tab;
  assert.equal(bgTab.url, "https://example.com/two");
  assert.equal(bgTab.active, false);

  const stateAfterBg = await manager.read(sessionId);
  assert.equal(stateAfterBg.activePageId, firstTab.studioPageId);
  assert.equal(stateAfterBg.pages.length, 2);
  assert.equal(electronStub.windowFocusCalls.length, focusCountBefore);

  // Every emitted state event during background creation kept activePageId on the existing tab.
  const stateEventsDuringBg = events
    .slice(eventStart)
    .filter((event): event is Extract<ManagedBrowserEvent, { kind: "state" }> => event.kind === "state");
  assert.ok(stateEventsDuringBg.length > 0);
  assert.ok(stateEventsDuringBg.every(event => event.state.activePageId === firstTab.studioPageId));

  // Wire event tabCreated for the background tab also reported active: false.
  const bgCreated = await server.waitFor(
    msg => msg.t === "tabCreated" && (msg.tab as { tabId?: number } | undefined)?.tabId === bgTab.tabId,
  );
  assert.equal((bgCreated.tab as { active: boolean }).active, false);
  // First tab was never toggled to active: false by a transient selection flip.
  const firstDeactivated = server.messages.some(
    msg =>
      msg.t === "tabUpdated" &&
      (msg.tab as { tabId?: number; active?: boolean } | undefined)?.tabId === firstTab.tabId &&
      (msg.tab as { active?: boolean }).active === false,
  );
  assert.equal(firstDeactivated, false);

  // 3. Creating a tab with active: true (or omitted) selects it normally.
  const fgReply = await server.rpc("createTab", { url: "https://example.com/three", active: true });
  assert.equal(fgReply.ok, true);
  const fgTab = (fgReply.result as { tab: { tabId: number; studioPageId: string; active: boolean } }).tab;
  assert.equal(fgTab.active, true);
  assert.equal((await manager.read(sessionId)).activePageId, fgTab.studioPageId);
});

test("v19.2.1 RelayRpcRequest ops, RelayToExtMessage notifications, and detached.relayInitiated", async context => {
  const { mediaDir, manager } = await createHarness(context);
  const server = await startMockRelayServer(context);
  const sessionId = "chat-rpc";
  const key = createHash("sha256").update(sessionId).digest("hex");

  await writeFile(
    join(mediaDir, "managed-browser", `${key}-${randomUUID()}.json`),
    JSON.stringify({
      version: 1,
      sessionId,
      generation: "gen-rpc",
      endpoint: server.endpoint,
      pid: process.pid,
    }),
  );

  await server.waitFor(msg => msg.t === "hello");
  const deadline = Date.now() + 2000;
  while ((await manager.read(sessionId)).connection !== "connected" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const created = await server.rpc("createTab", { url: "https://example.com/app" });
  const tab = (created.result as { tab: { tabId: number; studioPageId: string } }).tab;

  // Incoming v19.2.1 extension-directed messages (reload, input, callResult) must be ignored cleanly without closing socket.
  server.sendRaw({ t: "reload" });
  server.sendRaw({ t: "input", tabId: tab.tabId, input: { kind: "press", x: 10, y: 20, button: "left", clickCount: 1 } });
  server.sendRaw({ t: "callResult", id: 77, ok: true, result: [] });

  // attach + send with clearForeignFrames (v19.2.1 field) and standard CDP commands.
  const attached = await server.rpc("attach", { tabId: tab.tabId, clearForeignFrames: true });
  assert.equal(attached.ok, true);
  assert.deepEqual(attached.result, {});

  const bringToFront = await server.rpc("send", {
    tabId: tab.tabId,
    method: "Page.bringToFront",
    clearForeignFrames: true,
  });
  assert.equal(bringToFront.ok, true);
  assert.deepEqual(bringToFront.result, {});

  const evalReply = await server.rpc("send", {
    tabId: tab.tabId,
    method: "Runtime.evaluate",
    params: { expression: "1 + 1" },
    clearForeignFrames: false,
  });
  assert.equal(evalReply.ok, true);
  assert.deepEqual(evalReply.result, {
    ok: true,
    method: "Runtime.evaluate",
    params: { expression: "1 + 1" },
  });

  const childEvalReply = await server.rpc("send", {
    tabId: tab.tabId,
    sessionId: "child-session-1",
    method: "Runtime.evaluate",
    params: { expression: "2 + 2" },
    clearForeignFrames: true,
  });
  assert.equal(childEvalReply.ok, true);
  assert.deepEqual(childEvalReply.result, {
    ok: true,
    method: "Runtime.evaluate",
    params: { expression: "2 + 2" },
    sessionId: "child-session-1",
  });

  // Forwarded debugger events preserve sessionId when present.
  const pageContents = manager.contents(tab.studioPageId) as unknown as { debugger: EventEmitter };
  pageContents.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log" }, "child-session-1");
  const cdpEvent = await server.waitFor(
    msg => msg.t === "cdpEvent" && msg.tabId === tab.tabId && msg.method === "Runtime.consoleAPICalled",
  );
  assert.equal(cdpEvent.sessionId, "child-session-1");
  assert.deepEqual(cdpEvent.params, { type: "log" });

  // v19.2.1 new RPCs: findDownload, overlay, studioDownloads, group, ungroup.
  const foundDownload = await server.rpc("findDownload", { guid: "00000000-0000-0000-0000-000000000000" });
  assert.equal(foundDownload.ok, true);
  assert.equal(foundDownload.result, null);

  for (const action of ["mount", "hide", "show", "unmount"] as const) {
    const overlayReply = await server.rpc("overlay", { tabId: tab.tabId, action });
    assert.equal(overlayReply.ok, true);
    assert.deepEqual(overlayReply.result, {});
  }

  const dlEnable = await server.rpc("studioDownloads", { tabId: tab.tabId, action: "enable" });
  assert.equal(dlEnable.ok, true);
  assert.deepEqual(dlEnable.result, {});

  const dlList = await server.rpc("studioDownloads", { tabId: tab.tabId, action: "list" });
  assert.equal(dlList.ok, true);
  assert.deepEqual(dlList.result, []);

  const dlInvalid = await server.rpc("studioDownloads", { tabId: tab.tabId, action: "bogus" });
  assert.equal(dlInvalid.ok, false);
  assert.match(String(dlInvalid.error), /Unsupported Studio download action/);

  // activateTab updates activePageId cleanly; human control blocks createTab/activateTab/removeTab.
  const second = await server.rpc("createTab", { url: "https://example.com/second", active: false });
  const secondTab = (second.result as { tab: { tabId: number; studioPageId: string; active: boolean } }).tab;
  assert.equal(secondTab.active, false);
  assert.equal((await manager.read(sessionId)).activePageId, tab.studioPageId);
  const activated = await server.rpc("activateTab", { tabId: secondTab.tabId });
  assert.equal(activated.ok, true);
  assert.equal((await manager.read(sessionId)).activePageId, secondTab.studioPageId);

  await manager.execute({ sessionId, action: "take" });
  const blockedCreate = await server.rpc("createTab", { url: "https://example.com/blocked", active: false });
  assert.equal(blockedCreate.ok, false);
  assert.match(String(blockedCreate.error), /human control/);
  await manager.execute({ sessionId, action: "return" });
  await server.rpc("removeTab", { tabId: secondTab.tabId });

  const groupReply = await server.rpc("group", { tabIds: [tab.tabId], title: "omp", color: "cyan" });
  assert.equal(groupReply.ok, true);
  assert.deepEqual(groupReply.result, { grouped: {} });

  const ungroupReply = await server.rpc("ungroup", { tabIds: [tab.tabId] });
  assert.equal(ungroupReply.ok, true);
  assert.deepEqual(ungroupReply.result, {});

  // Relay-initiated detach emits detached with relayInitiated: true before resolving RPC.
  const detachReply = await server.rpc("detach", { tabId: tab.tabId });
  assert.equal(detachReply.ok, true);
  const relayDetachMsg = await server.waitFor(
    msg => msg.t === "detached" && msg.tabId === tab.tabId && msg.reason === "studio-control",
  );
  assert.equal(relayDetachMsg.relayInitiated, true);

  // Re-attach and simulate an unexpected debugger detach while under agent control -> relayInitiated: false.
  server.messages.length = 0;
  assert.equal((await server.rpc("attach", { tabId: tab.tabId })).ok, true);
  const contents = manager.contents(tab.studioPageId) as unknown as { debugger: EventEmitter };
  contents.debugger.emit("detach", {}, "target_closed");
  const unexpectedDetach = await server.waitFor(
    msg => msg.t === "detached" && msg.tabId === tab.tabId && msg.reason === "target_closed",
  );
  assert.equal(unexpectedDetach.relayInitiated, false);

  // removeTab cleans up cleanly.
  const removed = await server.rpc("removeTab", { tabId: tab.tabId });
  assert.equal(removed.ok, true);
  assert.equal((await manager.read(sessionId)).pages.length, 0);
});

test("Desktop adapter connects to the real 19.2.1 upstream relay and drives CDP target lifecycle", async context => {
  const { mediaDir, manager } = await createHarness(context);
  const upstream = fileURLToPath(new URL("../../../../omp-patch/vendor/oh-my-pi/", import.meta.url));
  const token = randomBytes(32).toString("hex");
  const script = `import { startRelayServer } from "./packages/coding-agent/src/tools/browser/relay/server.ts";
    const server = startRelayServer({ port: 0, group: false, studio: { token: ${JSON.stringify(token)}, control: async () => {} } });
    process.stdout.write(JSON.stringify({ port: server.port }) + "\\n");
    process.stdin.resume(); process.stdin.on("end", () => { server.stop(); process.exit(0); });`;
  const child = spawn(process.env.BUN_EXE ?? "bun", ["--eval", script], { cwd: upstream, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", data => { stderr += String(data); });
  context.after(() => { child.stdin.end(); child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Upstream relay did not start: ${stderr}`)), 10000);
    lines.once("line", line => { clearTimeout(timer); resolve((JSON.parse(line) as { port: number }).port); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Upstream relay exited ${code}: ${stderr}`)); });
  });
  const endpoint = `http://127.0.0.1:${port}/managed/${token}`;
  const sessionId = "real-upstream-relay";
  await writeFile(join(mediaDir, "managed-browser", "real-upstream.json"), JSON.stringify({ version: 1, sessionId, generation: randomUUID(), endpoint, pid: child.pid }));
  const deadline = Date.now() + 5000;
  while ((await manager.read(sessionId)).connection !== "connected" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await manager.read(sessionId)).connection, "connected");
  const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string; ompRelayDiscardedTabsProtocol: string };
  assert.equal(version.ompRelayDiscardedTabsProtocol, "1");
  const cdp = new WebSocket(version.webSocketDebuggerUrl);
  context.after(() => cdp.close());
  await new Promise<void>((resolve, reject) => { cdp.addEventListener("open", () => resolve(), { once: true }); cdp.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true }); });
  let id = 0;
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  cdp.addEventListener("message", event => {
    const value = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (value.id === undefined) return;
    const waiter = pending.get(value.id); pending.delete(value.id);
    if (value.error) waiter?.reject(new Error(value.error.message)); else waiter?.resolve(value.result ?? {});
  });
  const send = (method: string, params = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 5000);
    pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    cdp.send(JSON.stringify({ id: requestId, method, params }));
  });
  const first = await send("Target.createTarget", { url: "https://example.test/first" });
  const activePage = (await manager.read(sessionId)).activePageId;
  const second = await send("Target.createTarget", { url: "https://example.test/background", background: true });
  assert.equal((await manager.read(sessionId)).pages.length, 2);
  assert.equal((await manager.read(sessionId)).activePageId, activePage);
  const targets = await send("Target.getTargets");
  assert.equal((targets.targetInfos as Array<unknown>).length, 2);
  await send("Target.closeTarget", { targetId: second.targetId });
  assert.equal((await manager.read(sessionId)).pages.length, 1);
  await send("Target.closeTarget", { targetId: first.targetId });
  assert.equal((await manager.read(sessionId)).pages.length, 0);
});
