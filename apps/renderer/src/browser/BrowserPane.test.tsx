import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { BrowserPane } from "./BrowserPane";
afterEach(() => { cleanup(); localStorage.clear(); });
it("keeps demonstration observation and takeover local, and releases the picture when the sidebar hides", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  const view = (visible: boolean) => <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><BrowserPane client={client} available visible={visible} /></PreviewModeProvider></I18nProvider>;
  const { rerender } = render(view(true)); fireEvent.click(screen.getByRole("button", { name: "观察" }));
  await waitFor(() => expect(screen.getByAltText("当前浏览器画面")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "人工接管" })); expect(screen.getByRole("button", { name: "归还控制" })).toBeTruthy();
  rerender(view(false)); expect(screen.queryByAltText("当前浏览器画面")).toBeNull();
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});
it("does not ask an old Runtime for unknown browser commands", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const client = { command: vi.fn() } as unknown as StudioClient;
  render(<PreviewModeProvider switchEnabled><BrowserPane client={client} sessionId="s" available visible /></PreviewModeProvider>);
  expect(client.command).not.toHaveBeenCalled();
});
