import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { RuntimeSettingsReadModel } from "@omp-studio/client-contract";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { BackgroundProvider } from "./background/BackgroundProvider";
import { SettingsPage } from "./SettingsPage";
import { selectOption } from "./test/selectOption";

beforeAll(() => {
  class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = query => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); window.localStorage.clear(); window.sessionStorage.clear(); });

function page(preview: boolean, onSet = vi.fn()) {
  if (preview) window.history.replaceState(null, "", "/?preview=1&marks=off");
  const snapshot = { "edit.autoRepair.enabled": false, "features.unexpectedStopDetection": "mechanical", extendedContext: false, "compaction.asyncEnabled": true, "compaction.methodOrder": ["remote"], "providers.openai-codex.codeMode": "off", "edit.mode": "hashline", "read.defaultLimit": 300, "memory.backend": "off" } as RuntimeSettingsReadModel;
  render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><BackgroundProvider preview={preview} theme="light"><SettingsPage onSetApprovalMode={vi.fn()} runtimeSettings={{ snapshot, onSet }} /></BackgroundProvider></I18nProvider></PreviewModeProvider>);
  return onSet;
}

it("finds a new key and saves the chosen edit mode to user configuration", async () => {
  const onSet = page(false);
  const search = screen.getByRole("searchbox", { name: "搜索设置" });
  fireEvent.change(search, { target: { value: "read.defaultLimit" } });
  fireEvent.click(screen.getByRole("button", { name: /默认读取行数.*工具与终端/ }));
  expect(await screen.findByRole("spinbutton", { name: "默认读取行数" })).toBeTruthy();
  selectOption(screen.getByRole("combobox", { name: "编辑模式" }), "replace");
  await waitFor(() => expect(onSet).toHaveBeenCalledWith("edit.mode", "replace", true));
});

it("shows only the selected memory backend in preview without writing real settings", () => {
  const onSet = page(true);
  fireEvent.click(screen.getByRole("tab", { name: "上下文与记忆" }));
  selectOption(screen.getByRole("combobox", { name: "记忆后端" }), "hindsight");
  expect(screen.getByRole("textbox", { name: "Hindsight 服务地址" })).toBeTruthy();
  expect(screen.getByLabelText("Hindsight 令牌")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Mnemopi 自动召回" })).toBeNull();
  expect(onSet).not.toHaveBeenCalled();
  expect(screen.queryByText("演示设置已更新。")).toBeNull();
});

it("does not offer a current-session override for the default of future sessions", () => {
  page(true);
  fireEvent.click(screen.getByRole("tab", { name: "任务与代理" }));
  selectOption(screen.getByRole("combobox", { name: "运行设置保存范围" }), "仅当前会话");
  expect((screen.getByRole("switch", { name: "新会话默认进入 Plan" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("新会话默认模式只能保存到用户配置。")).toBeTruthy();
});

it("locates an inactive backend's searched setting without changing the backend", async () => {
  const onSet = page(false);
  const search = screen.getByRole("searchbox", { name: "搜索设置" });
  fireEvent.change(search, { target: { value: "hindsight.apiUrl" } });
  fireEvent.click(screen.getByRole("button", { name: /Hindsight 服务地址.*上下文与记忆/ }));
  const input = await screen.findByRole("textbox", { name: "Hindsight 服务地址" });
  await waitFor(() => expect(input.closest(".set-row")?.classList.contains("settings-search-highlight")).toBe(true));
  expect(screen.getByText("当前未启用 hindsight；以下配置在选择该后端后生效。")).toBeTruthy();
  expect(onSet).not.toHaveBeenCalled();
});
