import { expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { BrowserObservationOperation, ManagedBrowserApi, ManagedBrowserState, StudioBrowserTab } from "@omp-studio/studio-protocol";
import { PREVIEW_BROWSER_TAB, previewBrowserDescriptor } from "../preview/browserPreview";
import { createNativeBrowserBackend } from "./browserNativeBackend";

const nativeTab = (): StudioBrowserTab => ({ ...PREVIEW_BROWSER_TAB, ...previewBrowserDescriptor("webkit"), sessionId: "chat", ownerSessionId: "native-owner", targetId: "native-webkit-block-9" });
function nativeClient(options: { failWebKit?: boolean } = {}) {
  const receipts: Record<string, { status: "completed"; requestId: string; result: { result: unknown } }> = {};
  const calls: { kind: string; input: unknown }[] = [];
  let tabs = [nativeTab()];
  const client = {
    command: vi.fn(async (kind: string, input: Record<string, unknown>) => {
      calls.push({ kind, input });
      if (kind === "browser.native.open" && input.app === "webkit" && options.failWebKit) throw new Error("Explicit WebKit install failed");
      let result: unknown;
      if (kind === "browser.tabs.get") result = { tabs };
      else if (kind === "browser.native.open") {
        // Models the CLI distinction this regression protects: auto skips its configured relay/engine priority.
        const tab = { ...nativeTab(), ...(input.app === "auto" ? previewBrowserDescriptor("chromium") : {}), id: "33333333-3333-4333-8333-333333333333", url: String(input.url) };
        tabs = [...tabs, tab]; result = { tab };
      } else if (kind === "browser.native.close") { tabs = tabs.filter(tab => tab.id !== input.tabId); result = { closed: true }; }
      else if (kind === "browser.managed.prepare") result = { sessionId: "chat", descriptorId: "private-descriptor.json" };
      else throw new Error(`Unexpected native command: ${kind}`);
      const requestId = `request-${calls.length}`;
      receipts[requestId] = { status: "completed", requestId, result: { result } };
      return { requestId };
    }),
    getState: () => ({ commands: receipts }),
    subscribe: () => () => {},
  } as unknown as StudioClient;
  return { client, calls };
}
function embeddedApi() {
  const state: ManagedBrowserState = { sessionId: "chat", pages: [], activePageId: null, spaces: [{ id: "shared", name: "Shared" }], control: "human", connection: "connected", settings: { maxTabs: 16, downloadDirectory: "", askDownloadLocation: false }, downloads: [], permissions: [] };
  const execute = vi.fn(async () => state);
  const api: ManagedBrowserApi = { available: async () => true, read: async () => state, execute, present: vi.fn(async () => {}), subscribe: () => () => {} };
  return { api, execute };
}

it("inherits CLI priority without transmitting app:auto or choosing Electron's backend", async () => {
  const native = nativeClient(), embedded = embeddedApi(), backend = createNativeBrowserBackend(native.client, embedded.api);
  await backend.read("chat");
  const state = await backend.execute({ sessionId: "chat", action: "create", url: "localhost:5173/account" });
  const open = native.calls.find(call => call.kind === "browser.native.open")!;
  expect(open.input).not.toHaveProperty("app");
  expect(open.input).toMatchObject({ url: "http://localhost:5173/account" });
  expect(state.pages.find(page => page.id === state.activePageId)?.descriptor).toMatchObject({ engine: "webkit", transport: "frames", targetId: "native-webkit-block-9", ownerSessionId: "native-owner" });
  expect(embedded.execute).not.toHaveBeenCalled();
});

it("keeps explicit WebKit failure on that engine rather than reopening an embedded or Chromium page", async () => {
  const native = nativeClient({ failWebKit: true }), embedded = embeddedApi(), backend = createNativeBrowserBackend(native.client, embedded.api);
  await expect(backend.execute({ sessionId: "chat", action: "create", url: "https://example.test", app: "webkit", argv: ["--test"], target: "target-9", insecure: true })).rejects.toThrow("Explicit WebKit install failed");
  expect(native.calls).toHaveLength(1);
  expect(native.calls[0]?.input).toMatchObject({ app: "webkit", argv: ["--test"], target: "target-9", insecure: true });
  expect(embedded.execute).not.toHaveBeenCalled();
});

it("initializes the dedicated relay only for an explicit embedded open", async () => {
  const native = nativeClient(), embedded = embeddedApi(), backend = createNativeBrowserBackend(native.client, embedded.api);
  await backend.execute({ sessionId: "chat", action: "create", url: "https://example.test", app: "embedded" });
  expect(native.calls.map(call => call.kind)).toEqual(["browser.managed.prepare"]);
  expect(embedded.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "create", app: "embedded" }));
});

it("returns the window's private lease before native close and never closes its URL through Electron", async () => {
  const native = nativeClient(), embedded = embeddedApi(), backend = createNativeBrowserBackend(native.client, embedded.api);
  const state = await backend.read("chat"), page = state.pages[0]!;
  let finish!: () => void;
  const returned = new Promise<void>(resolve => { finish = resolve; });
  const release = vi.fn(() => returned);
  const off = backend.bindPage!("chat", page.id, { execute: async () => {}, release });
  const closing = backend.execute({ sessionId: "chat", action: "close-handoff", pageId: page.id });
  await Promise.resolve();
  expect(native.calls.some(call => call.kind === "browser.native.close")).toBe(false);
  finish();
  const closed = await closing;
  const operation = native.calls.find(call => call.kind === "browser.native.close")!.input as BrowserObservationOperation;
  expect(operation).toMatchObject({ tabId: page.id, generation: page.descriptor!.generation });
  expect(closed.pages).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
  expect(embedded.execute).not.toHaveBeenCalled();
  off();
});
