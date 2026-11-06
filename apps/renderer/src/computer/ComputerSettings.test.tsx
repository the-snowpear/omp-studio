import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, CommandState, StudioClient } from "@omp-studio/client-contract";
import { ComputerSettings } from "./ComputerSettings";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PREVIEW_COMPUTER_SETTINGS } from "../preview/computerPreview";
import { selectOption } from "../test/selectOption";
const capabilities: ClientBootstrap["capabilityManifest"] = { profile: "limited", hash: "settings", generatedAt: "2026-11-05T00:00:00Z", capabilities: ["preferences.features.get", "preferences.features.set", "preferences.features.clearOverride", "computer.control.stop"].map(id => ({ id, grade: "stable", version: 1, evidence: "test" })) };
function settings(status: "stopped" | "unconfirmed" = "stopped") {
  const commands: Record<string, CommandState> = {}; let counter = 0;
  const command = vi.fn(async (kind: string, input: any) => {
    const requestId = `settings-${++counter}`;
    const result = kind === "preferences.features.get" ? { settings: PREVIEW_COMPUTER_SETTINGS } : kind === "computer.control.stop" ? { status, revision: 7, updatedAt: 1, foreground: "none" } : input.scope === "global" && input.key === "computer.enabled" ? PREVIEW_COMPUTER_SETTINGS.find(row => row.key === "computer.enabled") : { key: input.key, value: input.value, source: input.scope === "global" ? "global" : "runtime" };
    commands[requestId] = { requestId, commandName: kind, status: "completed", observedAt: "2026-11-05T00:00:00Z", result: { result } } as CommandState;
    return { requestId };
  });
  const client = { command, getState: () => ({ commands }) } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ComputerSettings client={client} context={{ sessionId: "root", available: true, capabilities }} visible /></PreviewModeProvider></I18nProvider>);
  return command;
}
afterEach(() => { cleanup(); localStorage.clear(); });
it("stops the session before saving disabled and keeps session scope explicit", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const command = settings();
  await waitFor(() => expect(screen.getByRole("switch", { name: "允许电脑操作" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("switch", { name: "允许电脑操作" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("preferences.features.set", { sessionId: "root", key: "computer.enabled", value: false, scope: "session" }));
  const stopIndex = command.mock.calls.findIndex(([kind]) => kind === "computer.control.stop");
  const saveIndex = command.mock.calls.findIndex(([kind]) => kind === "preferences.features.set");
  expect(stopIndex).toBeLessThan(saveIndex);
  expect(command.mock.calls[stopIndex]).toEqual(["computer.control.stop", { sessionId: "root", reason: "disable" }]);
});
it("does not disable after an unconfirmed stop", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const command = settings("unconfirmed");
  await waitFor(() => expect(screen.getByRole("switch", { name: "允许电脑操作" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("switch", { name: "允许电脑操作" }));
  await screen.findByText("停止尚未完全确认，未修改启用设置。");
  expect(command.mock.calls.some(([kind]) => kind === "preferences.features.set")).toBe(false);
});
it("saves a native display id as text to the explicitly chosen global scope", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const command = settings();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "原生默认显示器" }).hasAttribute("disabled")).toBe(false));
  selectOption(screen.getByRole("combobox", { name: "电脑设置保存范围" }), "全局默认");
  fireEvent.change(screen.getByRole("textbox", { name: "原生默认显示器" }), { target: { value: "display:external" } });
  const row = screen.getByRole("textbox", { name: "原生默认显示器" }).closest(".cw-setting-row")!;
  fireEvent.click(row.querySelector("button.cw-button")!);
  await waitFor(() => expect(command).toHaveBeenCalledWith("preferences.features.set", { sessionId: "root", key: "computer.display", value: "display:external", scope: "global" }));
  expect(screen.getByText(/全局修改影响继承该值的会话/)).toBeTruthy();
});

it("changes the global default without stopping an explicitly enabled session", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0"); const command = settings();
  await waitFor(() => expect(screen.getByRole("switch", { name: "允许电脑操作" }).hasAttribute("disabled")).toBe(false));
  selectOption(screen.getByRole("combobox", { name: "电脑设置保存范围" }), "全局默认");
  selectOption(screen.getByRole("combobox", { name: "全局默认电脑操作" }), "关闭");
  await waitFor(() => expect(command).toHaveBeenCalledWith("preferences.features.set", { sessionId: "root", key: "computer.enabled", value: false, scope: "global" }));
  expect(command.mock.calls.some(([kind]) => kind === "computer.control.stop")).toBe(false);
  expect(screen.getByText(/生效值：true.*本次会话/)).toBeTruthy();
});
it("preview global changes preserve the effective session override without Host writes", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const command = settings();
  selectOption(screen.getByRole("combobox", { name: "电脑设置保存范围" }), "全局默认");
  selectOption(screen.getByRole("combobox", { name: "全局默认电脑操作" }), "关闭");
  expect(screen.getByText(/生效值：true.*本次会话/)).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});
