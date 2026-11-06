import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedBrowserApi, ManagedBrowserCommand, ManagedBrowserEvent, ManagedBrowserPage, ManagedBrowserState } from "@omp-studio/studio-protocol";
import { DockProvider } from "../dock/DockContext";
import { DockGroupRegion } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { I18nProvider } from "../i18n";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { BrowserDockInstances } from "./BrowserDockInstances";
import { routeBrowserLink } from "./browserLinks";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const page = (id: string, patch: Partial<ManagedBrowserPage> = {}): ManagedBrowserPage => ({ id, sessionId: "chat", spaceId: "shared", title: id, url: `https://example.test/${id}`, status: "ready", canGoBack: false, canGoForward: false, zoom: 1, devtools: false, ...patch });

/** A desktop browser double: holds state, answers commands, emits state events. */
function fakeBrowser(initial: ManagedBrowserState) {
  let state = initial;
  const listeners = new Set<(event: ManagedBrowserEvent) => void>();
  const commands: ManagedBrowserCommand[] = [];
  let release: (() => void) | undefined;
  const emit = () => listeners.forEach(listener => listener({ kind: "state", state }));
  const api: ManagedBrowserApi = {
    available: async () => true,
    read: async () => state,
    present: async () => undefined,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    execute: async command => {
      commands.push(command);
      if (command.action === "close-handoff") {
        await new Promise<void>(resolve => { release = resolve; });
        if (command.pageId === "stuck") throw new Error("The Agent did not hand over control in time.");
        state = { ...state, pages: state.pages.filter(item => item.id !== command.pageId) };
        emit();
      }
      if (command.action === "create") { state = { ...state, pages: [...state.pages, page("opened", { url: command.url, opener: { source: "human" } })], activePageId: "opened" }; emit(); }
      return state;
    },
  };
  return { api, commands, finish: () => act(() => release?.()), set: (next: ManagedBrowserState) => { state = next; act(emit); } };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function mount(browser: ReturnType<typeof fakeBrowser>) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  vi.stubGlobal("ompStudioChrome", { managedBrowser: browser.api });
  const store = new DockStore(null);
  store.switchScope({ target: "local", project: "project", session: "chat" }, false);
  store.dispatch({ type: "region", region: "right", visible: true });
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><DockProvider definitions={WORKBENCH_PANELS} store={store}>
    <DockGroupRegion region="right" visible />
    <BrowserDockInstances sessionId="chat" available={false} capabilities={undefined} remote={false} onReferences={() => {}} />
  </DockProvider></PreviewModeProvider></I18nProvider>);
  return store;
}

it("shows each page as a dock tab and closes it through the Agent handoff", async () => {
  const browser = fakeBrowser({ sessionId: "chat", pages: [page("docs", { title: "Docs", favicon: ICON }), page("stuck", { title: "Stuck" })], activePageId: "docs", spaces: [{ id: "shared", name: "Shared" }], control: "agent", connection: "connected", settings: { maxTabs: 16, downloadDirectory: "", askDownloadLocation: false }, downloads: [], permissions: [] });
  mount(browser);
  const docs = await screen.findByRole("tab", { name: /Docs/ });
  expect(docs.querySelector("img")?.getAttribute("src")).toBe(ICON);
  expect(screen.getByRole("tab", { name: /Stuck/ })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "关闭 Docs" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "关闭 Docs" }).getAttribute("aria-disabled")).toBe("true"));
  expect(browser.commands.at(-1)).toMatchObject({ action: "close-handoff", pageId: "docs" });
  browser.finish();
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Docs/ })).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "关闭 Stuck" }));
  await waitFor(() => expect(browser.commands.at(-1)).toMatchObject({ action: "close-handoff", pageId: "stuck" }));
  browser.finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "关闭 Stuck" }).getAttribute("aria-disabled")).toBeNull());
  expect(screen.getByRole("tab", { name: /Stuck/ })).toBeTruthy();
});

it("opens local links from the chat as a new page tab when the user may open pages", async () => {
  const browser = fakeBrowser({ sessionId: "chat", pages: [], activePageId: null, spaces: [{ id: "shared", name: "Shared" }], control: "agent", connection: "connected", settings: { maxTabs: 16, downloadDirectory: "", askDownloadLocation: false }, downloads: [], permissions: [] });
  const store = mount(browser);
  // The chat browser answers links once the desktop reports it is available.
  await waitFor(() => expect(routeBrowserLink("http://localhost:5173/")).toBe(true));
  await waitFor(() => expect(browser.commands.at(-1)).toMatchObject({ action: "create", url: "http://localhost:5173/" }));
  await waitFor(() => expect(store.getSnapshot().layout.right.groups[0]!.active).toMatch(/^browser-page:/));
});
