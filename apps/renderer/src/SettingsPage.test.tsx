import { selectOption } from "./test/selectOption";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { BackgroundProvider } from "./background/BackgroundProvider";
import { BACKGROUND_STORAGE_KEY } from "./background/backgroundSettings";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import {
  __resetAppSettingsForTests,
  getAppSettings,
  updateAppSettings,
  type AppLanguage,
} from "./settings/appSettings";
import { setSettingsIntent, SettingsPage } from "./SettingsPage";

beforeAll(() => {
  // jsdom 没有 ResizeObserver / matchMedia；SlidingTabs 与 tab 过渡需要 stub。
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = (query: string) =>
    ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  window.localStorage.removeItem("omp.appSettings");
  window.localStorage.removeItem(BACKGROUND_STORAGE_KEY);
  window.localStorage.removeItem("omp.lastRoute");
  window.sessionStorage.removeItem("omp.settingsIntent");
  __resetAppSettingsForTests(null);
});

function renderSettings(options: {
  preview?: boolean;
  approvalMode?: "always-ask" | "always-ask-cached" | "write" | "yolo";
  onSetApprovalMode?: (mode: "always-ask" | "always-ask-cached" | "write" | "yolo") => void;
  language?: AppLanguage;
} = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === true ? "1" : "0");
  const onSetApprovalMode = options.onSetApprovalMode ?? vi.fn();
  const view = render(
    <PreviewModeProvider switchEnabled>
      <I18nProvider forcedLanguage={options.language ?? "zh"}>
        <BackgroundProvider preview={options.preview === true} theme="light">
          <SettingsPage
            {...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode })}
            onSetApprovalMode={onSetApprovalMode}
          />
        </BackgroundProvider>
      </I18nProvider>
    </PreviewModeProvider>,
  );
  return { onSetApprovalMode, ...view };
}

/** 切到指定标签并返回该标签的可达控件容器。 */
function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("SettingsPage · 背景", () => {
  it("点击内置预设立即切换并写入本地偏好", () => {
    renderSettings({ preview: false, language: "zh" });
    openTab("背景");
    fireEvent.click(screen.getByRole("button", { name: "极光" }));
    const stored = JSON.parse(window.localStorage.getItem(BACKGROUND_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored.enabled).toBe(true);
    expect(stored.activeId).toBe("preset:aurora");
  });

  it("预览模式切换背景不写真实存储", () => {
    renderSettings({ preview: true, language: "zh" });
    openTab("背景");
    fireEvent.click(screen.getByRole("button", { name: "极光" }));
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull();
  });
});

describe("SettingsPage · 结构", () => {
  it("渲染 9 个新标签，删除旧的 Models/Sessions/Preview 分组", () => {
    renderSettings({ preview: false, language: "zh" });
    const tabs = screen.getAllByRole("tab");
    const labels = tabs.map((tab) => tab.textContent ?? "");
    expect(labels).toContain("常规");
    expect(labels).toContain("背景");
    expect(labels).toContain("对话与交互");
    expect(labels).toContain("权限与安全");
    expect(labels).toContain("上下文与记忆");
    expect(labels).toContain("文件与终端");
    expect(labels).toContain("任务与执行");
    expect(labels).toContain("高级");
    expect(labels).toContain("运行偏好");
    expect(labels).toHaveLength(9);
    expect(screen.queryByText("Models and Providers")).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.queryByText("Preview")).toBeNull();
    // 权限模式下拉里的选项文案用 OMP 真实术语，不再用 Review/Workspace/Full Access。
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByText("Full Access")).toBeNull();
  });

  it("支持英文模式渲染 9 个英文标签与所有子面板的英文文案", () => {
    renderSettings({ preview: false, language: "en" });
    const tabs = screen.getAllByRole("tab");
    const labels = tabs.map((tab) => tab.textContent ?? "");
    expect(labels).toContain("General");
    expect(labels).toContain("Background");
    expect(labels).toContain("Interaction");
    expect(labels).toContain("Permissions");
    expect(labels).toContain("Context & Memory");
    expect(labels).toContain("Files & Terminal");
    expect(labels).toContain("Tasks & Execution");
    expect(labels).toContain("Advanced");
    expect(labels).toContain("Runtime preferences");
    expect(labels).toHaveLength(9);

    // General tab English checks
    expect(screen.getByRole("combobox", { name: "Interface Language" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Information Density" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Streaming Refresh Rate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset to Defaults" })).toBeTruthy();

    // Interaction tab English checks
    openTab("Interaction");
    expect(screen.getByRole("combobox", { name: "Steering Message Handling" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Follow-up Message Handling" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Interrupt Timing" })).toBeTruthy();

    // Permissions tab English checks
    openTab("Permissions");
    expect(screen.getByRole("combobox", { name: "Approval Mode" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "File Read" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Outside Workspace Policy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage Rules" })).toBeTruthy();

    // Context & Memory tab English checks
    openTab("Context & Memory");
    expect(screen.getByRole("combobox", { name: "Compact Strategy" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Memory Backend" })).toBeTruthy();

    // Files & Terminal tab English checks
    openTab("Files & Terminal");
    expect(screen.getByRole("combobox", { name: "Edit Mode" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Single Read Limit" })).toBeTruthy();

    // Tasks & Execution tab English checks
    openTab("Tasks & Execution");
    expect(screen.getByRole("combobox", { name: "Loop Mode" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Max Subtask Concurrency" })).toBeTruthy();

    // Advanced tab English checks
    openTab("Advanced");
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  }, 15000);

  it("支持深链 intent 直接打开目标标签", () => {
    setSettingsIntent("permissions");
    renderSettings({ preview: false, approvalMode: "write", language: "zh" });
    const tab = screen.getByRole("tab", { name: "权限与安全" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("combobox", { name: "审批模式" })).toBeTruthy();
  });
});

describe("SettingsPage · 真实模式", () => {
  it("App 级设置改动持久化到 localStorage", () => {
    renderSettings({ preview: false });
    const themeSelect = screen.getByRole("combobox", { name: "主题" });
    expect((themeSelect as HTMLButtonElement).textContent).toBe("Light");
    selectOption(themeSelect, "Dark");
    expect(getAppSettings().theme).toBe("dark");
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"theme":"dark"');

    const densitySelect = screen.getByRole("combobox", { name: "信息密度" });
    selectOption(densitySelect, "紧凑");
    expect(getAppSettings().density).toBe("compact");
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"density":"compact"');

    const cadenceSelect = screen.getByRole("combobox", { name: "流式刷新率" });
    expect((cadenceSelect as HTMLButtonElement).textContent).toBe("60 Hz（默认）");
    selectOption(cadenceSelect, "90 Hz");
    expect(getAppSettings().streamingCadenceHz).toBe(90);
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"streamingCadenceHz":90');

    const languageSelect = screen.getByRole("combobox", { name: "界面语言" });
    expect((languageSelect as HTMLButtonElement).textContent).toBe("跟随系统 (System)");
    selectOption(languageSelect, "English");
    expect(getAppSettings().language).toBe("en");
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"language":"en"');
  });

  it("恢复默认值把本标签的 App 级设置重置", () => {
    updateAppSettings({ language: "en", theme: "dark", density: "cozy", uiFontFamily: "Consolas", uiFontSize: 18, terminalFontSize: 24, outputFontSize: 20 });
    renderSettings({ preview: false });
    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(getAppSettings().language).toBe("system");
    expect(getAppSettings().theme).toBe("light");
    expect(getAppSettings().density).toBe("standard");
    expect(getAppSettings()).toMatchObject({ uiFontFamily: "", uiFontSize: 14, terminalFontSize: 12, outputFontSize: 14 });
    expect(getAppSettings().streamingCadenceHz).toBe(60);
    expect((screen.getByRole("combobox", { name: "主题" }) as HTMLButtonElement).textContent).toBe("Light");
    expect((screen.getByRole("combobox", { name: "界面语言" }) as HTMLButtonElement).textContent).toBe("跟随系统 (System)");
  });

  it("非法的流式刷新率会回退到默认 60 Hz", () => {
    __resetAppSettingsForTests(JSON.stringify({ streamingCadenceHz: 75 }));
    expect(getAppSettings().streamingCadenceHz).toBe(60);
    __resetAppSettingsForTests(JSON.stringify({ streamingCadenceHz: "60" }));
    expect(getAppSettings().streamingCadenceHz).toBe(60);
  });

  it("无 Runtime 时审批模式禁用并提示，有 Runtime 时写真实命令", () => {
    const onSetApprovalMode = vi.fn();
    renderSettings({ preview: false, onSetApprovalMode });
    openTab("权限与安全");
    const select = screen.getByRole("combobox", { name: "审批模式" });
    expect((select as HTMLButtonElement).disabled).toBe(true);
    expect(select.textContent).toBe("无 Runtime");
  });

  it("审批模式选择调用 onSetApprovalMode", () => {
    const onSetApprovalMode = vi.fn();
    renderSettings({ preview: false, approvalMode: "write", onSetApprovalMode });
    openTab("权限与安全");
    const select = screen.getByRole("combobox", { name: "审批模式" });
    expect((select as HTMLButtonElement).textContent).toBe("Write");
    selectOption(select, "Yolo");
    expect(onSetApprovalMode).toHaveBeenCalledWith("yolo");
  });

  it("尚未接入的 Runtime 行为只渲染禁用的静态控件，不做假开关", () => {
    renderSettings({ preview: false });
    openTab("对话与交互");
    expect((screen.getByRole("combobox", { name: "Steering 消息处理" }) as HTMLButtonElement).disabled).toBe(true);

    openTab("任务与执行");
    expect((screen.getByRole("combobox", { name: "子任务最大并发数" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("隐藏标签的「尚未接入」按钮给出原因", () => {
    renderSettings({ preview: false });
    openTab("权限与安全");
    const manage = screen.getByRole("button", { name: "管理规则" });
    expect((manage as HTMLButtonElement).disabled).toBe(true);
    expect(manage.getAttribute("data-tip")).toBe("管理规则（暂未实现）");
  });
});

describe("SettingsPage · 预览模式", () => {
  it("预览开时展示演示值，改动只影响本地状态，不写设置存储", () => {
    renderSettings({ preview: true });
    const themeSelect = screen.getByRole("combobox", { name: "主题" });
    expect((themeSelect as HTMLButtonElement).textContent).toBe("Light");
    const cadenceSelect = screen.getByRole("combobox", { name: "流式刷新率" });
    expect((cadenceSelect as HTMLButtonElement).textContent).toBe("60 Hz（默认）");
    selectOption(cadenceSelect, "120 Hz");
    expect(getAppSettings().streamingCadenceHz).toBe(60);
    expect(window.localStorage.getItem("omp.appSettings")).toBeNull();
    selectOption(themeSelect, "Dark");
    // 演示改动不落盘：真实存储仍是默认 light。
    expect(getAppSettings().theme).toBe("light");
    expect(window.localStorage.getItem("omp.appSettings")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("演示");
  });

  it("预览开时 Runtime 行为行是可交互的演示控件并带提示", () => {
    renderSettings({ preview: true });
    openTab("对话与交互");
    const steering = screen.getByRole("combobox", { name: "Steering 消息处理" });
    expect((steering as HTMLButtonElement).disabled).toBe(false);
    expect((steering as HTMLButtonElement).textContent).toBe("一次处理一条");
    selectOption(steering, "一次处理全部");
    expect((screen.getByRole("combobox", { name: "Steering 消息处理" }) as HTMLButtonElement).textContent).toBe("一次处理全部");
    expect(screen.getByRole("status").textContent).toContain("演示");
  });

  it("预览开时审批模式显示演示值且不调用真实命令", () => {
    const onSetApprovalMode = vi.fn();
    renderSettings({ preview: true, onSetApprovalMode });
    openTab("权限与安全");
    const select = screen.getByRole("combobox", { name: "审批模式" });
    expect((select as HTMLButtonElement).textContent).toBe("Write");
    selectOption(select, "Yolo");
    expect(onSetApprovalMode).not.toHaveBeenCalled();
  });
});
