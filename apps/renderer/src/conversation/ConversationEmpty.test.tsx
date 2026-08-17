import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentId, HistoryEntryId, SessionHistoryEntry, StudioClient, ThreadId, TokenUsageReadModel } from "@omp-studio/client-contract";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { __resetOperatorProfileForTests } from "../settings/operatorProfile";
import { ConversationEmpty } from "./ConversationEmpty";
import { ConversationPane } from "./ConversationPane";
import { resetConversation } from "./conversationViewModel";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  __resetOperatorProfileForTests(null);
});

function renderEmpty(options: {
  preview?: boolean;
  client?: StudioClient;
  history?: { entries: SessionHistoryEntry[]; total: number };
  onSelectThread?: (entry: SessionHistoryEntry) => void;
  onSelectPreviewThread?: (id: string) => void;
  onOpenHistory?: () => void;
}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === true ? "1" : "0");
  const onOpenHistory = options.onOpenHistory ?? vi.fn();
  const onSelectThread = options.onSelectThread ?? vi.fn();
  const onSelectPreviewThread = options.onSelectPreviewThread ?? vi.fn();
  render(
    <PreviewModeProvider>
      <ConversationEmpty
        {...(options.client === undefined ? {} : { client: options.client })}
        {...(options.history === undefined ? {} : { history: options.history })}
        projectName="omp-studio"
        onSelectThread={onSelectThread}
        onSelectPreviewThread={onSelectPreviewThread}
        onOpenHistory={onOpenHistory}
      />
    </PreviewModeProvider>,
  );
  return { onOpenHistory, onSelectThread, onSelectPreviewThread };
}

function fakeClient(input: { usage?: TokenUsageReadModel; history?: { entries: SessionHistoryEntry[]; total: number } } = {}): StudioClient & { readonly calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    query: async (name: string) => {
      calls.push(name);
      if (name === "usage.get") {
        return input.usage ?? { generatedAt: "2026-08-17T00:00:00.000Z", days: [], models: [], byModel: [], hours: [] };
      }
      if (name === "history.list") {
        return input.history ?? { entries: [], total: 0 };
      }
      throw new Error(name);
    },
  };
  return client as unknown as StudioClient & { readonly calls: string[] };
}

describe("ConversationEmpty", () => {
  it("preview uses fixture recents and does not query Host usage or history", async () => {
    const client = fakeClient();
    const { onSelectPreviewThread, onSelectThread } = renderEmpty({ preview: true, client });
    expect(screen.getByRole("heading", { name: /Studio/ })).toBeTruthy();
    expect(screen.getByText("演示")).toBeTruthy();
    expect(screen.getByText(/近 1 年/)).toBeTruthy();
    expect(document.querySelectorAll(".ce-hc").length).toBeGreaterThanOrEqual(365);
    expect(screen.getByText("跟踪上游 pi-web 更新到 omp-web")).toBeTruthy();
    expect(screen.getByText("Mermaid 渲染优化与全屏缩放拖拽")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /跟踪上游 pi-web 更新到 omp-web/ }));
    expect(onSelectPreviewThread).toHaveBeenCalledWith("t1");
    expect(onSelectThread).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(client.calls).toEqual([]);
  });

  it("real mode opens a history row and does not invent preview titles", async () => {
    const entry: SessionHistoryEntry = {
      historyId: "hist-1" as HistoryEntryId,
      threadId: "thread-1" as ThreadId,
      environmentId: "env-1" as EnvironmentId,
      title: "修复热力图空态",
      startedAt: "2026-08-17T10:00:00.000Z",
      lastActiveAt: "2026-08-17T11:00:00.000Z",
      messageCount: 4,
      status: "active",
    };
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const client = fakeClient({
      usage: {
        generatedAt: today.toISOString(),
        days: [{ date: dateKey, totalTokens: 2400 }],
        models: [],
        byModel: [],
        hours: [],
      },
    });
    const { onSelectThread, onSelectPreviewThread, onOpenHistory } = renderEmpty({
      client,
      history: { entries: [entry], total: 1 },
    });
    expect(screen.queryByText("跟踪上游 pi-web 更新到 omp-web")).toBeNull();
    expect(screen.getByText("修复热力图空态")).toBeTruthy();
    expect(screen.getByText("omp-studio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /修复热力图空态/ }));
    expect(onSelectThread).toHaveBeenCalledWith(entry);
    expect(onSelectPreviewThread).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "全部历史" }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(client.calls).toContain("usage.get"));
    expect(client.calls).not.toContain("history.list");
    expect(screen.getByText(/2.4k/)).toBeTruthy();
  });

  it("real mode with no history stays an honest empty list", () => {
    renderEmpty({ history: { entries: [], total: 0 } });
    expect(screen.getByText("暂无最近对话")).toBeTruthy();
    expect(screen.queryByText("跟踪上游 pi-web 更新到 omp-web")).toBeNull();
  });
});

describe("ConversationPane welcome slot", () => {
  it("renders the welcome surface instead of the default empty shell", () => {
    const state = resetConversation(1, null, "ready");
    render(
      <ConversationPane
        snapshot={{ state, rows: [], demo: false, loadingOlder: false, identityKey: "welcome" }}
        onLoadOlder={() => undefined}
        welcome={<div>欢迎区</div>}
      />,
    );
    expect(screen.getByText("欢迎区")).toBeTruthy();
    expect(screen.queryByText("开始一段对话")).toBeNull();
    expect(screen.queryByText("对话不可用")).toBeNull();
  });

  it("keeps the welcome surface when forceWelcome ends but the transcript is still empty", () => {
    const state = resetConversation(1, null, "ready");
    const { rerender } = render(
      <ConversationPane
        snapshot={{ state, rows: [], demo: false, loadingOlder: false, identityKey: "welcome-a" }}
        onLoadOlder={() => undefined}
        forceWelcome
        welcome={<div>欢迎区</div>}
      />,
    );
    expect(screen.getByText("欢迎区")).toBeTruthy();
    rerender(
      <ConversationPane
        snapshot={{ state, rows: [], demo: false, loadingOlder: false, identityKey: "welcome-b" }}
        onLoadOlder={() => undefined}
        welcome={<div>欢迎区</div>}
      />,
    );
    expect(screen.getByText("欢迎区")).toBeTruthy();
    expect(screen.queryByText("开始一段对话")).toBeNull();
  });

  it("forceWelcome keeps the welcome surface even when transcript rows exist", () => {
    const state = resetConversation(1, null, "ready");
    render(
      <ConversationPane
        snapshot={{
          state,
          rows: [{ type: "user", itemId: "u1", createdAt: "2026-08-17T00:00:00.000Z", text: "旧会话" }],
          demo: false,
          loadingOlder: false,
          identityKey: "force-welcome",
        }}
        onLoadOlder={() => undefined}
        forceWelcome
        welcome={<div>欢迎区</div>}
      />,
    );
    expect(screen.getByText("欢迎区")).toBeTruthy();
    expect(screen.queryByText("旧会话")).toBeNull();
  });
});
