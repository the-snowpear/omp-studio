/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHistoryEntry, SessionHistoryReadModel, StudioClient } from "@omp-studio/client-contract";
import type { NativeHistoryContext } from "./history/NativeArchivePane";
import { HistoryPage } from "./HistoryPage";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

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
  await screen.findByText("使用中 / In use");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "No match" } });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Deletable" } });
  expect(screen.getByText("使用中 / In use")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));

    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(await screen.findByText(/演示：已删除/)).toBeTruthy();
  });
});
