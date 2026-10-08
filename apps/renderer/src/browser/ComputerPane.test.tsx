import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ComputerPane } from "./ComputerPane";
afterEach(() => { cleanup(); localStorage.clear(); });
it("previews capture and stop locally and drops the picture when hidden", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  const view = (visible: boolean) => <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ComputerPane client={client} available visible={visible} /></PreviewModeProvider></I18nProvider>;
  const { rerender } = render(view(true)); fireEvent.click(screen.getByRole("button", { name: "刷新截图" })); await waitFor(() => expect(screen.getByAltText("所选电脑目标截图")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "停止电脑操作" })); expect(screen.getByText("演示：已请求停止")).toBeTruthy();
  rerender(view(false)); expect(screen.queryByAltText("所选电脑目标截图")).toBeNull(); expect(client.command).not.toHaveBeenCalled();
});
