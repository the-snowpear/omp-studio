/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ResidentSessionRow, ResidentSessionPhase, SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { AppSidebar } from "../App";
import { DockProvider } from "../dock/DockContext";
import { WORKBENCH_PANELS } from "../panels/registry";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";

vi.mock("../TerminalPane", () => ({ TerminalPane: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

const entryOf = (sessionId: string, title: string, pinned = false) => ({
  historyId: `history-${sessionId}`,
  threadId: `thread-${sessionId}`,
  environmentId: "environment-a",
  sessionId: sessionId as SessionId,
  title,
  startedAt: "2026-11-25T04:00:00.000Z",
  lastActiveAt: "2026-11-25T05:00:00.000Z",
  messageCount: 3,
  status: "active" as const,
  ...(pinned ? { pinned: true } : {}),
});

const resident = (sessionId: string, phase: ResidentSessionPhase): ResidentSessionRow => ({
  sessionId: sessionId as SessionId,
  workspaceId: "workspace-a" as WorkspaceId,
  phase,
  pendingMessages: 0,
  lastActivityAt: "2026-11-25T05:00:00.000Z",
});

function renderHistory(entries: ReturnType<typeof entryOf>[], phases: Record<string, ResidentSessionPhase>) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const workspaceId = "workspace-a" as WorkspaceId;
  const client = {
    query: vi.fn(),
    command: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    bootstrap: vi.fn(),
    close: vi.fn(),
  } as unknown as ComponentProps<typeof AppSidebar>["client"];
  const element = (currentPhases: Record<string, ResidentSessionPhase>) => {
    const state = {
      loading: false,
      route: "workbench",
      events: [],
      model: {
        workspaces: {
          workspaces: [{ workspaceId, name: "omp-studio", lastOpenedAt: "2026-11-25T00:00:00.000Z", active: true }],
          activeWorkspaceId: workspaceId,
        },
      },
      clientState: {
        connection: {
          phase: "initial",
          authorityId: null,
          authorityEpoch: null,
          runtime: null,
          runtimeEpoch: null,
          stateVersion: null,
          cursor: null,
          resyncRequired: false,
          resyncReason: null,
          surface: null,
          capabilityManifest: null,
          commandManifestHash: null,
          selected: null,
          contractVersion: null,
        },
        entities: {
          snapshot: null,
          telemetry: null,
          btw: null,
          residents: {
            residents: Object.entries(currentPhases).map(([sessionId, phase]) => resident(sessionId, phase)),
            generatedAt: "2026-11-25T05:00:00.000Z",
          },
        },
        interaction: { pending: null },
        commands: {},
        ui: {},
      },
    } as unknown as ComponentProps<typeof AppSidebar>["state"];
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
          model: { entries, total: entries.length },
        },
      },
      provisionalThreads: [],
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
      onSelectProvisionalThread: () => undefined,
      onArchiveProvisionalThread: () => undefined,
    } as unknown as ComponentProps<typeof AppSidebar>["chrome"];
    return (
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
      </I18nProvider>
    );
  };
  const rendered = render(element(phases));
  const rows = () => [...rendered.container.querySelectorAll(".thread-row")];
  return {
    titles: () => rows().map(row => row.querySelector(".t-scroll")?.textContent ?? ""),
    chips: () => rows().map(row => row.querySelector(".t-wait")?.textContent ?? ""),
    rowClasses: () => rows().map(row => row.className),
    setPhases: (next: Record<string, ResidentSessionPhase>) => rendered.rerender(element(next)),
  };
}

describe("AppSidebar recently-completed pinning", () => {
  it("pins a just-completed session above idle entries with a completed chip, below running ones", () => {
    // Host 顺序：A、B、C。B 先运行，结束后 10 分钟窗口内置顶于 idle 之上并带完成标记。
    const entries = [entryOf("session-a", "会话 A"), entryOf("session-b", "会话 B"), entryOf("session-c", "会话 C")];
    const api = renderHistory(entries, { "session-a": "idle", "session-b": "running", "session-c": "idle" });
    expect(api.titles()).toEqual(["会话 B", "会话 A", "会话 C"]);
    expect(api.chips()).toEqual(["", "", ""]);

    api.setPhases({ "session-a": "idle", "session-b": "idle", "session-c": "idle" });
    expect(api.titles()).toEqual(["会话 B", "会话 A", "会话 C"]);
    expect(api.chips()).toEqual(["本轮已结束", "", ""]);
    expect(api.rowClasses().some(cls => cls.includes("has-completed"))).toBe(true);
  });

  it("ranks a completed session below a running one", () => {
    const entries = [entryOf("session-a", "会话 A"), entryOf("session-b", "会话 B")];
    const api = renderHistory(entries, { "session-a": "idle", "session-b": "running" });
    api.setPhases({ "session-a": "running", "session-b": "idle" });
    // A 新回合开始（运行置顶、无标记），B 刚完成（完成置顶、带标记）。
    expect(api.titles()).toEqual(["会话 A", "会话 B"]);
    expect(api.chips()).toEqual(["", "本轮已结束"]);
  });

  it("pins a completed session above a user-pinned entry", () => {
    const entries = [entryOf("session-a", "会话 A", true), entryOf("session-b", "会话 B")];
    const api = renderHistory(entries, { "session-a": "idle", "session-b": "running" });
    api.setPhases({ "session-a": "idle", "session-b": "idle" });
    expect(api.titles()).toEqual(["会话 B", "会话 A"]);
    expect(api.chips()).toEqual(["本轮已结束", ""]);
  });

  it("clears the completed chip when the session starts a new turn", () => {
    const entries = [entryOf("session-a", "会话 A"), entryOf("session-b", "会话 B")];
    const api = renderHistory(entries, { "session-a": "idle", "session-b": "running" });
    api.setPhases({ "session-a": "idle", "session-b": "idle" });
    // B 完成后置顶，行序变为 [B, A]，标记跟着 B 走。
    expect(api.titles()).toEqual(["会话 B", "会话 A"]);
    expect(api.chips()).toEqual(["本轮已结束", ""]);

    api.setPhases({ "session-a": "idle", "session-b": "running" });
    expect(api.chips()).toEqual(["", ""]);
    expect(api.titles()).toEqual(["会话 B", "会话 A"]);
  });

  it("keeps the host order while nothing is completed or running", () => {
    const entries = [entryOf("session-a", "会话 A"), entryOf("session-b", "会话 B")];
    const api = renderHistory(entries, { "session-a": "idle", "session-b": "idle" });
    expect(api.titles()).toEqual(["会话 A", "会话 B"]);
    expect(api.chips()).toEqual(["", ""]);
  });
});
