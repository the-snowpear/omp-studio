/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHistoryEntry, SessionHistoryReadModel } from "@omp-studio/client-contract";
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
  it("opens the more menu, confirms, and calls onDeleteSession with the entry", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));

    await vi.waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith(ACTIVE_ENTRY));
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
