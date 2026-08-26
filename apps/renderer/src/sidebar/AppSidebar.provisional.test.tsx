/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { AppSidebar } from "../App";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";

vi.mock("../TerminalPane", () => ({ TerminalPane: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

function renderProvisionalThread(submitted = true) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const workspaceId = "workspace-a" as WorkspaceId;
  const thread = {
    workspaceId,
    sessionId: "session-streaming" as SessionId,
    title: "正在流式输出的会话",
    titleState: "missing" as const,
    running: true,
    submitted,
  };
  const onSelectProvisionalThread = vi.fn();
  const onArchiveProvisionalThread = vi.fn();
  const state = {
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
  const chrome = {
    collapsed: false,
    skillsOpen: false,
    explorerOpen: false,
    projectListExpanded: true,
    expandedProjects: new Set([String(workspaceId)]),
    projectHistories: {
      [String(workspaceId)]: {
        status: "ready",
        requestedLimit: 6,
        model: { entries: [], total: 0 },
      },
    },
    provisionalThreads: [thread],
    activeProvisionalSessionId: undefined,
    theme: "light",
    sidebarWidth: 272,
    splitRatio: 0.46,
    selectedHistoryId: null,
    selectedProject: null,
    skillsEnabledCount: 0,
    previewProjectId: "p0",
    previewThreadId: "t0",
    projectThreadLimits: {},
    hiddenPreviewThreads: new Set<string>(),
    onSelectProvisionalThread,
    onArchiveProvisionalThread,
  } as unknown as ComponentProps<typeof AppSidebar>["chrome"];
  const client = {
    query: vi.fn(),
    command: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    bootstrap: vi.fn(),
    close: vi.fn(),
  } as unknown as ComponentProps<typeof AppSidebar>["client"];

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
  return { thread, onSelectProvisionalThread, onArchiveProvisionalThread };
}

describe("AppSidebar provisional session row", () => {
  it("lets a submitted streaming row be selected and archived before history takes over", () => {
    const { thread, onSelectProvisionalThread, onArchiveProvisionalThread } = renderProvisionalThread();

    const sessionButton = screen.getByRole("button", { name: thread.title });
    fireEvent.click(sessionButton);
    expect(onSelectProvisionalThread).toHaveBeenCalledWith(thread);

    const row = sessionButton.closest(".thread-row");
    expect(row).not.toBeNull();
    // ⋯ 已接入顶栏同款菜单：按钮可点（弹层交互另测），不再是被禁用的占位。
    expect((within(row as HTMLElement).getByRole("button", { name: "更多操作" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "归档会话" }));
    expect(onArchiveProvisionalThread).toHaveBeenCalledWith(thread);
  });

  it("lets an unsent draft be selected without exposing persisted-session actions", () => {
    const { thread, onSelectProvisionalThread } = renderProvisionalThread(false);

    fireEvent.click(screen.getByRole("button", { name: thread.title }));
    expect(onSelectProvisionalThread).toHaveBeenCalledWith(thread);
    expect(screen.queryByRole("button", { name: "归档会话" })).toBeNull();
  });
});
