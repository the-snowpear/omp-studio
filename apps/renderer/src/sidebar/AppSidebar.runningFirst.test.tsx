/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SessionId, WorkspaceId } from "@omp-studio/client-contract";
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

function renderHistory(entries: ReturnType<typeof entryOf>[], phases: Record<string, "idle" | "running">) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const workspaceId = "workspace-a" as WorkspaceId;
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
          residents: Object.entries(phases).map(([sessionId, phase]) => ({
            sessionId: sessionId as SessionId,
            workspaceId,
            phase,
            pendingMessages: 0,
            lastActivityAt: "2026-11-25T05:00:00.000Z",
          })),
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
  const client = {
    query: vi.fn(),
    command: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    bootstrap: vi.fn(),
    close: vi.fn(),
  } as unknown as ComponentProps<typeof AppSidebar>["client"];
  const rendered = render(
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
  const titles = [...rendered.container.querySelectorAll(".thread-row")].map(row => row.querySelector(".t-scroll")?.textContent ?? "");
  return { titles };
}

describe("AppSidebar running-session ordering", () => {
  it("pins the running session above pinned and idle entries", () => {
    // Host 顺序：置顶 a、普通 b、普通 c（按最后活跃时间）。
    const entries = [entryOf("session-a", "会话 A", true), entryOf("session-b", "会话 B"), entryOf("session-c", "会话 C")];
    const { titles } = renderHistory(entries, { "session-a": "idle", "session-b": "idle", "session-c": "running" });
    expect(titles).toEqual(["会话 C", "会话 A", "会话 B"]);
  });

  it("keeps the host order while nothing is running", () => {
    const entries = [entryOf("session-a", "会话 A", true), entryOf("session-b", "会话 B"), entryOf("session-c", "会话 C")];
    const { titles } = renderHistory(entries, { "session-a": "idle", "session-b": "idle", "session-c": "idle" });
    expect(titles).toEqual(["会话 A", "会话 B", "会话 C"]);
  });
});
