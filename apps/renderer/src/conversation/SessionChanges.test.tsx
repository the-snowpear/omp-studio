import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@omp-studio/client-contract";
import { SessionChanges } from "./SessionChanges";
import type { AssistantSegment, TimelineRow, ToolView } from "./conversationViewModel";

afterEach(cleanup);

const tool = (id: string, toolName: string, args: Record<string, JsonValue>, data?: Record<string, JsonValue>): ToolView => ({
  toolCallId: id,
  toolName,
  status: "succeeded",
  arguments: args,
  ...(data === undefined ? {} : { result: { type: "toolResult" as const, toolCallId: id, toolName, isError: false, data } }),
});

const batchSegments = (id: string, tools: ToolView[]): readonly AssistantSegment[] => [{ type: "batch", key: `${id}-batch`, tools }];

const assistantRow = (id: string, tools: ToolView[]): TimelineRow => ({
  type: "assistant",
  itemId: id,
  createdAt: "2026-08-17T00:00:00.000Z",
  segments: batchSegments(id, tools),
  status: "completed",
});

const userRow = (id: string): TimelineRow => ({ type: "user", itemId: id, createdAt: "2026-08-17T00:00:00.000Z", text: "go" });

describe("SessionChanges", () => {
  it("defaults to a collapsed file list for the last turn", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [
        tool("e1", "edit", { path: "src/a.ts" }, {
          diff: [
            [" ", "10", "10", "const x = 1;"],
            ["-", "11", "", "const y = 2;"],
            ["+", "", "11", "const y = 3;"],
          ],
        }),
        tool("w1", "write", { path: "docs/new.md", content: "hello" }),
      ]),
    ];
    render(<SessionChanges rows={rows} />);

    expect(screen.getByRole("button", { name: "选择改动轮次" }).textContent).toContain("最近一轮");
    expect(screen.getByRole("button", { name: "展开 src/a.ts 的会话改动" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开 docs/new.md 的会话改动" })).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("src/")).toBeTruthy();
    expect(screen.getByText("new.md")).toBeTruthy();
    expect(screen.getByText("docs/")).toBeTruthy();
    expect(document.querySelector(".diff-scroll")).toBeNull();
    expect(document.querySelectorAll(".ch-row .ch-add").length).toBeGreaterThan(0);
  });

  it("expands a file to show dual line numbers and can switch to split view", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [
        tool("e1", "edit", { path: "src/a.ts" }, {
          diff: [
            [" ", "10", "10", "const x = 1;"],
            ["-", "11", "", "const y = 2;"],
            ["+", "", "11", "const y = 3;"],
          ],
        }),
      ]),
    ];
    render(<SessionChanges rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 src/a.ts 的会话改动" }));

    const gutters = [...document.querySelectorAll(".diff-scroll .dl:not(.collapse) .ln")].map((node) => node.textContent);
    expect(gutters).toEqual(["10", "10", "11", "", "", "11"]);
    expect(document.querySelector(".diff-scroll")?.classList.contains("diff-split")).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "左右对照" }));
    expect(document.querySelector(".diff-scroll")?.classList.contains("diff-split")).toBe(true);
    expect(document.querySelectorAll(".diff-scroll .dl .half").length).toBeGreaterThan(0);
  });

  it("scopes the list to the selected earlier turn", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "+1|one" })]),
      userRow("u2"),
      assistantRow("a2", [tool("e2", "edit", { path: "src/b.ts" }, { diff: "+1|two" })]),
    ];
    render(<SessionChanges rows={rows} />);
    expect(screen.getByRole("button", { name: "展开 src/b.ts 的会话改动" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开 src/a.ts 的会话改动" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "选择改动轮次" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "改动轮次" })).getByRole("menuitem", { name: /第 1 轮/ }));
    expect(screen.getByRole("button", { name: "选择改动轮次" }).textContent).toContain("第 1 轮");
    expect(screen.getByRole("button", { name: "展开 src/a.ts 的会话改动" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开 src/b.ts 的会话改动" })).toBeNull();
  });

  it("shows the empty contract when the session has no file edits", () => {
    render(<SessionChanges rows={[]} />);
    expect(screen.getByText("本会话还没有文件改动。")).toBeTruthy();
    expect(document.querySelector(".diff-scroll")).toBeNull();
  });

  it("expands the focused path from the conversation review action", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [
        tool("e1", "edit", { path: "src/a.ts" }, {
          diff: [
            [" ", "10", "10", "const x = 1;"],
            ["-", "11", "", "const y = 2;"],
            ["+", "", "11", "const y = 3;"],
          ],
        }),
        tool("w1", "write", { path: "docs/new.md", content: "hello" }),
      ]),
    ];
    render(<SessionChanges rows={rows} focusPath="src/a.ts" />);
    expect(screen.getByRole("button", { name: "收起 src/a.ts 的会话改动" })).toBeTruthy();
    expect(document.querySelector(".diff-scroll")).not.toBeNull();
    expect([...document.querySelectorAll(".diff-scroll .dl:not(.collapse) .ln")].map((node) => node.textContent)).toEqual([
      "10", "10", "11", "", "", "11",
    ]);
  });

  it("selects the earlier turn when reviewing that conversation card", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "+1|one" })]),
      userRow("u2"),
      assistantRow("a2", [tool("e2", "edit", { path: "src/b.ts" }, { diff: "+1|two" })]),
    ];
    render(<SessionChanges rows={rows} focusTurnId="a1" focusKey={1} />);
    expect(screen.getByRole("button", { name: "选择改动轮次" }).textContent).toContain("第 1 轮");
    expect(screen.getByRole("button", { name: "展开 src/a.ts 的会话改动" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开 src/b.ts 的会话改动" })).toBeNull();
  });

  it("returns to the reviewed turn when the same card is audited again", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "+1|one" })]),
      userRow("u2"),
      assistantRow("a2", [tool("e2", "edit", { path: "src/b.ts" }, { diff: "+1|two" })]),
    ];
    const { rerender } = render(<SessionChanges rows={rows} focusTurnId="a1" focusKey={1} />);
    fireEvent.click(screen.getByRole("button", { name: "选择改动轮次" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "改动轮次" })).getByRole("menuitem", { name: /最近一轮/ }));
    expect(screen.getByRole("button", { name: "选择改动轮次" }).textContent).toContain("最近一轮");

    rerender(<SessionChanges rows={rows} focusTurnId="a1" focusKey={2} />);
    expect(screen.getByRole("button", { name: "选择改动轮次" }).textContent).toContain("第 1 轮");
    expect(screen.getByRole("button", { name: "展开 src/a.ts 的会话改动" })).toBeTruthy();
  });
});
