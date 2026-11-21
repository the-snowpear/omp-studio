/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryInput, SessionHistoryEntry, SessionHistoryReadModel, StudioClient } from "@omp-studio/client-contract";
import type { NativeHistoryContext } from "./history/NativeArchivePane";
import { HistoryPage } from "./HistoryPage";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import type { DeleteArchivedSessions } from "./history/sessionDeletion";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

function renderHistory(history: SessionHistoryReadModel, preview: boolean): void {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <HistoryPage history={history} onRoute={() => undefined} onSelectThread={() => undefined} />
      </PreviewModeProvider>
    </I18nProvider>,
  );
}

const ACTIVE_ENTRY = {
  historyId: "history-a" as never,
  threadId: "thread-a" as never,
  environmentId: "environment-1" as never,
  sessionId: "session-a" as never,
  title: "Deletable chat",
  startedAt: "2026-08-23T00:00:00.000Z",
  lastActiveAt: "2026-08-23T00:00:00.000Z",
  messageCount: 3,
  status: "active" as const,
} satisfies SessionHistoryEntry;

it("keeps lease status while filtering the catalog without repeated lease reads or lease commands", async () => {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const query = vi.fn(async (_kind: string, _input?: unknown) => ({ held: ["session-a"], unknown: [] })), command = vi.fn();
  const nativeContext: NativeHistoryContext = { sessionId: "live", available: true, capabilities: {
    profile: "limited", generatedAt: "2026-11-08T00:00:00.000Z", hash: "test", capabilities: [{ id: "session.lease.inspect", grade: "stable", version: 1, evidence: "test" }],
  } };
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><HistoryPage
    history={{ entries: [ACTIVE_ENTRY], total: 1 }} nativeContext={nativeContext} client={{ query, command, subscribe: () => () => {} } as unknown as StudioClient}
    onRoute={() => undefined} onSelectThread={() => undefined} /></PreviewModeProvider></I18nProvider>);
  await screen.findByText("使用中");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "No match" } });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Deletable" } });
  expect(screen.getByText("使用中")).toBeTruthy();
  expect(query.mock.calls.filter(([kind]) => kind === "session.lease.read")).toHaveLength(1);
  expect(query).toHaveBeenCalledWith("session.lease.read", { sessionId: "live", targetSessionIds: ["session-a"] });
  expect(command).not.toHaveBeenCalledWith("session.lease.inspect", expect.anything());
});

describe("HistoryPage session pins", () => {
  it("renders the localized fallback for missing and blank Host titles", () => {
    const { title: _title, ...activeWithoutTitle } = ACTIVE_ENTRY;
    const missingTitle = {
      ...activeWithoutTitle,
      historyId: "history-missing" as never,
    } satisfies SessionHistoryEntry;
    const blankTitle = {
      ...ACTIVE_ENTRY,
      historyId: "history-blank" as never,
      sessionId: "session-blank" as never,
      title: "   ",
    } satisfies SessionHistoryEntry;

    renderHistory({ entries: [missingTitle, blankTitle], total: 2 }, false);
    expect(screen.getAllByText("未命名会话")).toHaveLength(2);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "未命名会话" } });
    expect(screen.getAllByText("未命名会话")).toHaveLength(2);
  });

  it("renders the Host pin read model without changing the real row shape", () => {
    const entry = {
      historyId: "history-pinned" as never,
      threadId: "thread-pinned" as never,
      environmentId: "environment-1" as never,
      sessionId: "session-pinned" as never,
      title: "Pinned chat",
      startedAt: "2026-08-23T00:00:00.000Z",
      lastActiveAt: "2026-08-23T00:00:00.000Z",
      messageCount: 2,
      status: "active" as const,
      pinned: true,
    } satisfies SessionHistoryEntry;
    renderHistory({ entries: [entry], total: 1 }, false);
    expect(screen.getByText("Pinned chat")).toBeTruthy();
    expect(screen.getByRole("img", { name: "已置顶" })).toBeTruthy();
  });

  it("keeps preview pin rendering fixture-driven", () => {
    renderHistory({ entries: [], total: 0 }, true);
    expect(screen.getByRole("img", { name: "已置顶" })).toBeTruthy();
  });
});

describe("HistoryPage delete session (real mode)", () => {
  it.each([false, true])("deletes only the explicitly selected artifacts (cascade=%s)", async (cascade) => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
    const onDeleteSession = vi.fn(async () => true);
    render(
      <I18nProvider forcedLanguage="zh">
        <PreviewModeProvider switchEnabled>
          <HistoryPage
            history={{ entries: [ACTIVE_ENTRY], total: 1 }}
            onRoute={() => undefined}
            onSelectThread={() => undefined}
            onDeleteSession={onDeleteSession}
          />
        </PreviewModeProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除会话" }));

    const dialog = await screen.findByRole("dialog", { name: "删除会话确认" });
    expect(dialog).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "同时删除此会话的托管产物" });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    if (cascade) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));

    await vi.waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith(ACTIVE_ENTRY, cascade));
  });

  it("keeps the dialog open when deletion fails", async () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
    const onDeleteSession = vi.fn(async () => false);
    render(
      <I18nProvider forcedLanguage="zh">
        <PreviewModeProvider switchEnabled>
          <HistoryPage
            history={{ entries: [ACTIVE_ENTRY], total: 1 }}
            onRoute={() => undefined}
            onSelectThread={() => undefined}
            onDeleteSession={onDeleteSession}
          />
        </PreviewModeProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除会话" }));
    await screen.findByRole("dialog", { name: "删除会话确认" });
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));

    await vi.waitFor(() => expect(onDeleteSession).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "删除会话确认" })).toBeTruthy();
  });
});

describe("HistoryPage delete session (preview mode)", () => {
  it("walks the demo confirm flow without calling the Host callback", async () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
    const onDeleteSession = vi.fn(async () => true);
    render(
      <I18nProvider forcedLanguage="zh">
        <PreviewModeProvider switchEnabled>
          <HistoryPage
            history={{ entries: [], total: 0 }}
            onRoute={() => undefined}
            onSelectThread={() => undefined}
            onDeleteSession={onDeleteSession}
          />
        </PreviewModeProvider>
      </I18nProvider>,
    );

    fireEvent.click((await screen.findAllByRole("button", { name: "更多操作" }))[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除会话" }));
    await screen.findByRole("dialog", { name: "删除会话确认" });
    fireEvent.click(screen.getByRole("button", { name: "停止并删除" }));

    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(await screen.findByText(/演示 · 已删除/)).toBeTruthy();
  });
});

it("keeps only visible archive selections and preserves confirmation through zh → en → zh", async () => {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const onDeleteArchivedSessions = vi.fn<DeleteArchivedSessions>();
  const view = (lang: "zh" | "en") => (
    <I18nProvider forcedLanguage={lang}>
      <PreviewModeProvider switchEnabled>
        <HistoryPage onRoute={() => undefined} onSelectThread={() => undefined} onDeleteArchivedSessions={onDeleteArchivedSessions} />
      </PreviewModeProvider>
    </I18nProvider>
  );
  const { rerender } = render(view("zh"));
  fireEvent.click(screen.getByRole("button", { name: "已归档" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "全选当前结果" }));
  expect(screen.getByText("已选 2 条")).toBeTruthy();
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "session" } });
  expect(screen.getByText("已选 1 条")).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  expect((screen.getByRole("checkbox", { name: "全选当前结果" }) as HTMLInputElement).indeterminate).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
  expect(screen.getByRole("dialog").textContent).toContain("所选 1 条");
  expect(document.activeElement).toBe(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  rerender(view("en"));
  expect(screen.getByRole("dialog", { name: "Delete archived sessions" }).textContent).toContain("1 selected");
  rerender(view("zh"));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除所选" }));
  await screen.findByText("已删除 1 条");
  expect(screen.getByRole("checkbox", { name: /对比 v0.8.0/ })).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /重构 session/ })).toBeNull();
  expect(onDeleteArchivedSessions).not.toHaveBeenCalled();
});

it("loads archive pages independently and keeps only failures selected after a partial batch", async () => {
  const archived = (id: string, title: string): SessionHistoryEntry => ({
    ...ACTIVE_ENTRY,
    historyId: id as never,
    threadId: id as never,
    sessionId: id as never,
    title,
    status: "archived",
  });
  const deleted = archived("archived-a", "Old build");
  const failed = archived("archived-b", "Old review");
  const firstPage = [deleted, ...Array.from({ length: 49 }, (_, index) => archived(`archive-${index}`, `Record ${index}`))];
  const query = vi.fn(async (name: string, input: QueryInput<"history.list">) => {
    if (name !== "history.list") return {};
    return { entries: input.offset ? [failed] : firstPage, total: 51 };
  });
  const onDeleteArchivedSessions = vi.fn<DeleteArchivedSessions>(async (_entries, onProgress) => {
    onProgress(1);
    return [
      { threadId: deleted.threadId, status: "deleted", cleanupWarning: "Native history is still present." },
      { threadId: failed.threadId, status: "failed", reason: "File was locked." },
    ];
  });
  const client = { query, subscribe: () => () => {} } as unknown as StudioClient;
  const view = (deletedSessions?: ReadonlySet<string>) => (
    <I18nProvider forcedLanguage="en">
      <HistoryPage client={client} history={{ entries: [ACTIVE_ENTRY], total: 1 }} onRoute={() => undefined}
        onSelectThread={() => undefined} onDeleteArchivedSessions={onDeleteArchivedSessions}
        {...(deletedSessions ? { deletedSessions } : {})} />
    </I18nProvider>
  );
  const { rerender } = render(view());
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Old build/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Old review/ }));
  expect(query).toHaveBeenCalledWith("history.list", { status: "archived", limit: 50, offset: 50 });
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete selected" }));
  await screen.findByText(/File was locked/);
  rerender(view(new Set([deleted.historyId])));
  expect(onDeleteArchivedSessions.mock.calls[0]?.[0]).toEqual([deleted, failed]);
  expect(screen.getByText("1 deleted")).toBeTruthy();
  expect(screen.getByText(/Native history is still present/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /Old build/ })).toBeNull();
  expect((screen.getByRole("checkbox", { name: /Old review/ }) as HTMLInputElement).checked).toBe(true);
});
