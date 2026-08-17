import { describe, expect, it } from "vitest";
import type { JsonValue } from "@omp-studio/client-contract";
import type { AssistantSegment, TimelineRow, ToolView } from "./conversationViewModel";
import {
  askAnswer,
  chainItemDetail,
  collectAgents,
  isRealSubagentId,
  resolveSubagentHubTarget,
  subagentCardKey,
  listSessionChangeTurns,
  sessionChangeScope,
  sessionChangeTurnIdForPath,
  sessionFileChanges,
  sessionFilePatches,
  sessionTaskProgress,
  SESSION_CHANGE_LAST_ID,
  SESSION_CHANGE_SESSION_ID,
  toolKind,
  toolLabel,
} from "./toolMeta";

const tool = (id: string, toolName: string, args: Record<string, JsonValue>, data?: Record<string, JsonValue>, status: ToolView["status"] = "succeeded"): ToolView => ({
  toolCallId: id,
  toolName,
  status,
  arguments: args,
  ...(data === undefined ? {} : { result: { type: "toolResult" as const, toolCallId: id, toolName, isError: false, data } }),
});

const batchSegments = (id: string, tools: ToolView[]): readonly AssistantSegment[] => [{ type: "batch", key: `${id}-batch`, tools }];

const assistantRow = (id: string, tools: ToolView[], status: "completed" | "streaming" = "completed"): TimelineRow => ({
  type: "assistant",
  itemId: id,
  createdAt: "2026-08-17T00:00:00.000Z",
  segments: batchSegments(id, tools),
  status,
});

const userRow = (id: string): TimelineRow => ({ type: "user", itemId: id, createdAt: "2026-08-17T00:00:00.000Z", text: "go" });

describe("upstream tool schemas", () => {
  it("reads mcp__server_tool as an MCP call and labels it server.tool", () => {
    const call = tool("m1", "mcp__linear_list_issues", { teamId: "T1" });
    expect(toolKind(call)).toBe("mcp");
    expect(toolLabel(call)).toBe("MCP · linear.list_issues");
  });

  it("does not turn a tool that merely takes a kind argument into that kind", () => {
    expect(toolKind(tool("g1", "grep", { kind: "bash", pattern: "foo" }))).toBe("grep");
  });

  it("shows the real argument field for glob, ast_grep, and grep", () => {
    expect(chainItemDetail(tool("g1", "glob", { path: "src/**/*.ts" }))).toBe("src/**/*.ts");
    expect(chainItemDetail(tool("a1", "ast_grep", { pat: "class $NAME", path: "src" }))).toBe("class $NAME");
    expect(chainItemDetail(tool("r1", "grep", { pattern: "TODO", path: "src" }))).toBe("TODO");
  });

  it("prefers the addressable target over a result-side summary", () => {
    expect(chainItemDetail(tool("r1", "read", { path: "src/a.ts" }, { summary: "读取 40 行" }))).toBe("src/a.ts");
  });

  it("reads hub op and ask questions from their real shapes", () => {
    expect(chainItemDetail(tool("h1", "hub", { op: "list" }))).toBe("list");
    const ask = tool("k1", "ask", { questions: [{ id: "q1", question: "选哪个范围?", options: [] }] });
    expect(chainItemDetail(ask)).toBe("选哪个范围?");
  });

  it("joins per-question answers from a multi-question ask result", () => {
    const ask = tool("k1", "ask", { questions: [{ id: "q1", question: "范围?" }, { id: "q2", question: "方式?" }] }, {
      results: [
        { questionId: "q1", selectedOptions: ["all"] },
        { questionId: "q2", customInput: "turn_track" },
      ],
    });
    expect(askAnswer(ask)).toBe("all · turn_track");
    expect(chainItemDetail(ask)).toBe("all · turn_track");
  });

  it("counts task agents from spawn.tasks and from the result list", () => {
    const spawned = tool("t1", "task", { spawn: { tasks: [{ name: "a" }, { name: "b" }] } });
    expect(chainItemDetail(spawned)).toBe("2 agents");
    const reported = tool("t2", "task", { spawn: { name: "explore" } }, {
      results: [{ name: "explore", status: "completed" }, { name: "review", status: "running" }],
    });
    expect(chainItemDetail(reported)).toBe("2 agents");
    expect(collectAgents([reported]).map((agent) => agent.name)).toEqual(["explore", "review"]);
    expect(collectAgents([reported]).every((agent) => agent.agentId === undefined)).toBe(true);
    expect(collectAgents([reported]).map((agent) => resolveSubagentHubTarget(agent))).toEqual([undefined, undefined]);
  });

  it("keeps a real Hub agentId and never treats the display name as identity", () => {
    const reported = tool("t3", "task", { spawn: { tasks: [{ name: "deps", task: "audit lockfile" }] } }, {
      progress: [{ id: "agent-019fcb01", name: "deps", status: "running", task: "audit lockfile" }],
    });
    const [agent] = collectAgents([reported]);
    expect(agent).toMatchObject({
      name: "deps",
      agentId: "agent-019fcb01",
      toolCallId: "t3",
      task: "audit lockfile",
    });
    expect(resolveSubagentHubTarget(agent!)).toEqual({
      agentId: "agent-019fcb01",
      toolCallId: "t3",
      task: "audit lockfile",
    });
    expect(subagentCardKey(agent!)).toBe("t3:agent-019fcb01");
    expect(isRealSubagentId("deps")).toBe(false);
    expect(isRealSubagentId("agent-019fcb01")).toBe(true);
  });

  it("attributes ast_edit files and lines from fileReplacements and the grouped display tree", () => {
    const astEdit = tool("ae1", "ast_edit", { paths: ["src"], ops: [{ pat: "foo($A)", out: "bar($A)" }] }, {
      totalReplacements: 2,
      fileReplacements: [
        { path: "src/one.ts", count: 1 },
        { path: "src/nested/two.ts", count: 1 },
      ],
      displayContent: [
        "# src/",
        "## one.ts (1 replacement)",
        "-12│  foo(a);",
        "+12│  bar(a);",
        "",
        "## nested/",
        "### two.ts#1A2B (1 replacement)",
        " 40│  const x = 1;",
        "-41│  foo(x);",
        "+41│  bar(x);",
      ].join("\n"),
    });
    expect(sessionFileChanges([assistantRow("a1", [astEdit])]).session).toEqual([
      { path: "src/one.ts", name: "one.ts", dir: "src/", add: 1, del: 1, status: "modified", note: "AST Edit" },
      { path: "src/nested/two.ts", name: "two.ts", dir: "src/nested/", add: 1, del: 1, status: "modified", note: "AST Edit" },
    ]);
    const patches = sessionFilePatches(batchSegments("a1", [astEdit]));
    expect(patches.get("src/one.ts")).toEqual([{
      kind: "ast_edit",
      lines: [
        { mark: "-", oldLn: "12", newLn: "", text: "  foo(a);" },
        { mark: "+", oldLn: "", newLn: "12", text: "  bar(a);" },
      ],
    }]);
    expect(patches.get("src/nested/two.ts")).toEqual([{
      kind: "ast_edit",
      lines: [
        { mark: " ", oldLn: "40", newLn: "40", text: "  const x = 1;" },
        { mark: "-", oldLn: "41", newLn: "", text: "  foo(x);" },
        { mark: "+", oldLn: "", newLn: "41", text: "  bar(x);" },
      ],
    }]);
  });
});

describe("sessionFileChanges", () => {
  it("splits the last contiguous assistant run from the session-wide accumulation", () => {
    const rows: readonly TimelineRow[] = [
      userRow("u1"),
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "-1|old\n+1|new" })]),
      userRow("u2"),
      assistantRow("a2", [
        tool("e2", "edit", { path: "src/b.ts" }, { diff: "+2|added" }),
        tool("e3", "edit", { path: "src/a.ts" }, { diff: "+1|more" }),
      ]),
    ];
    const changes = sessionFileChanges(rows);
    expect(changes.turn.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(changes.session.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const a = changes.session.find((file) => file.path === "src/a.ts");
    expect(a).toMatchObject({ add: 2, del: 1, status: "modified", note: "Edit" });
  });

  it("infers FileStat status and tool-kind notes from the last successful edit kind", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [
        tool("w1", "write", { path: "docs/new.md", content: "hello" }),
        tool("e1", "edit", { path: "src/gone.ts" }, { diff: "-1|old" }),
        tool("w2", "write", { path: "src/mixed.ts", content: "first" }),
        tool("e2", "edit", { path: "src/mixed.ts" }, { diff: "-1|first\n+1|second" }),
      ]),
    ];
    const byPath = Object.fromEntries(sessionFileChanges(rows).session.map((file) => [file.path, file]));
    expect(byPath["docs/new.md"]).toMatchObject({ status: "added", note: "Write", add: 1, del: 0 });
    expect(byPath["src/gone.ts"]).toMatchObject({ status: "deleted", note: "Edit", add: 0, del: 1 });
    expect(byPath["src/mixed.ts"]).toMatchObject({ status: "modified", note: "Edit" });
  });

  it("turn aggregates a streaming tail across consecutive assistant rows, session keeps history", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [tool("e1", "write", { path: "docs/old.md", content: "x" })]),
      userRow("u1"),
      assistantRow("a2", [tool("e2", "write", { path: "docs/new.md", content: "y" })]),
      assistantRow("a3", [tool("e3", "write", { path: "docs/tail.md", content: "z" })], "streaming"),
    ];
    const changes = sessionFileChanges(rows);
    expect(changes.turn.map((file) => file.path)).toEqual(["docs/new.md", "docs/tail.md"]);
    expect(changes.session.map((file) => file.path)).toEqual(["docs/old.md", "docs/new.md", "docs/tail.md"]);
    // 与 Session HUD（TaskProgressDock）的“当前 Turn”口径一致。
    expect(sessionTaskProgress(rows).files.map((file) => file.path)).toEqual(changes.turn.map((file) => file.path));
  });

  it("returns empty groups without assistant rows", () => {
    expect(sessionFileChanges([userRow("u1")])).toEqual({ turn: [], session: [] });
    expect(sessionFileChanges([])).toEqual({ turn: [], session: [] });
  });

  it("normalizes backslash paths and skips rename display strings", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [
        tool("e1", "edit", { path: "src\\win\\a.ts" }, { diff: "+1|x" }),
        tool("e2", "edit", { path: "old.ts → new.ts" }, { diff: "+1|y" }),
      ]),
    ];
    const changes = sessionFileChanges(rows);
    expect(changes.session.map((file) => file.path)).toEqual(["src/win/a.ts"]);
  });
});

describe("listSessionChangeTurns", () => {
  it("lists last turn, earlier turns with files, and the session total", () => {
    const rows: readonly TimelineRow[] = [
      userRow("u1"),
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "-1|old\n+1|new" })]),
      userRow("u2"),
      assistantRow("a2", [
        tool("e2", "edit", { path: "src/b.ts" }, { diff: "+2|added" }),
        tool("e3", "edit", { path: "src/a.ts" }, { diff: "+1|more" }),
      ]),
    ];
    const turns = listSessionChangeTurns(rows);
    expect(turns.map((turn) => turn.id)).toEqual([SESSION_CHANGE_LAST_ID, "a1", SESSION_CHANGE_SESSION_ID]);
    expect(turns.map((turn) => turn.label)).toEqual(["最近一轮", "第 1 轮", "本会话"]);
    expect(turns[0]?.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(turns[1]?.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(turns[2]?.files.find((file) => file.path === "src/a.ts")).toMatchObject({ add: 2, del: 1 });
  });

  it("keeps last turn following a streaming tail and skips empty earlier runs", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a0", []),
      userRow("u1"),
      assistantRow("a1", [tool("e1", "write", { path: "docs/old.md", content: "x" })]),
      userRow("u2"),
      assistantRow("a2", [tool("e2", "write", { path: "docs/new.md", content: "y" })]),
      assistantRow("a3", [tool("e3", "write", { path: "docs/tail.md", content: "z" })], "streaming"),
    ];
    const turns = listSessionChangeTurns(rows);
    expect(turns.map((turn) => [turn.id, turn.files.map((file) => file.path)])).toEqual([
      [SESSION_CHANGE_LAST_ID, ["docs/new.md", "docs/tail.md"]],
      ["a1", ["docs/old.md"]],
      [SESSION_CHANGE_SESSION_ID, ["docs/old.md", "docs/new.md", "docs/tail.md"]],
    ]);
  });

  it("scopes patches to the selected turn instead of the whole session", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "-1|old\n+1|new" })]),
      userRow("u2"),
      assistantRow("a2", [tool("e2", "edit", { path: "src/a.ts" }, { diff: "+1|more" })]),
    ];
    const first = sessionChangeScope(rows, "a1");
    expect(first.label).toBe("第 1 轮");
    expect(first.files).toEqual([expect.objectContaining({ path: "src/a.ts", add: 1, del: 1 })]);
    expect(sessionFilePatches(first.segments).get("src/a.ts")).toEqual([
      {
        kind: "edit",
        lines: [
          { mark: "-", oldLn: "1", newLn: "", text: "old" },
          { mark: "+", oldLn: "", newLn: "1", text: "new" },
        ],
      },
    ]);
    const last = sessionChangeScope(rows, SESSION_CHANGE_LAST_ID);
    expect(last.label).toBe("最近一轮");
    expect(sessionFilePatches(last.segments).get("src/a.ts")).toEqual([
      { kind: "edit", lines: [{ mark: "+", oldLn: "", newLn: "1", text: "more" }] },
    ]);
    const session = sessionChangeScope(rows, "gone");
    expect(session.id).toBe(SESSION_CHANGE_LAST_ID);
  });

  it("resolves focus path to the latest turn that touched the file", () => {
    const rows: readonly TimelineRow[] = [
      assistantRow("a1", [tool("e1", "edit", { path: "src/a.ts" }, { diff: "+1|one" })]),
      userRow("u2"),
      assistantRow("a2", [tool("e2", "edit", { path: "src/b.ts" }, { diff: "+1|two" })]),
    ];
    expect(sessionChangeTurnIdForPath(rows, "src/a.ts")).toBe("a1");
    expect(sessionChangeTurnIdForPath(rows, "src/b.ts")).toBe(SESSION_CHANGE_LAST_ID);
    expect(sessionChangeTurnIdForPath(rows, "missing.ts")).toBeUndefined();
  });
});

describe("sessionFilePatches", () => {
  it("parses tuple-array diffs with the EditBody mark/line/text shape", () => {
    const segments = batchSegments("a1", [
      tool("e1", "edit", { path: "README.md" }, {
        diff: [
          [" ", "46", "46", "- [更新日志](docs/CHANGELOG.md)"],
          ["+", "", "47", "- [上游同步](docs/UPSTREAM-SYNC.md)"],
          ["-", "47", "", "- [旧条目](docs/OLD.md)"],
        ],
      }),
    ]);
    const patches = sessionFilePatches(segments);
    expect(patches.get("README.md")).toEqual([
      {
        kind: "edit",
        lines: [
          { mark: " ", oldLn: "46", newLn: "46", text: "- [更新日志](docs/CHANGELOG.md)" },
          { mark: "+", oldLn: "", newLn: "47", text: "- [上游同步](docs/UPSTREAM-SYNC.md)" },
          { mark: "-", oldLn: "47", newLn: "", text: "- [旧条目](docs/OLD.md)" },
        ],
      },
    ]);
  });

  it("parses numbered string diffs and treats non-matching lines as context", () => {
    const segments = batchSegments("a1", [
      tool("e1", "edit", { path: "src/a.ts" }, { diff: " 11|before\n-12|old\n+12|new\nplain" }),
    ]);
    expect(sessionFilePatches(segments).get("src/a.ts")).toEqual([
      {
        kind: "edit",
        lines: [
          { mark: " ", oldLn: "11", newLn: "11", text: "before" },
          { mark: "-", oldLn: "12", newLn: "", text: "old" },
          { mark: "+", oldLn: "", newLn: "12", text: "new" },
          { mark: " ", oldLn: "", newLn: "", text: "plain" },
        ],
      },
    ]);
  });

  it("renders write content as add lines and caps oversized files", () => {
    const small = batchSegments("a1", [tool("w1", "write", { path: "docs/x.md", content: "one\ntwo" })]);
    expect(sessionFilePatches(small).get("docs/x.md")).toEqual([{
      kind: "write",
      lines: [
        { mark: "+", oldLn: "", newLn: "1", text: "one" },
        { mark: "+", oldLn: "", newLn: "2", text: "two" },
      ],
    }]);

    const huge = batchSegments("a2", [tool("w2", "write", { path: "big.ts", content: Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n") })]);
    const block = sessionFilePatches(huge).get("big.ts")?.[0];
    expect(block).toBeDefined();
    expect(block?.lines).toHaveLength(500);
    expect(block?.lines[0]).toEqual({ mark: "+", oldLn: "", newLn: "1", text: "l0" });
    expect(block?.lines.at(-1)).toEqual({ mark: "+", oldLn: "", newLn: "500", text: "l499" });
    expect(block?.truncated).toBe(true);
  });

  it("groups ast_edit changes by file with before/after lines", () => {
    const segments = batchSegments("a1", [
      tool("ae1", "ast_edit", { target: "src/multi.ts" }, {
        changes: [
          { file: "src/one.ts", before: "const a = 1;", after: "const a = 2;" },
          { file: "src\\two.ts", after: "export const two = 2;" },
          { file: "renamed → path.ts", before: "x", after: "y" },
        ],
      }),
    ]);
    const patches = sessionFilePatches(segments);
    expect(patches.get("src/one.ts")).toEqual([{
      kind: "ast_edit",
      lines: [
        { mark: "-", oldLn: "", newLn: "", text: "const a = 1;" },
        { mark: "+", oldLn: "", newLn: "", text: "const a = 2;" },
      ],
    }]);
    expect(patches.get("src/two.ts")).toEqual([{
      kind: "ast_edit",
      lines: [{ mark: "+", oldLn: "", newLn: "", text: "export const two = 2;" }],
    }]);
    expect(patches.has("renamed → path.ts")).toBe(false);
  });

  it("appends blocks per file in chronological order and skips non-succeeded tools", () => {
    const segments = batchSegments("a1", [
      tool("e1", "edit", { path: "src/a.ts" }, { diff: "+1|first" }),
      tool("e2", "edit", { path: "src/a.ts" }, { diff: "+1|failed" }, "failed"),
      tool("w1", "write", { path: "src/a.ts", content: "rewritten" }),
    ]);
    const blocks = sessionFilePatches(segments).get("src/a.ts");
    expect(blocks).toEqual([
      { kind: "edit", lines: [{ mark: "+", oldLn: "", newLn: "1", text: "first" }] },
      { kind: "write", lines: [{ mark: "+", oldLn: "", newLn: "1", text: "rewritten" }] },
    ]);
  });
});
