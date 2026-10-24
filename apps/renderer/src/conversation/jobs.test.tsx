import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRuntimeEvent, SessionId } from "@omp-studio/client-contract";
import type { JobWidgetView } from "@omp-studio/studio-protocol";
import { agentJobTree, buildJobTree } from "./jobTree";
import { JobWidget } from "./JobWidget";
import { ToolBody } from "./ToolBody";
import { ConversationStore } from "./conversationStore";
import type { ToolView } from "./conversationViewModel";

afterEach(() => cleanup());

describe("job tree", () => {
  const jobs = [
    { id: "bash-9", ownerId: "typecheck" },
    { id: "task-deps", ownerId: "Main", agentId: "deps" },
    { id: "task-typecheck", ownerId: "deps", agentId: "typecheck" },
    { id: "grep-3", ownerId: "deps" },
    { id: "orphan", ownerId: "released" },
    { id: "bash-main", ownerId: "Main" },
  ];

  it("nests a subagent's jobs under the task job that runs it, through owners missing from the list", () => {
    // `released` has no task job listed; its lineage link points at `typecheck`.
    const rows = buildJobTree(jobs, [{ id: "released", parentId: "typecheck" }]);
    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.job.id}`)).toEqual([
      "task-deps",
      "  task-typecheck",
      "    bash-9",
      "    orphan",
      "  grep-3",
      "bash-main",
    ]);
    expect(rows.find((row) => row.job.id === "task-deps")?.descendants).toBe(4);
  });

  it("shows only the jobs an agent owns, with what nests under them, on that agent's tab", () => {
    const rows = agentJobTree(jobs, [], "deps");
    expect(rows.map((row) => [row.job.id, row.depth])).toEqual([
      ["task-typecheck", 0],
      ["bash-9", 1],
      ["grep-3", 0],
    ]);
  });
});

const WIDGET: JobWidgetView = {
  title: "bench · 3 models",
  headline: { text: "186 tok/s", label: "decode", trend: { text: "▲ 15%", tone: "success" } },
  stage: "model 2/3",
  state: "live",
  updatedAt: 1_000,
  blocks: [
    { kind: "spark", label: "tok/s", values: [10, 20, 30], min: 0, max: 40, marks: [{ value: 25, label: "target" }], last: "30", tips: ["a", "b", "c"] },
    { kind: "bars", label: "per model", max: 10, items: [{ label: "m1", value: 5, text: "5" }] },
    { kind: "meter", label: "trials", value: 0.7, text: "7/10 trials" },
    { kind: "stat", items: [{ label: "p50", text: "41 ms", trend: { text: "▼ 3 ms", tone: "success" } }] },
    { kind: "grid", label: "shards", items: [{ label: "s1", text: "done", tone: "success" }, { label: "s2", text: "fail", tone: "error" }] },
    { kind: "text", text: "running test_parse" },
  ],
};

describe("JobWidget", () => {
  it("draws every block kind from the view data", () => {
    const { container } = render(<JobWidget view={WIDGET} now={3_000} />);
    expect(container.querySelectorAll("[data-testid='jw-spark-col']")).toHaveLength(3);
    expect(container.querySelector(".jw-mark title")?.textContent).toBe("target: 25");
    expect(screen.getByRole("progressbar", { name: "trials" }).getAttribute("aria-valuenow")).toBe("70");
    expect(container.querySelectorAll(".jw-cell")).toHaveLength(2);
    expect(container.textContent).toContain("186 tok/s");
    expect(container.textContent).toContain("▼ 3 ms");
    expect(container.textContent).toContain("running test_parse");
    expect(container.textContent).toContain("model 2/3");
  });

  it("keeps only the primary block when compact", () => {
    const { container } = render(<JobWidget view={WIDGET} compact />);
    expect(container.querySelectorAll(".jw-block")).toHaveLength(1);
    expect(container.querySelector(".jw-spark")).not.toBeNull();
  });
});

function findTool(value: unknown, id: string): ToolView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.toolCallId === id && typeof record.status === "string" && "toolName" in record) return record as unknown as ToolView;
  for (const child of Object.values(record)) {
    const found = findTool(child, id);
    if (found) return found;
  }
  return undefined;
}

describe("MCP progress", () => {
  it("reaches the running MCP tool card as a progress bar", () => {
    const sessionId = "session" as SessionId;
    const queued: Array<() => void> = [];
    const store = new ConversationStore({
      target: { sessionId },
      identity: { sessionId },
      generation: 1,
      scheduler: { request: (callback) => { queued.push(callback); return queued.length; }, cancel: () => {} },
    });
    const events: ConversationRuntimeEvent[] = [
      { kind: "conversation.message.started", sessionId, turnId: "t", messageId: "m", role: "assistant", createdAt: "now" },
      { kind: "conversation.tool.started", sessionId, turnId: "t", messageId: "m", toolCallId: "mcp", toolName: "mcp__docs__index", startedAt: "now" },
      { kind: "conversation.tool.updated", sessionId, turnId: "t", toolCallId: "mcp", updateMode: "replace", output: "indexing 3/4", progress: { progress: 3, total: 4, message: "indexing" } },
    ];
    store.hydrate({ items: [], headCursor: "head" as never, hasMoreBefore: false });
    events.forEach((event, index) => store.applyEvent(event, index + 1));
    for (const callback of queued.splice(0)) callback();
    const tool = findTool(store.getSnapshot().rows, "mcp");
    expect(tool?.progress).toEqual({ progress: 3, total: 4, message: "indexing" });
    render(<ToolBody tool={tool!} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("75");
    expect(screen.getByText(/indexing/u, { selector: ".tc-progress-text span" })).toBeTruthy();
    store.dispose();
  });
});

describe("Eval structured views", () => {
  it("shows a table view in place of the printed text it stands for", () => {
    const printed = "  name  n\n0  a  1\n1  b  2";
    const tool: ToolView = {
      toolCallId: "eval-1",
      toolName: "eval",
      status: "succeeded",
      arguments: { language: "py", code: "df" },
      result: {
        type: "toolResult",
        toolCallId: "eval-1",
        isError: false,
        data: {
          cells: [{
            index: 0,
            code: "print('head'); df",
            output: `head\n${printed}\ntail`,
            status: "complete",
            views: [{ text: printed, view: { kind: "table", columns: [{ head: "name" }, { head: "n", numeric: true }], rows: [["a", "1"], ["b", "2"]] } }],
            statusEvents: [{ op: "mcp_progress", id: "c1", tool: "mcp__docs__index", progress: 1, total: 2 }],
          }],
        },
      },
    };
    const { container } = render(<ToolBody tool={tool} />);
    const table = container.querySelector("table.ev-view-table");
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual(["a1", "b2"]);
    expect(table!.querySelector("td.num")?.textContent).toBe("1");
    // Text around the view stays; the replaced span is not printed twice.
    expect(container.textContent).toContain("head");
    expect(container.textContent).toContain("tail");
    expect(container.textContent).not.toContain("0  a  1");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });
});
