import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { IdaPane } from "./IdaPane";
afterEach(() => { cleanup(); localStorage.clear(); });
it("previews the database workflow without calling native IDA and keeps the code draft while hidden", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  const view = (visible: boolean) => <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} available visible={visible} /></PreviewModeProvider></I18nProvider>;
  const { rerender } = render(view(true));
  const code = screen.getAllByLabelText("Python").find(element => element.tagName === "TEXTAREA")!;
  fireEvent.change(code, { target: { value: "print(db)" } });
  rerender(view(false)); rerender(view(true)); expect(screen.getByDisplayValue("print(db)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "运行请求" })); expect(screen.getByRole("dialog", { name: "确认 IDA 操作" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});
it("gates all native actions when the Runtime does not advertise IDA", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} available sessionId="s" /></PreviewModeProvider></I18nProvider>);
  fireEvent.change(screen.getByPlaceholderText("文件路径"), { target: { value: "sample.exe" } });
  expect((screen.getByRole("button", { name: "打开数据库" }) as HTMLButtonElement).disabled).toBe(true);
  expect(client.command).not.toHaveBeenCalled();
});
