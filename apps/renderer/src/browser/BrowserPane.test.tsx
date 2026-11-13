import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { BrowserPane } from "./BrowserPane";
import { ManagedBrowserPane } from "./ManagedBrowserPane";
import { PREVIEW_BROWSER_TAB, previewBrowserDescriptor } from "../preview/browserPreview";
const originalUrl = window.location.href;
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); window.history.replaceState(null, "", originalUrl); });
it("keeps multi-element feedback and control local in preview across panel hiding", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  const onReferences = vi.fn();
  const view = (visible: boolean) => <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ManagedBrowserPane sessionId="pane-test" pageId="pane-test:page-1" visible={visible} onReferences={onReferences} /></PreviewModeProvider></I18nProvider>;
  const { rerender } = render(view(true));
  fireEvent.click(await screen.findByRole("button", { name: "人工接管" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "归还 Agent 控制" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "选择页面元素" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "停止选择元素" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Preview button · 0" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview button · 0" }));
  expect(screen.getAllByRole("textbox", { name: /^备注/ })).toHaveLength(2);
  fireEvent.change(screen.getAllByRole("textbox", { name: /^备注/ })[0]!, { target: { value: "调整按钮间距" } });
  rerender(view(false)); expect(screen.queryByRole("region", { name: "浏览器页面" })).toBeNull();
  rerender(view(true)); expect(screen.getByRole("button", { name: "归还 Agent 控制" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加入输入框" }));
  expect(onReferences.mock.calls[0]?.[0]).toHaveLength(2);
  expect(onReferences.mock.calls[0]?.[0][0].note).toBe("调整按钮间距");
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});
it("does not ask an old Runtime for unknown browser commands", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const client = { command: vi.fn() } as unknown as StudioClient;
  render(<PreviewModeProvider switchEnabled><BrowserPane client={client} sessionId="s" available visible /></PreviewModeProvider>);
  expect(client.command).not.toHaveBeenCalled();
});

it("does not use WebContentsView for a native WebKit descriptor just because Electron is present", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const tab = { ...PREVIEW_BROWSER_TAB, ...previewBrowserDescriptor("webkit"), sessionId: "native-chat", targetId: "native-webkit-8" };
  const command = vi.fn(async () => ({ requestId: "native-tabs" }));
  const client = { command, getState: () => ({ commands: { "native-tabs": { status: "completed", result: { result: { tabs: [tab] } } } } }), subscribe: () => () => {} } as unknown as StudioClient;
  const present = vi.fn(async () => {});
  vi.stubGlobal("ompStudioChrome", { managedBrowser: { available: async () => true, read: async () => ({ sessionId: "native-chat", pages: [], activePageId: null, spaces: [], control: "agent", connection: "connected", settings: { maxTabs: 16, downloadDirectory: "", askDownloadLocation: false }, downloads: [], permissions: [] }), execute: vi.fn(), present, subscribe: () => () => {} } });
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ManagedBrowserPane nativeClient={client} sessionId="native-chat" pageId={tab.id} visible /></PreviewModeProvider></I18nProvider>);
  expect(await screen.findByText("WebKit")).toBeTruthy();
  expect(screen.getByText("当前连接无法显示同页画面")).toBeTruthy();
  expect(present).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "开发者工具" })).toHaveProperty("disabled", true);
});

it("keeps native preview control local and hides its demo marks when marks are off", async () => {
  window.history.replaceState(null, "", "?preview=1&marks=off");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ManagedBrowserPane client={client} nativeClient={client} sessionId="native-preview-marks" pageId="native-preview-marks:page-2" visible /></PreviewModeProvider></I18nProvider>);
  const take = await screen.findByRole("button", { name: "人工接管" });
  await waitFor(() => expect(take).toHaveProperty("disabled", false));
  fireEvent.click(take);
  await screen.findByRole("button", { name: "归还 Agent 控制" });
  expect(screen.queryByText("演示")).toBeNull();
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});
