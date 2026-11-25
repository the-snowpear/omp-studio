/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ResidentSessionRow, SessionId, WorkspaceId } from "@omp-studio/client-contract";
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

const entryOf = (sessionId: string, title: string) => ({
  historyId: `history-${sessionId}`,
  threadId: `thread-${sessionId}`,
  environmentId: "environment-a",
  sessionId: sessionId as SessionId,
  title,
  startedAt: "2026-11-25T04:00:00.000Z",
  lastActiveAt: "2026-11-25T05:00:00.000Z",
  messageCount: 3,
  status: "active" as const,
});

function renderHistory(entries: ReturnType<typeof entryOf>[], residents: ResidentSessionRow[], snapshot?: { sessionId: SessionId; sessionTitle: string; sessionTitleSource?: "user" | "auto" }) {
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
        ...(snapshot === undefined ? {} : { snapshot }),
        telemetry: null,
        btw: null,
        residents: { residents, generatedAt: "2026-11-25T05:00:00.000Z" },
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

const resident = (sessionId: string, title?: string, titleSource?: "user" | "auto"): ResidentSessionRow => ({
  sessionId: sessionId as SessionId,
  workspaceId: "workspace-a" as WorkspaceId,
  phase: "idle",
  pendingMessages: 0,
  ...(title === undefined ? {} : { title }),
  ...(titleSource === undefined ? {} : { titleSource }),
  lastActivityAt: "2026-11-25T05:00:00.000Z",
});

describe("AppSidebar resident-title projection", () => {
  it("shows a background session's resident title over a stale placeholder row", () => {
    // 后台会话的语义标题只经 residents 通道到达（选中会话才走 snapshot）；
    // 侧栏行必须即时换标题，而不是等用户切回该会话触发重查。
    const entries = [entryOf("session-a", "未命名会话"), entryOf("session-b", "会话 B")];
    const { titles } = renderHistory(entries, [resident("session-a", "📨 RATE: Telegram 限频", "auto"), resident("session-b")]);
    expect(titles).toEqual(["📨 RATE: Telegram 限频", "会话 B"]);
  });

  it("keeps the row title while the resident only reports a placeholder auto title", () => {
    const entries = [entryOf("session-a", "会话 A")];
    const { titles } = renderHistory(entries, [resident("session-a", "未命名会话", "auto")]);
    expect(titles).toEqual(["会话 A"]);
  });

  it("prefers a user-sourced resident title over the catalog title", () => {
    const entries = [entryOf("session-a", "会话 A")];
    const { titles } = renderHistory(entries, [resident("session-a", "用户重命名", "user")]);
    expect(titles).toEqual(["用户重命名"]);
  });

  it("keeps the live snapshot title above the resident roster for the selected session", () => {
    const entries = [entryOf("session-a", "未命名会话")];
    const { titles } = renderHistory(
      entries,
      [resident("session-a", "RESIDENT 标题", "auto")],
      { sessionId: "session-a" as SessionId, sessionTitle: "LIVE 标题", sessionTitleSource: "auto" },
    );
    expect(titles).toEqual(["LIVE 标题"]);
  });
});
