import { selectOption } from "./test/selectOption";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsReadModel } from "@omp-studio/client-contract";
import { GUI_SETTING_KEYS } from "@omp-studio/studio-protocol";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { BackgroundProvider } from "./background/BackgroundProvider";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { __resetAppSettingsForTests, getAppSettings, updateAppSettings } from "./settings/appSettings";
import { BACKGROUND_STORAGE_KEY } from "./background/backgroundSettings";
import { SETTINGS_GUI_COVERAGE } from "./settings/catalog";
import { setSettingsIntent, SettingsPage, type RuntimeSettingsApi } from "./SettingsPage";
import { __resetUpdatesForTests, type UpdatePrefs } from "./settings/updates";

beforeAll(() => {
  class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  window.localStorage.removeItem("omp.appSettings");
  window.localStorage.removeItem(BACKGROUND_STORAGE_KEY);
  window.sessionStorage.removeItem("omp.settingsIntent");
  __resetAppSettingsForTests(null);
  __resetUpdatesForTests();
  vi.unstubAllGlobals();
});

const snapshot: RuntimeSettingsReadModel = {
  "edit.autoRepair.enabled": true, "features.unexpectedStopDetection": "smart", extendedContext: true,
  "compaction.asyncEnabled": true, "compaction.methodOrder": ["remote", "snapcompact", "handoff", "shake", "soft"],
  "providers.openai-codex.codeMode": "off", steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  interruptMode: "immediate", "edit.fuzzyThreshold": 0.95, "compaction.enabled": true,
  "task.maxConcurrency": 32, "retry.enabled": true,
};
function renderSettings(options: { preview?: boolean; language?: "zh" | "en"; approvalMode?: "write"; onSetApprovalMode?: ReturnType<typeof vi.fn>; runtimeSettings?: RuntimeSettingsApi } = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview ? "1" : "0");
  return render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage={options.language ?? "zh"}><BackgroundProvider preview={!!options.preview} theme="light">
    <SettingsPage onSetApprovalMode={options.onSetApprovalMode ?? vi.fn()} {...(options.approvalMode ? { approvalMode: options.approvalMode } : {})} {...(options.runtimeSettings ? { runtimeSettings: options.runtimeSettings } : {})} />
  </BackgroundProvider></I18nProvider></PreviewModeProvider>);
}
function openTab(name: string) { fireEvent.click(screen.getByRole("tab", { name })); }

describe("settings navigation and real preferences", () => {
  it("groups controls by purpose and covers each existing Runtime GUI setting once", () => {
    renderSettings();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual([
      "常规与通知", "外观与布局", "对话与输入", "语音", "上下文与记忆", "工具与终端",
      "任务与代理", "模型与服务", "权限与安全", "更新与维护", "待支持",
    ]);
    expect(new Set(SETTINGS_GUI_COVERAGE).size).toBe(GUI_SETTING_KEYS.length);
    expect([...SETTINGS_GUI_COVERAGE].sort()).toEqual([...GUI_SETTING_KEYS].sort());
  });

  it("searches by English and configuration key, then opens and highlights the actual control", async () => {
    renderSettings({ runtimeSettings: { snapshot, onSet: vi.fn() } });
    const search = screen.getByRole("searchbox", { name: "搜索设置" });
    fireEvent.change(search, { target: { value: "edit.fuzzyThreshold" } });
    fireEvent.click(screen.getByRole("button", { name: /编辑匹配阈值.*工具与终端/ }));
    expect(screen.getByRole("tab", { name: "工具与终端" }).getAttribute("aria-selected")).toBe("true");
    const input = await screen.findByRole("spinbutton", { name: "编辑匹配阈值" });
    await waitFor(() => expect(input.closest(".set-row")?.classList.contains("settings-search-highlight")).toBe(true));
    expect(document.activeElement).toBe(input);
    fireEvent.change(search, { target: { value: "message delivery" } });
    expect(screen.getByRole("button", { name: /Steering 消息处理/ })).toBeTruthy();
  });

  it("allows changing categories with the keyboard", () => {
    renderSettings();
    const first = screen.getByRole("tab", { name: "常规与通知" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const next = screen.getByRole("tab", { name: "外观与布局" });
    expect(next.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(next);
  });

  it("preserves legacy group intents and targeted intents", async () => {
    setSettingsIntent("background");
    const first = renderSettings();
    expect(screen.getByRole("tab", { name: "外观与布局" }).getAttribute("aria-selected")).toBe("true");
    first.unmount();
    setSettingsIntent("voice", "dictation");
    renderSettings();
    expect(screen.getByRole("tab", { name: "语音" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: /语音输入/ })).toBeTruthy();
  });

  it("saves local appearance and startup settings; reset affects only its own section", () => {
    updateAppSettings({ theme: "dark", density: "cozy", restoreLastProject: false });
    renderSettings();
    openTab("外观与布局");
    selectOption(screen.getByRole("combobox", { name: "主题" }), "Light");
    expect(getAppSettings().theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "恢复外观默认值" }));
    expect(getAppSettings().density).toBe("standard");
    expect(getAppSettings().restoreLastProject).toBe(false);
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"theme":"light"');
  });

  it("keeps old Runtime settings unavailable and describes unsupported features without fake controls", () => {
    renderSettings();
    openTab("对话与输入");
    expect((screen.getByRole("combobox", { name: "Steering 消息处理" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("combobox", { name: "大段粘贴处理" })).toBeNull();
    openTab("待支持");
    expect(screen.getByText("大段粘贴处理")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "大段粘贴处理" })).toBeNull();
  });

  it("shows a read-only Runtime value without presenting it as editable", () => {
    renderSettings({ runtimeSettings: { snapshot } });
    openTab("对话与输入");
    const control = screen.getByRole("combobox", { name: "Steering 消息处理" });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.textContent).toBe("一次处理一条");
    expect(within(control.closest(".set-row") as HTMLElement).getByText("当前 Runtime 只提供读取")).toBeTruthy();
  });

  it("exposes an accessible English navigation and the real approval action", () => {
    const change = vi.fn();
    renderSettings({ language: "en", approvalMode: "write", onSetApprovalMode: change });
    openTab("Permissions and security");
    selectOption(screen.getByRole("combobox", { name: "Approval Mode" }), "Yolo");
    expect(change).toHaveBeenCalledWith("yolo");
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();
  });

  it("preserves update preferences across reopen", async () => {
    let prefs: UpdatePrefs = { mirrorPrefix: "", autoCheck: true, skippedAppVersion: "", runtimeChannel: "stable", preferHotUpdate: true, lastIndexSequence: 0 };
    const setUpdatePrefs = vi.fn(async (patch: Partial<UpdatePrefs>) => { prefs = { ...prefs, ...patch }; return prefs; });
    vi.stubGlobal("ompStudioChrome", { getUpdatePrefs: vi.fn(async () => prefs), setUpdatePrefs });
    const view = renderSettings();
    openTab("更新与维护");
    const toggle = screen.getByRole("switch", { name: "自动下载更新" });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(setUpdatePrefs).toHaveBeenCalledWith({ autoDownload: false }));
    view.unmount(); __resetUpdatesForTests();
    renderSettings(); openTab("更新与维护");
    await waitFor(() => expect(screen.getByRole("switch", { name: "自动下载更新" }).getAttribute("aria-checked")).toBe("false"));
  });
});

describe("Runtime settings and preview isolation", () => {
  it("writes the native value at the selected scope and accepts decimal thresholds", async () => {
    const onSet = vi.fn(async () => {});
    renderSettings({ runtimeSettings: { snapshot, onSet } });
    openTab("对话与输入");
    selectOption(screen.getByRole("combobox", { name: "Steering 消息处理" }), "一次处理全部");
    await waitFor(() => expect(onSet).toHaveBeenCalledWith("steeringMode", "all", true));
    selectOption(screen.getByRole("combobox", { name: "运行设置保存范围" }), "仅当前会话");
    selectOption(screen.getByRole("combobox", { name: "纠偏消息中断时机" }), "当前工具完成后");
    await waitFor(() => expect(onSet).toHaveBeenCalledWith("interruptMode", "wait", false));
    openTab("工具与终端");
    const row = screen.getByRole("spinbutton", { name: "编辑匹配阈值" }).closest(".set-row") as HTMLElement;
    fireEvent.change(within(row).getByRole("spinbutton"), { target: { value: "0.9" } });
    fireEvent.click(within(row).getByRole("button", { name: "应用" }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith("edit.fuzzyThreshold", 0.9, false));
  });

  it("keeps preview changes in the preview after moving between categories", () => {
    const onSet = vi.fn();
    renderSettings({ preview: true, runtimeSettings: { snapshot, onSet } });
    openTab("对话与输入");
    selectOption(screen.getByRole("combobox", { name: "Steering 消息处理" }), "一次处理全部");
    openTab("工具与终端"); openTab("对话与输入");
    expect(screen.getByRole("combobox", { name: "Steering 消息处理" }).textContent).toBe("一次处理全部");
    expect(onSet).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("omp.appSettings")).toBeNull();
  });

  it("keeps feature-setting previews local when navigating away and back", () => {
    renderSettings({ preview: true });
    openTab("上下文与记忆");
    fireEvent.click(screen.getByRole("switch", { name: "空闲压缩" }));
    openTab("常规与通知");
    openTab("上下文与记忆");
    expect(screen.getByRole("switch", { name: "空闲压缩" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not announce demo saves when preview marks are off", async () => {
    window.history.replaceState(null, "", "?preview=1&marks=off");
    try {
      renderSettings({ preview: true });
      openTab("对话与输入");
      selectOption(screen.getByRole("combobox", { name: "引擎" }), "关闭");
      await waitFor(() => expect(screen.queryByText("预测设置已保存。")).toBeNull());
      expect(screen.queryByText(/演示设置已更新/)).toBeNull();
    } finally { window.history.replaceState(null, "", "/"); }
  });

  it("exposes previously hidden session storage settings in preview", () => {
    renderSettings({ preview: true });
    openTab("更新与维护");
    expect(screen.getByRole("switch", { name: "后台自动压缩闲置会话" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "闲置天数" })).toBeTruthy();
  });

  it("explains that OTLP can only be saved globally and requires a restart", async () => {
    renderSettings({ preview: true });
    openTab("更新与维护");
    selectOption(screen.getByRole("combobox", { name: "运行设置保存范围" }), "仅当前会话");
    const toggle = screen.getByRole("switch", { name: "OTLP 导出" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("此项只能保存到用户配置")).toBeTruthy();
    selectOption(screen.getByRole("combobox", { name: "运行设置保存范围" }), "用户配置");
    fireEvent.click(toggle);
    expect(await screen.findByText("等待重启")).toBeTruthy();
  });

  it("does not report an old session's pending save after switching sessions", async () => {
    let complete!: () => void;
    const onSet = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const element = (sessionId: string) => <PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><BackgroundProvider preview={false} theme="light">
      <SettingsPage nativeContext={{ sessionId, available: false }} runtimeSettings={{ snapshot, onSet }} onSetApprovalMode={vi.fn()} />
    </BackgroundProvider></I18nProvider></PreviewModeProvider>;
    const view = render(element("first"));
    openTab("对话与输入");
    selectOption(screen.getByRole("combobox", { name: "Steering 消息处理" }), "一次处理全部");
    expect(onSet).toHaveBeenCalledTimes(1);
    view.rerender(element("second"));
    complete();
    await waitFor(() => expect(screen.queryByText("设置已保存。")).toBeNull());
    expect(screen.getByRole("combobox", { name: "Steering 消息处理" }).textContent).toBe("一次处理一条");
  });
});
