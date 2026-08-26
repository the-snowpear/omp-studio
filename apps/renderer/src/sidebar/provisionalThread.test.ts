import { describe, expect, it } from "vitest";
import type { HistoryEntryId, SessionHistoryEntry, SessionId, ThreadId, WorkspaceId } from "@omp-studio/client-contract";
import {
  buildProvisionalProjectThread,
  projectHasSession,
  provisionalThreadForHistoryEntry,
  provisionalThreadTitle,
  provisionalSessionTitleEnsureKey,
  reconcileProvisionalProjectThread,
  resolveProvisionalHistoryTitle,
  shouldEnsureProvisionalSessionTitle,
  sidebarThreadTitle,
  type ProvisionalProjectThread,
} from "./provisionalThread";

const sessionId = "session-new" as SessionId;
const provisional: ProvisionalProjectThread = {
  workspaceId: "workspace-a" as WorkspaceId,
  sessionId,
  title: "请帮我检查多项目会话切换",
  titleState: "missing",
  running: true,
  submitted: true,
};

function historyEntry(title: string): SessionHistoryEntry {
  return {
    historyId: "history-new" as HistoryEntryId,
    threadId: "thread-new" as ThreadId,
    environmentId: "environment-test" as SessionHistoryEntry["environmentId"],
    sessionId,
    title,
    startedAt: "2026-08-24T00:00:00.000Z",
    lastActiveAt: "2026-08-24T00:00:00.000Z",
    messageCount: 1,
    status: "active",
  };
}

function missingTitleEntry(): SessionHistoryEntry {
  const { title: _title, ...entry } = historyEntry("catalog fallback");
  return entry;
}

describe("provisional project thread", () => {
  it("normalizes whitespace and takes the first 20 Unicode code points", () => {
    expect(provisionalThreadTitle("  一二三\n四五   六七八九十一二三四五六七八九十甲乙  ")).toBe("一二三 四五 六七八九十一二三四五六七八");
    expect(provisionalThreadTitle("😀".repeat(21))).toBe("😀".repeat(20));
    expect(provisionalThreadTitle(" \n\t ")).toBeUndefined();
  });

  it("uses explicit missing-title state instead of a localized catalog value", () => {
    expect(sidebarThreadTitle(missingTitleEntry(), provisional, "未命名会话")).toBe(provisional.title);
    expect(sidebarThreadTitle(historyEntry("修复多项目会话同步"), provisional)).toBe("修复多项目会话同步");
    expect(sidebarThreadTitle(missingTitleEntry(), resolveProvisionalHistoryTitle(provisional, "手动标题"), "未命名会话")).toBe("手动标题");
  });

  it("detects when persisted history has taken over the transient row", () => {
    expect(projectHasSession([], sessionId)).toBe(false);
    expect(projectHasSession([historyEntry("catalog fallback")], sessionId)).toBe(true);
  });

  it("matches a sidebar title by session while workspace membership is catching up", () => {
    const staleWorkspaceThread = {
      ...provisional,
      workspaceId: "workspace-stale" as WorkspaceId,
    };

    expect(provisionalThreadForHistoryEntry([staleWorkspaceThread], missingTitleEntry())).toBe(staleWorkspaceThread);
    expect(sidebarThreadTitle(
      missingTitleEntry(),
      provisionalThreadForHistoryEntry([staleWorkspaceThread], missingTitleEntry()),
      "未命名会话",
    )).toBe(provisional.title);
  });

  it("shows only a draft/submitted fresh session, never a blank new-session click", () => {
    const base = {
      preview: false,
      sessionCreating: false,
      selectedHistoryId: null,
      sessionId,
      workspaceId: provisional.workspaceId,
      untitledTitle: "未命名会话",
    };
    expect(buildProvisionalProjectThread({
      ...base,
      composer: { visible: false, running: false, submitted: false },
    })).toBeUndefined();
    expect(buildProvisionalProjectThread({
      ...base,
      composer: { visible: true, title: "修复侧栏", running: false, submitted: false },
    })).toEqual({ ...provisional, title: "修复侧栏", running: false, submitted: false });
    expect(buildProvisionalProjectThread({
      ...base,
      selectedHistoryId: "history-existing",
      composer: { visible: true, title: "不应新增", running: false, submitted: false },
    })).toBeUndefined();
    expect(buildProvisionalProjectThread({
      ...base,
      sessionCreating: true,
      composer: { visible: true, title: "等待新会话", running: false, submitted: false },
    })).toBeUndefined();
  });

  it("does not let a late workbench update revive an archived provisional row", () => {
    const current = { [String(sessionId)]: provisional };
    const next = reconcileProvisionalProjectThread(current, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: true,
      title: provisional.title,
      running: false,
      submitted: true,
    }, {
      preview: false,
      sessionCreating: false,
      selectedHistoryId: null,
      untitledTitle: "未命名会话",
      excludedSessionIds: new Set([String(sessionId)]),
    });

    expect(next).toEqual({});
  });

  it("keeps the prompt fallback while switching a persisted missing-title session", () => {
    const current = { [String(sessionId)]: provisional };
    const switching = reconcileProvisionalProjectThread(current, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: false,
      running: false,
      submitted: false,
    }, {
      preview: false,
      sessionCreating: false,
      selectedHistoryId: "history-new",
      untitledTitle: "未命名会话",
    });
    expect(switching).toBe(current);

    const draftOnly = { [String(sessionId)]: { ...provisional, submitted: false } };
    const clearedFreshDraft = reconcileProvisionalProjectThread(draftOnly, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: false,
      running: false,
      submitted: false,
    }, {
      preview: false,
      sessionCreating: false,
      selectedHistoryId: null,
      untitledTitle: "未命名会话",
    });
    expect(clearedFreshDraft).toEqual({});
  });

  it("keeps an accepted prompt fallback during the pre-selection resume window", () => {
    const current = { [String(sessionId)]: provisional };
    const next = reconcileProvisionalProjectThread(current, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: false,
      running: false,
      submitted: false,
    }, {
      preview: false,
      sessionCreating: false,
      selectedHistoryId: null,
      untitledTitle: "未命名会话",
    });

    expect(next).toBe(current);
  });

  it("only ensures an idle, untitled submitted session", () => {
    const input = {
      preview: false,
      runtimeConnected: true,
      provisional: { ...provisional, running: false },
      snapshot: {
        sessionId,
        isStreaming: false,
        isCompacting: false,
      },
    } as const;

    expect(shouldEnsureProvisionalSessionTitle(input)).toBe(true);
    expect(shouldEnsureProvisionalSessionTitle({ ...input, preview: true })).toBe(false);
    expect(shouldEnsureProvisionalSessionTitle({ ...input, runtimeConnected: false })).toBe(false);
    expect(shouldEnsureProvisionalSessionTitle({
      ...input,
      provisional: { ...input.provisional, titleState: "stable" },
    })).toBe(false);
  });

  it("does not replace a manual/native title or race an active turn", () => {
    const input = {
      preview: false,
      runtimeConnected: true,
      provisional: { ...provisional, running: false },
      snapshot: { sessionId, isStreaming: false, isCompacting: false },
    } as const;

    expect(shouldEnsureProvisionalSessionTitle({
      ...input,
      snapshot: { ...input.snapshot, sessionTitle: "手动标题", sessionTitleSource: "user" },
    })).toBe(false);
    expect(shouldEnsureProvisionalSessionTitle({
      ...input,
      snapshot: { ...input.snapshot, sessionTitle: "Native title", sessionTitleSource: "auto" },
    })).toBe(false);
    expect(shouldEnsureProvisionalSessionTitle({
      ...input,
      snapshot: { ...input.snapshot, isStreaming: true },
    })).toBe(false);
    expect(shouldEnsureProvisionalSessionTitle({
      ...input,
      snapshot: { ...input.snapshot, isCompacting: true },
    })).toBe(false);
  });

  it("allows only one in-flight attempt per session", () => {
    const key = provisionalSessionTitleEnsureKey(sessionId);
    const input = {
      preview: false,
      runtimeConnected: true,
      provisional: { ...provisional, running: false },
      snapshot: { sessionId, isStreaming: false, isCompacting: false },
      inFlightSessionIds: new Set([key]),
    } as const;

    expect(shouldEnsureProvisionalSessionTitle(input)).toBe(false);
    expect(shouldEnsureProvisionalSessionTitle({
      ...input,
      inFlightSessionIds: new Set<string>(),
    })).toBe(true);
  });
});
