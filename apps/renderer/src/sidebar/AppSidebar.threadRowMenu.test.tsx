/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { EnvironmentId, HistoryEntryId, SessionHistoryEntry, SessionId, ThreadId, WorkspaceId } from "@omp-studio/client-contract";
import { AppSidebar } from "../App";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";

vi.mock("../TerminalPane", () => ({ TerminalPane: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

const workspaceId = "workspace-a" as WorkspaceId;

const historyEntry: SessionHistoryEntry = {
  historyId: "history-1" as HistoryEntryId,
  threadId: "thread-1" as ThreadId,
  environmentId: "env-1" as EnvironmentId,
  sessionId: "session-1" as SessionId,
  title: "已有会话",
  startedAt: "2026-08-25T00:00:00.000Z",
  lastActiveAt: "2026-08-25T00:00:00.000Z",
  messageCount: 2,
  status: "active",
};

function baseState() {
  return {
    loading: false,
    route: "workbench",
    events: [],
    model: {
      workspaces: {
        workspaces: [{
          workspaceId,
          name: "omp-studio",
          lastOpenedAt: "2026-08-25T00:00:00.000Z",
          active: true,
        }],
        activeWorkspaceId: workspaceId,
      },
    },
  } as ComponentProps<typeof AppSidebar>["state"];
}

function baseChrome() {
  return {
    collapsed: false,
    skillsOpen: false,
    explorerOpen: false,
    projectListExpanded: true,
    expandedProjects: new Set([String(workspaceId)]),
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
      <PreviewModeProvider switchEnabled>
        <AppSidebar
          state={state}
          chrome={chrome}
          client={client}
          onRoute={() => undefined}
          onOpenAppUpdateDialog={() => undefined}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
}

describe("AppSidebar thread row more menu", () => {
  it("opens the top-bar thread actions on a history row and routes the pick to onThreadRowAction", () => {
    const onThreadRowAction = vi.fn();
    const chrome = {
      ...baseChrome(),
      projectHistories: {
        [String(workspaceId)]: {
          status: "ready",
          requestedLimit: 6,
          model: { entries: [historyEntry], total: 1 },
        },
      },
      onThreadRowAction,
    } as unknown as ComponentProps<typeof AppSidebar>["chrome"];
    // 行级会话动作与顶栏同语义：需要真实 Runtime 快照才可用。
    const state = {
      ...baseState(),
      clientState: { connection: {}, interaction: {}, conversation: {}, entities: { snapshot: { sessionId: "session-other" } } },
    } as ComponentProps<typeof AppSidebar>["state"];
    renderSidebar({ preview: false, chrome, state });

    // 行按钮可访问名 = 标题 + 相对时间，用正则匹配标题；项目头也有同名 ⋯，必须先锁定行。
    const row = screen.getByRole("button", { name: new RegExp(historyEntry.title as string) }).closest(".thread-row");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "更多操作" }));

    // 顶栏「对话选项」同款七项，弹层 portal 到 body。
    const menu = screen.getByRole("menu");
    for (const label of ["重命名对话", "Fork 当前对话", "Handoff 到新对话", "Compact 当前上下文", "导出对话", "会话历史", "归档会话"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeTruthy();
    }

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Fork 当前对话" }));
    expect(onThreadRowAction).toHaveBeenCalledWith(historyEntry, workspaceId, "fork");
    // 选择动作后弹层收起。
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps preview demo rows honest: session actions disabled, archive stays local", () => {
    const onArchivePreviewThread = vi.fn();
    const chrome = {
      ...baseChrome(),
      onArchivePreviewThread,
    } as unknown as ComponentProps<typeof AppSidebar>["chrome"];
    renderSidebar({ preview: true, chrome, state: baseState() });

    const row = screen.getByRole("button", { name: /新建对话（空白）/ }).closest(".thread-row");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "更多操作" }));

    const menu = screen.getByRole("menu");
    const fork = within(menu).getByRole("menuitem", { name: "Fork 当前对话" }) as HTMLButtonElement;
    expect(fork.disabled).toBe(true);
    expect(fork.getAttribute("data-tip")).toBe("预览模式下不可用");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "归档会话" }));
    expect(onArchivePreviewThread).toHaveBeenCalledWith("t0");
  });

  it("opens the same menu at the cursor on row right-click", () => {
    const onThreadRowAction = vi.fn();
    const chrome = {
      ...baseChrome(),
      projectHistories: {
        [String(workspaceId)]: {
          status: "ready",
          requestedLimit: 6,
          model: { entries: [historyEntry], total: 1 },
        },
      },
      onThreadRowAction,
    } as unknown as ComponentProps<typeof AppSidebar>["chrome"];
    const state = {
      ...baseState(),
      clientState: { connection: {}, interaction: {}, conversation: {}, entities: { snapshot: { sessionId: "session-other" } } },
    } as ComponentProps<typeof AppSidebar>["state"];
    renderSidebar({ preview: false, chrome, state });

    const row = screen.getByRole("button", { name: new RegExp(historyEntry.title as string) }).closest(".thread-row");
    expect(row).not.toBeNull();
    // ⋯ 未打开时右键行：菜单贴光标弹出，原生菜单被抑制（preventDefault）。
    fireEvent.contextMenu(row as HTMLElement, { clientX: 40, clientY: 60 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "重命名对话" })).toBeTruthy();
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("60px");

    // 右键另一行（唯一行则以同 id 重开）：先关旧层再开新层，不残留双弹层。
    fireEvent.contextMenu(row as HTMLElement, { clientX: 44, clientY: 88 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu").style.top).toBe("88px");

    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Fork 当前对话" }));
    expect(onThreadRowAction).toHaveBeenCalledWith(historyEntry, workspaceId, "fork");
  });
});
