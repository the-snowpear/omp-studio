import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { TaskProgressDock } from "./TaskProgressDock";
import { collectLatestTodos, collectTurnFileChanges } from "./toolMeta";
import type { AssistantSegment, ToolView } from "./conversationViewModel";

const initialUrl = window.location.href;
beforeEach(() => { vi.spyOn(document, "hidden", "get").mockReturnValue(false); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState({}, "", initialUrl); });
const batch = (tool: ToolView): AssistantSegment[] => [{ type: "batch", key: "tools", tools: [tool] }];
function todo(status: "blocked" | "pending", failed = false): ToolView {
  return {
    toolCallId: "todo", toolName: "todo", status: failed ? "failed" : "succeeded",
    arguments: { op: "view", phases: [{ name: "History", tasks: [{ content: "Resume old work", status: "blocked" }] }] },
    result: { type: "toolResult", toolCallId: "todo", isError: failed, data: { op: "view", phases: [{ name: "History", tasks: [{ content: "Resume old work", status }] }] } },
  };
}

it("keeps old blocked todos read-only and lets the native restored pending snapshot replace them without accepting a failed update", () => {
  const old = collectLatestTodos(batch(todo("blocked")));
  const restored = collectLatestTodos(batch(todo("pending")));
  const mounted = render(<I18nProvider forcedLanguage="zh"><TaskProgressDock todos={old} files={[]} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: /展开任务与文件修改/ }));
  expect(screen.getByText("旧记录")).toBeTruthy();
  expect(screen.getByText(/原生恢复会将其转为待办/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(restored[0]?.status).toBe("pending");
  mounted.rerender(<I18nProvider forcedLanguage="zh"><TaskProgressDock todos={restored} files={[]} /></I18nProvider>);
  expect(screen.queryByText("旧记录")).toBeNull();
  expect(screen.queryByText(/阻塞状态仅供回看/)).toBeNull();
  expect(screen.getByText("Resume old work")).toBeTruthy();
  const afterFailed = collectLatestTodos([...batch(todo("pending")), ...batch(todo("blocked", true))]);
  expect(afterFailed[0]?.status).toBe("pending");
});

it("shows only confirmed-applied files and a partial warning, while native empty error results create no dock", () => {
  const partial: ToolView = {
    toolCallId: "edit", toolName: "edit", status: "failed", arguments: { path: "src/input.ts", diff: "+1|not written" },
    result: { type: "toolResult", toolCallId: "edit", isError: true, data: { perFileResults: [
      { path: "src/applied.ts", diff: "-1|old\n+1|new" },
      { path: "src/rejected.ts", isError: true, diff: "+1|not written" },
    ] } },
  };
  const onOpen = vi.fn();
  const mounted = render(<I18nProvider forcedLanguage="zh"><TaskProgressDock todos={[]} files={collectTurnFileChanges(batch(partial))} onOpen={onOpen} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: /1 个文件已更改.*部分编辑/ }));
  const files = screen.getByRole("region", { name: "文件修改" });
  expect(within(files).getByText(/仅显示已确认落盘的文件/)).toBeTruthy();
  expect(within(files).queryByText("rejected.ts")).toBeNull();
  expect(within(files).queryByText("input.ts")).toBeNull();
  fireEvent.click(within(files).getByRole("button", { name: "打开 src/applied.ts" }));
  expect(onOpen).toHaveBeenCalledWith("src/applied.ts");
  const empty: ToolView = { ...partial, result: { type: "toolResult", toolCallId: "edit", isError: true, data: { perFileResults: [] } } };
  mounted.rerender(<I18nProvider forcedLanguage="zh"><TaskProgressDock todos={[]} files={collectTurnFileChanges(batch(empty))} /></I18nProvider>);
  expect(screen.queryByRole("button")).toBeNull();
});

it("marks=off hides only demo chrome while retaining the partial warning and ordinary file-open labels", () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const onOpen = vi.fn();
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><TaskProgressDock todos={[]} demo files={[
    { path: "src/applied.ts", name: "applied.ts", dir: "src/", add: 1, del: 1, partial: true },
  ]} onOpen={onOpen} /></PreviewModeProvider></I18nProvider>);
  expect(screen.queryByText("演示")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /部分编辑/ }));
  expect(screen.getByText(/部分编辑未应用/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "打开 src/applied.ts" })).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
});
