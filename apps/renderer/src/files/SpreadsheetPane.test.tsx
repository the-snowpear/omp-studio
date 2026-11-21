import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import SpreadsheetPane from "./SpreadsheetPane";
import { createSpreadsheetWorkerRuntime, type SpreadsheetWorkerRequest } from "./spreadsheet.worker";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, horizontal }: { count: number; horizontal?: boolean }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: horizontal ? index * 144 : 28 + index * 28, size: horizontal ? 144 : 28 })),
    getTotalSize: () => horizontal ? 48 + count * 144 : 28 + count * 28,
  }),
}));

class SpreadsheetTestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly handle = createSpreadsheetWorkerRuntime();
  postMessage(request: SpreadsheetWorkerRequest) {
    const result = this.handle(request);
    queueMicrotask(() => this.onmessage?.({ data: result } as MessageEvent));
  }
  terminate() {}
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("navigates with arrows, extends a range, exposes the active cell, and copies its TSV values", async () => {
  vi.stubGlobal("Worker", SpreadsheetTestWorker);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const rows = ["alpha,beta", "one,two", ...Array.from({ length: 38 }, (_, index) => `row${index + 3},value${index + 3}`)];
  const { rerender } = render(<I18nProvider forcedLanguage="en"><SpreadsheetPane text={rows.join("\n")} /></I18nProvider>);

  const grid = await screen.findByRole("grid", { name: "Spreadsheet" });
  await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
  expect(grid.getAttribute("aria-rowcount")).toBe("41");
  expect(screen.getByText("alpha").getAttribute("aria-rowindex")).toBe("2");

  fireEvent.pointerDown(screen.getByText("alpha"));
  fireEvent.keyDown(grid, { key: "ArrowRight" });
  expect(grid.getAttribute("aria-activedescendant")).toContain("cell-0-0-1");
  fireEvent.keyDown(grid, { key: "Home" });
  expect(grid.getAttribute("aria-activedescendant")).toContain("cell-0-0-0");
  fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
  expect(grid.getAttribute("aria-activedescendant")).toContain("cell-0-1-1");
  expect(screen.getByText("A1:B2").textContent).toBe("A1:B2");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy selection" })); });
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("alpha\tbeta\none\ttwo"));
  fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  rerender(<I18nProvider forcedLanguage="en"><SpreadsheetPane text={rows.join("\n").replace("two", "updated")} /></I18nProvider>);
  await screen.findByText("updated");
  expect(screen.getByText("A1:B2")).toBeTruthy();

  fireEvent.keyDown(grid, { key: "Home" });
  expect(grid.getAttribute("aria-activedescendant")).toContain("cell-0-1-0");
  fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
  expect(grid.getAttribute("aria-activedescendant")).toContain("cell-0-39-1");
  fireEvent.keyDown(grid, { key: "PageUp" });
  expect(screen.getByText("B31").textContent).toBe("B31");
  fireEvent.keyDown(grid, { key: "PageDown" });
  expect(screen.getByText("B40").textContent).toBe("B40");
  fireEvent.keyDown(grid, { key: "Home", ctrlKey: true });
  expect(grid.getAttribute("aria-activedescendant")).toContain("cell-0-0-0");
});
