/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { AppSidebar } from "../App";
import { DockProvider } from "../dock/DockContext";
import { WORKBENCH_PANELS } from "../panels/registry";
import { I18nProvider } from "../i18n";
import { zh } from "../i18n/locales/zh";
import { PLATFORM } from "../platform";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";

vi.mock("../TerminalPane", () => ({ TerminalPane: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

const workspaceId = "workspace-a" as WorkspaceId;
const otherWorkspaceId = "workspace-b" as WorkspaceId;

function baseState(workspaces = [{
  workspaceId,
  name: "omp-studio",
  lastOpenedAt: "2026-08-25T00:00:00.000Z",
  active: true,
}]) {
  return {
    loading: false,
    route: "workbench",
    events: [],
    model: {
      workspaces: { workspaces, activeWorkspaceId: workspaceId },
    },
    // 真实分支渲染路径（snapshotFrom / 线程列表 IIFE）需要的最小 clientState。
    clientState: { connection: {}, interaction: {}, entities: { snapshot: { sessionId: "session-other" } } },
  } as unknown as ComponentProps<typeof AppSidebar>["state"];
}

function baseChrome(extra: Record<string, unknown> = {}) {
  return {
    collapsed: false,
    skillsOpen: false,
    explorerOpen: false,
    projectListExpanded: true,
    expandedProjects: new Set([String(workspaceId), String(otherWorkspaceId)]),
    provisionalThreads: [],
    activeProvisionalSessionId: undefined,
    theme: "light",
    sidebarWidth: 272,
    splitRatio: 0.46,
    selectedHistoryId: null,
    selectedProject: null,
    skillsEnabledCount: 0,
    previewProjectId: "p1",
    previewThreadId: "t0",
    projectThreadLimits: {},
    hiddenPreviewThreads: new Set<string>(),
    projectShellUnavailable: undefined,
    projectShellFunctionsUnavailable: undefined,
    projectShellAction: null,
    onOpenProjectInEditor: vi.fn(),
    onOpenProjectDirectory: vi.fn(),
    onRemoveProject: vi.fn(),
    onSelectProject: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    ...extra,
  } as unknown as ComponentProps<typeof AppSidebar>["chrome"];
}

const client = {
  query: vi.fn(),
  command: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  bootstrap: vi.fn(),
  close: vi.fn(),
} as unknown as ComponentProps<typeof AppSidebar>["client"];

function renderSidebar({ preview, chrome, state }: {
  preview: boolean;
  chrome: ComponentProps<typeof AppSidebar>["chrome"];
  state: ComponentProps<typeof AppSidebar>["state"];
}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled><DockProvider definitions={WORKBENCH_PANELS}>
        <AppSidebar
          state={state}
          chrome={chrome}
          client={client}
          onRoute={() => undefined}
          onOpenAppUpdateDialog={() => undefined}
        />
      </DockProvider></PreviewModeProvider>
    </I18nProvider>,
  );
}

/** 按项目名找到项目行容器（项目头按钮的 .project 外层），用于限定 ⋯ 查询作用域——
    项目头与会话行各有同名「更多操作」⋯ 按钮。 */
function projectRow(name: string): HTMLElement {
  const row = screen.getByRole("button", { name }).closest(".project");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

// 目录项标签随平台变（fileManagerName），用同一套 i18n 字典推导期望值，跨平台稳定。
const fileManager = PLATFORM === "darwin" ? zh.shell.fileManagerMac : PLATFORM === "linux" ? zh.shell.fileManagerLinux : zh.shell.fileManagerWindows;
const explorerLabel = zh.shell.openInExplorer.replace("{fileManager}", fileManager);
const PROJECT_MENU_ITEMS = ["在外部编辑器中打开项目", "在终端中打开", explorerLabel];

describe("AppSidebar project row more menu", () => {
  it("opens the top-bar style project menu on the ⋯ button and routes the pick to that row's workspace", () => {
    const chrome = baseChrome();
    renderSidebar({ preview: false, chrome, state: baseState() });

    const more = within(projectRow("omp-studio")).getByRole("button", { name: "更多操作" });
    expect(more.hasAttribute("disabled")).toBe(false);
    fireEvent.click(more);

    // 顶栏项目菜单同款 shell 动作（弹层 portal 到 body）。
    const menu = screen.getByRole("menu");
    for (const label of PROJECT_MENU_ITEMS) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeTruthy();
    }
    // 合并上游 0.2.9 的项目行菜单后还带「新建会话」与「展开/折叠」。
    expect(within(menu).getByRole("menuitem", { name: "在此项目下新建会话" })).toBeTruthy();

    // 分隔线后的「移除项目」：破坏性动作 danger 样式，走 bridge 命令。
    const removeItem = within(menu).getByRole("menuitem", { name: "移除项目" }) as HTMLButtonElement;
    expect(removeItem.disabled).toBe(false);
    expect(removeItem.className).toContain("danger");
    fireEvent.click(removeItem);
    expect(chrome.onRemoveProject).toHaveBeenCalledWith(workspaceId);
    // 选择动作后弹层收起。
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("targets the clicked row's project, not the active one", () => {
    const chrome = baseChrome();
    const state = baseState([
      { workspaceId, name: "omp-studio", lastOpenedAt: "2026-08-25T00:00:00.000Z", active: true },
      { workspaceId: otherWorkspaceId, name: "other-project", lastOpenedAt: "2026-08-24T00:00:00.000Z", active: false },
    ]);
    renderSidebar({ preview: false, chrome, state });

    fireEvent.click(within(projectRow("other-project")).getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在外部编辑器中打开项目" }));
    // 非活动行的项目菜单仍指向该行的项目（激活由 AppShell 按回执处理）。
    expect(chrome.onOpenProjectInEditor).toHaveBeenCalledWith({ id: otherWorkspaceId, name: "other-project" });
    expect(chrome.onOpenProjectInEditor).not.toHaveBeenCalledWith({ id: workspaceId, name: "omp-studio" });
    expect(screen.queryByRole("menu")).toBeNull();

    // 活动行的菜单指向活动行自己。
    fireEvent.click(within(projectRow("omp-studio")).getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: explorerLabel }));
    expect(chrome.onOpenProjectDirectory).toHaveBeenCalledWith({ id: workspaceId, name: "omp-studio" });
  });

  it("disables editor / directory when the desktop shell functions are missing, keeps terminal usable", () => {
    const chrome = baseChrome({ projectShellFunctionsUnavailable: "仅桌面端可用" });
    renderSidebar({ preview: false, chrome, state: baseState() });

    fireEvent.click(within(projectRow("omp-studio")).getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu");
    for (const label of ["在外部编辑器中打开项目", explorerLabel]) {
      const item = within(menu).getByRole("menuitem", { name: label }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(item.getAttribute("data-tip")).toBe("仅桌面端可用");
    }
    const terminal = within(menu).getByRole("menuitem", { name: "在终端中打开" }) as HTMLButtonElement;
    expect(terminal.disabled).toBe(false);

    // 移除项目走 bridge 命令（workspace.remove），不依赖桌面 shell 函数，保持可用。
    const remove = within(menu).getByRole("menuitem", { name: "移除项目" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);

    // 终端项 = 先切到该项目再开终端页签（终端面板跟随当前项目）。
    fireEvent.click(terminal);
    expect(chrome.onSelectProject).toHaveBeenCalledWith({ id: workspaceId, name: "omp-studio" });
    expect(chrome.onOpenTerminalPanel).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps preview demo rows honest: all three project actions disabled", () => {
    const chrome = baseChrome();
    renderSidebar({ preview: true, chrome, state: baseState() });

    // 演示项目头按钮的可访问名会带上 git 脏文件数（如 "omp-web3"），用 p-name 文本节点定位；
    // ⋯ 再限定到项目头行内（展开的演示会话行也有同名 ⋯）。
    const headRow = screen.getByText("omp-web").closest(".project")?.querySelector(".project-head-row");
    expect(headRow).not.toBeNull();
    fireEvent.click(within(headRow as HTMLElement).getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu");
    for (const label of [...PROJECT_MENU_ITEMS, "移除项目"]) {
      const item = within(menu).getByRole("menuitem", { name: label }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(item.getAttribute("data-tip")).toBe("预览模式下不可用");
    }
    // 演示行点击不触达真实 shell 动作。
    expect(chrome.onOpenProjectInEditor).not.toHaveBeenCalled();
    expect(chrome.onOpenProjectDirectory).not.toHaveBeenCalled();
    expect(chrome.onOpenTerminalPanel).not.toHaveBeenCalled();
    expect(chrome.onRemoveProject).not.toHaveBeenCalled();
  });

  it("opens the same menu at the cursor on project head right-click", () => {
    const chrome = baseChrome();
    renderSidebar({ preview: false, chrome, state: baseState() });

    const head = screen.getByRole("button", { name: "omp-studio" }).closest(".project-head-row");
    expect(head).not.toBeNull();
    fireEvent.contextMenu(head as HTMLElement, { clientX: 40, clientY: 60 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: explorerLabel })).toBeTruthy();
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("60px");

    // 点目录项仍作用于该行的项目。
    fireEvent.click(within(menu).getByRole("menuitem", { name: explorerLabel }));
    expect(chrome.onOpenProjectDirectory).toHaveBeenCalledWith({ id: workspaceId, name: "omp-studio" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
