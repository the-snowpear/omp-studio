import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PreviewChanges } from "../preview/surfaces";
import { SessionChanges } from "./SessionChanges";
import type { TimelineRow } from "./conversationViewModel";

const initialUrl = window.location.href;
beforeEach(() => { vi.spyOn(document, "hidden", "get").mockReturnValue(false); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState({}, "", initialUrl); });
const rows: readonly TimelineRow[] = [{
  type: "assistant", itemId: "turn", createdAt: "2026-11-12T12:00:00.000Z", status: "completed",
  segments: [{ type: "batch", key: "tools", tools: [{
    toolCallId: "edit", toolName: "edit", status: "failed", arguments: { path: "src/input.ts", diff: "+1|not written" },
    result: { type: "toolResult", toolCallId: "edit", isError: true, data: { perFileResults: [
      { path: "src/applied.ts", diff: "-1|before\n+1|after" },
      { path: "src/rejected.ts", isError: true, diff: "+1|not written" },
    ] } },
  }] }],
}];

it.each([320, 900])("shows the same native applied-only review and partial warning in the narrow/wide render path (%s)", width => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  render(<I18nProvider forcedLanguage="zh"><SessionChanges rows={rows} /></I18nProvider>);
  expect(screen.getByRole("alert").textContent).toContain("原生结果确认已落盘");
  expect(screen.queryByText("rejected.ts")).toBeNull();
  expect(screen.queryByText("input.ts")).toBeNull();
  if (width < 820) fireEvent.click(screen.getByRole("button", { name: /applied\.ts/ }));
  else expect(screen.getByRole("option", { name: /applied\.ts/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("before")).toBeTruthy();
  expect(screen.getByText("after")).toBeTruthy();
});

it("a native failed empty result leaves the real Changes surface empty instead of rendering submitted hunks", () => {
  const empty: readonly TimelineRow[] = [{
    type: "assistant", itemId: "empty", createdAt: "2026-11-12T12:00:00.000Z", status: "completed",
    segments: [{ type: "batch", key: "tools", tools: [{
      toolCallId: "edit", toolName: "edit", status: "failed", arguments: { path: "src/input.ts", diff: "+1|not written" },
      result: { type: "toolResult", toolCallId: "edit", isError: true, data: { perFileResults: [] } },
    }] }],
  }];
  render(<I18nProvider forcedLanguage="zh"><SessionChanges rows={empty} /></I18nProvider>);
  expect(screen.queryByText("input.ts")).toBeNull();
  expect(screen.queryByText("not written")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("preview and marks=off use the same partial-edit warning without a demo badge", () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><PreviewChanges /></PreviewModeProvider></I18nProvider>);
  expect(screen.queryByText("演示")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("未应用的部分不计入统计");
  expect(screen.getByRole("button", { name: /MermaidBlock\.tsx/ })).toBeTruthy();
});
