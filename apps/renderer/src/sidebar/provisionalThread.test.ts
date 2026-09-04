import { describe, expect, it } from "vitest";
import type { HistoryEntryId, SessionHistoryEntry, SessionId, ThreadId, WorkspaceId } from "@omp-studio/client-contract";
import {
  buildProvisionalProjectThread,
  isPlaceholderSessionTitle,
  projectHasSession,
  provisionalThreadForHistoryEntry,
  provisionalThreadTitle,
  reconcileProvisionalProjectThread,
  resolveProvisionalHistoryTitle,
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
    expect(sidebarThreadTitle(historyEntry("未命名会话"), provisional, "未命名会话")).toBe(provisional.title);
    expect(sidebarThreadTitle(historyEntry("Untitled session"), provisional, "Untitled session")).toBe(provisional.title);
    expect(sidebarThreadTitle(historyEntry("修复多项目会话同步"), provisional)).toBe("修复多项目会话同步");
    expect(sidebarThreadTitle(missingTitleEntry(), resolveProvisionalHistoryTitle(provisional, "手动标题"), "未命名会话")).toBe("手动标题");
  });

  it("recognizes only built-in empty title placeholders", () => {
    expect(isPlaceholderSessionTitle(undefined)).toBe(true);
    expect(isPlaceholderSessionTitle("未命名会话")).toBe(true);
    expect(isPlaceholderSessionTitle(" Untitled   session ")).toBe(true);
    expect(isPlaceholderSessionTitle("用户写的未命名会话修复")).toBe(false);
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

  it("freezes the first prompt title through send and identity-reset reports", () => {
    const context = {
      preview: false,
      sessionCreating: false,
      selectedHistoryId: null,
      untitledTitle: "未命名会话",
    } as const;
    const drafted = reconcileProvisionalProjectThread({}, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: true,
      title: "hi",
      running: false,
      submitted: false,
    }, context);
    const sending = reconcileProvisionalProjectThread(drafted, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: true,
      running: true,
      submitted: true,
    }, context);
    const identityReset = reconcileProvisionalProjectThread(sending, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: true,
      running: true,
      submitted: false,
    }, context);
    const laterDraft = reconcileProvisionalProjectThread(identityReset, {
      sessionId,
      workspaceId: provisional.workspaceId,
      visible: true,
      title: "第二条消息不能改标题",
      running: false,
      submitted: false,
    }, context);

    expect(sending[String(sessionId)]).toMatchObject({ title: "hi", submitted: true });
    expect(identityReset[String(sessionId)]).toMatchObject({ title: "hi", submitted: true });
    expect(laterDraft[String(sessionId)]).toMatchObject({ title: "hi", submitted: true });
    expect(resolveProvisionalHistoryTitle(laterDraft[String(sessionId)]!, "LLM 生成标题")).toMatchObject({
      title: "LLM 生成标题",
      titleState: "stable",
    });
  });
});
