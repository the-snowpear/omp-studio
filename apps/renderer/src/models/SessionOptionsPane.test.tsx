import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { SessionOptionsPane } from "./SessionOptionsPane";
import { ModelPresetsPane } from "./ModelPresetsPane";

afterEach(() => { cleanup(); localStorage.clear(); });
const client = () => ({ command: vi.fn(), query: vi.fn() } as unknown as StudioClient);
it("previews speed and warming changes locally, and waits for confirmation before enabling requests", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const host = client();
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><SessionOptionsPane client={host} available /></PreviewModeProvider></I18nProvider>);
  fireEvent.change(screen.getByLabelText("处理速度"), { target: { value: "ultrafast" } });
  expect((screen.getByLabelText("处理速度") as HTMLSelectElement).value).toBe("ultrafast");
  fireEvent.change(screen.getByLabelText("缓存保温模式"), { target: { value: "idle" } });
  expect((screen.getByLabelText("缓存保温模式") as HTMLSelectElement).value).toBe("off");
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect((screen.getByLabelText("缓存保温模式") as HTMLSelectElement).value).toBe("idle"));
  expect(host.command).not.toHaveBeenCalled(); expect(host.query).not.toHaveBeenCalled();
});
it("does not issue unknown commands when the Runtime lacks session option capabilities", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const host = client();
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><SessionOptionsPane client={host} sessionId="s" available /><ModelPresetsPane client={host} sessionId="s" available /></PreviewModeProvider></I18nProvider>);
  expect((screen.getByLabelText("处理速度") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText("名称：以字母开头"), { target: { value: "saved" } });
  expect((screen.getByRole("button", { name: "保存预设" }) as HTMLButtonElement).disabled).toBe(true);
  expect(host.command).not.toHaveBeenCalled(); expect(host.query).not.toHaveBeenCalled();
});
it("keeps preset writes in preview local and requires confirmation before replacing roles", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const host = client();
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ModelPresetsPane client={host} available /></PreviewModeProvider></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "review" }));
  fireEvent.click(screen.getByRole("button", { name: "应用预设" }));
  expect(screen.getByRole("dialog", { name: "确认预设操作" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "review 生效中" })).toBeTruthy());
  expect(host.command).not.toHaveBeenCalled();
});
