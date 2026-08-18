import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import {
  __resetAppSettingsForTests,
  getAppSettings,
  updateAppSettings,
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
  window.localStorage.removeItem("omp.lastRoute");
  window.sessionStorage.removeItem("omp.settingsIntent");
  __resetAppSettingsForTests(null);
});

function renderSettings(options: {
  preview?: boolean;
  approvalMode?: "always-ask" | "write" | "yolo";
  onSetApprovalMode?: (mode: "always-ask" | "write" | "yolo") => void;
} = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === true ? "1" : "0");
  const onSetApprovalMode = options.onSetApprovalMode ?? vi.fn();
  const view = render(
    <PreviewModeProvider>
      <SettingsPage
        {...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode })}
        onSetApprovalMode={onSetApprovalMode}
      />
    </PreviewModeProvider>,
  );
  return { onSetApprovalMode, ...view };
}

/** 切到指定标签并返回该标签的可达控件容器。 */
function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("SettingsPage · 结构", () => {
  it("渲染 7 个新标签，删除旧的 Models/Sessions/Preview 分组", () => {
    renderSettings({ preview: false });
    const tabs = screen.getAllByRole("tab");
    const labels = tabs.map((tab) => tab.textContent ?? "");
    expect(labels).toContain("常规");
    expect(labels).toContain("对话与交互");
    expect(labels).toContain("权限与安全");
    expect(labels).toContain("上下文与记忆");
    expect(labels).toContain("文件与终端");
    expect(labels).toContain("任务与执行");
    expect(labels).toContain("高级");
    expect(labels).toHaveLength(7);
    expect(screen.queryByText("Models and Providers")).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
    expect(screen.queryByText("Preview")).toBeNull();
    // 权限模式下拉里的选项文案用 OMP 真实术语，不再用 Review/Workspace/Full Access。
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByText("Full Access")).toBeNull();
  });

  it("支持深链 intent 直接打开目标标签", () => {
    setSettingsIntent("permissions");
    renderSettings({ preview: false, approvalMode: "write" });
    const tab = screen.getByRole("tab", { name: "权限与安全" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("combobox", { name: "审批模式" })).toBeTruthy();
  });
});

describe("SettingsPage · 真实模式", () => {
  it("App 级设置改动持久化到 localStorage", () => {
    renderSettings({ preview: false });
    const themeSelect = screen.getByRole("combobox", { name: "主题" });
    expect((themeSelect as HTMLSelectElement).value).toBe("light");
    fireEvent.change(themeSelect, { target: { value: "dark" } });
    expect(getAppSettings().theme).toBe("dark");
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"theme":"dark"');

    const densitySelect = screen.getByRole("combobox", { name: "信息密度" });
    fireEvent.change(densitySelect, { target: { value: "compact" } });
    expect(getAppSettings().density).toBe("compact");
    expect(window.localStorage.getItem("omp.appSettings")).toContain('"density":"compact"');
  });

  it("恢复默认值把本标签的 App 级设置重置", () => {
    updateAppSettings({ theme: "dark", density: "cozy" });
    renderSettings({ preview: false });
    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(getAppSettings().theme).toBe("light");
    expect(getAppSettings().density).toBe("standard");
    expect((screen.getByRole("combobox", { name: "主题" }) as HTMLSelectElement).value).toBe("light");
  });

  it("无 Runtime 时审批模式禁用并提示，有 Runtime 时写真实命令", () => {
    const onSetApprovalMode = vi.fn();
    renderSettings({ preview: false, onSetApprovalMode });
    openTab("权限与安全");
    const select = screen.getByRole("combobox", { name: "审批模式" });
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(within(select).getByRole("option", { name: "无 Runtime" })).toBeTruthy();
  });

  it("审批模式选择调用 onSetApprovalMode", () => {
    const onSetApprovalMode = vi.fn();
    renderSettings({ preview: false, approvalMode: "write", onSetApprovalMode });
    openTab("权限与安全");
    const select = screen.getByRole("combobox", { name: "审批模式" });
    expect((select as HTMLSelectElement).value).toBe("write");
    fireEvent.change(select, { target: { value: "yolo" } });
    expect(onSetApprovalMode).toHaveBeenCalledWith("yolo");
  });

  it("尚未接入的 Runtime 行为只渲染禁用的静态控件，不做假开关", () => {
    renderSettings({ preview: false });
    expect((screen.getByRole("combobox", { name: "界面语言" }) as HTMLSelectElement).disabled).toBe(true);

    openTab("对话与交互");
    expect((screen.getByRole("combobox", { name: "Steering 消息处理" }) as HTMLSelectElement).disabled).toBe(true);

    openTab("任务与执行");
    expect((screen.getByRole("combobox", { name: "子任务最大并发数" }) as HTMLSelectElement).disabled).toBe(true);
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
    expect((themeSelect as HTMLSelectElement).value).toBe("dark");
    fireEvent.change(themeSelect, { target: { value: "light" } });
    // 演示改动不落盘：真实存储仍是默认 light。
    expect(getAppSettings().theme).toBe("light");
    expect(window.localStorage.getItem("omp.appSettings")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("演示");
  });

  it("预览开时 Runtime 行为行是可交互的演示控件并带提示", () => {
    renderSettings({ preview: true });
    openTab("对话与交互");
    const steering = screen.getByRole("combobox", { name: "Steering 消息处理" });
    expect((steering as HTMLSelectElement).disabled).toBe(false);
    expect((steering as HTMLSelectElement).value).toBe("一次处理一条");
    fireEvent.change(steering, { target: { value: "一次处理全部" } });
    expect((screen.getByRole("combobox", { name: "Steering 消息处理" }) as HTMLSelectElement).value).toBe("一次处理全部");
    expect(screen.getByRole("status").textContent).toContain("演示");
  });

  it("预览开时审批模式显示演示值且不调用真实命令", () => {
    const onSetApprovalMode = vi.fn();
    renderSettings({ preview: true, onSetApprovalMode });
    openTab("权限与安全");
    const select = screen.getByRole("combobox", { name: "审批模式" });
    expect((select as HTMLSelectElement).value).toBe("write");
    fireEvent.change(select, { target: { value: "yolo" } });
    expect(onSetApprovalMode).not.toHaveBeenCalled();
  });
});
