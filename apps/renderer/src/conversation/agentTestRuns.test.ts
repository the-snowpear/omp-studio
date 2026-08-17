import { describe, expect, it } from "vitest";
import type { JsonValue } from "@omp-studio/client-contract";
import {
  agentTestRunSummary,
  formatTestDuration,
  isTestCommand,
  projectAgentTestRuns,
  rerunTestPrompt,
} from "./agentTestRuns";
import type { TimelineRow, ToolView } from "./conversationViewModel";

const bash = (
  id: string,
  command: string,
  status: ToolView["status"] = "succeeded",
  data?: Record<string, JsonValue>,
  output?: string,
): ToolView => ({
  toolCallId: id,
  toolName: "bash",
  status,
  arguments: { command },
  ...(output === undefined ? {} : { output }),
  ...(data === undefined ? {} : { result: { type: "toolResult" as const, toolCallId: id, toolName: "bash", isError: false, data } }),
});

const row = (id: string, tools: ToolView[]): TimelineRow => ({
  type: "assistant",
  itemId: id,
  createdAt: "2026-08-17T00:00:00.000Z",
  segments: [{ type: "batch", key: `${id}-batch`, tools }],
  status: "completed",
});

describe("isTestCommand", () => {
  it("hits package-manager and language test argv", () => {
    expect(isTestCommand("npm test")).toBe(true);
    expect(isTestCommand("npm run test")).toBe(true);
    expect(isTestCommand("npm run test:unit")).toBe(true);
    expect(isTestCommand("npx --yes vitest")).toBe(true);
    expect(isTestCommand("bun test")).toBe(true);
    expect(isTestCommand("bun run test")).toBe(true);
    expect(isTestCommand("pnpm test")).toBe(true);
    expect(isTestCommand("yarn test")).toBe(true);
    expect(isTestCommand("vitest")).toBe(true);
    expect(isTestCommand("jest --coverage")).toBe(true);
    expect(isTestCommand("pytest -q")).toBe(true);
    expect(isTestCommand("python -m pytest")).toBe(true);
    expect(isTestCommand("cargo test")).toBe(true);
    expect(isTestCommand("go test ./...")).toBe(true);
    expect(isTestCommand("dotnet test")).toBe(true);
    expect(isTestCommand("cd packages/foo && bun test")).toBe(true);
    expect(isTestCommand("./node_modules/.bin/vitest")).toBe(true);
  });

  it("misses commands that only mention test as an argument or path", () => {
    expect(isTestCommand("echo test")).toBe(false);
    expect(isTestCommand("cat src/test/foo.ts")).toBe(false);
    expect(isTestCommand("ls test")).toBe(false);
    expect(isTestCommand("git checkout test")).toBe(false);
    expect(isTestCommand("mkdir test")).toBe(false);
    expect(isTestCommand("npm run lint")).toBe(false);
    expect(isTestCommand("npm run typecheck")).toBe(false);
    expect(isTestCommand("bun run dev")).toBe(false);
    expect(isTestCommand("grep test src/a.ts")).toBe(false);
  });
});

describe("projectAgentTestRuns", () => {
  it("returns an empty list when the session has no tools", () => {
    expect(projectAgentTestRuns([])).toEqual([]);
    expect(projectAgentTestRuns([{ type: "user", itemId: "u1", createdAt: "2026-08-17T00:00:00.000Z", text: "go" }])).toEqual([]);
    expect(agentTestRunSummary([]).total).toBe(0);
  });

  it("keeps test bash tools and drops lint / echo / read", () => {
    const runs = projectAgentTestRuns([
      row("a1", [
        bash("t1", "npm test", "succeeded", { exitCode: 0, wallTimeMs: 1250 }, "ok"),
        bash("t2", "echo test", "succeeded", { exitCode: 0 }),
        bash("t3", "npm run lint", "succeeded", { exitCode: 0 }),
        { toolCallId: "r1", toolName: "read", status: "succeeded", arguments: { path: "src/a.test.ts" } },
      ]),
    ]);
    expect(runs.map((run) => run.toolCallId)).toEqual(["t1"]);
    expect(runs[0]).toMatchObject({
      toolCallId: "t1",
      itemId: "a1",
      command: "npm test",
      status: "pass",
      exitCode: 0,
      durationMs: 1250,
      output: "ok",
    });
  });

  it("maps exitCode and live status without reading stdout", () => {
    const runs = projectAgentTestRuns([
      row("a1", [
        bash("pass", "bun test", "succeeded", { exitCode: 0, wallTimeMs: 420 }),
        bash("fail", "pytest", "succeeded", { exitCode: 1, wallTimeMs: 880 }, "FAILED tests/test_rpc.py"),
        bash("live", "npm test", "running"),
        bash("stop", "cargo test", "aborted"),
      ]),
    ]);
    expect(runs.map((run) => [run.toolCallId, run.status, run.exitCode])).toEqual([
      ["stop", "aborted", undefined],
      ["live", "running", undefined],
      ["fail", "fail", 1],
      ["pass", "pass", 0],
    ]);
    expect(runs.find((run) => run.toolCallId === "fail")?.output).toBe("FAILED tests/test_rpc.py");
    expect(agentTestRunSummary(runs)).toEqual({ total: 4, running: 1, passed: 1, failed: 1, aborted: 1 });
  });

  it("treats powershell-wrapped bash as bash and keeps the latest toolCallId", () => {
    const first: ToolView = {
      toolCallId: "same",
      toolName: "Bash",
      status: "running",
      arguments: { command: "npm test" },
    };
    const later: ToolView = {
      toolCallId: "same",
      toolName: "powershell",
      status: "succeeded",
      arguments: { command: "npm test" },
      result: { type: "toolResult", toolCallId: "same", toolName: "powershell", isError: false, data: { exitCode: 0, wallTimeMs: 90 } },
    };
    const runs = projectAgentTestRuns([row("a1", [first]), row("a2", [later])]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ toolCallId: "same", itemId: "a2", status: "pass", exitCode: 0, durationMs: 90 });
  });

  it("keeps cwd, itemId, and array output without parsing runner text", () => {
    const tool: ToolView = {
      toolCallId: "arr",
      toolName: "bash",
      status: "failed",
      arguments: { command: "bun test", cwd: "packages/foo" },
      result: {
        type: "toolResult",
        toolCallId: "arr",
        toolName: "bash",
        isError: true,
        truncated: true,
        data: { exitCode: 1, output: [["FAIL rpc.test.ts", "err"], ["Expected preview.dom", ""]] },
      },
    };
    const runs = projectAgentTestRuns([row("msg-9", [tool])]);
    expect(runs[0]).toMatchObject({
      itemId: "msg-9",
      cwd: "packages/foo",
      status: "fail",
      exitCode: 1,
      truncated: true,
      output: "FAIL rpc.test.ts\nExpected preview.dom",
    });
  });
});

describe("rerunTestPrompt", () => {
  it("asks the agent to rerun the exact command", () => {
    expect(rerunTestPrompt("bun test --coverage")).toBe("请重新运行这条测试命令，不要改命令本身：\nbun test --coverage");
  });
});

describe("formatTestDuration", () => {
  it("uses ms under one second and seconds after", () => {
    expect(formatTestDuration(420)).toBe("420ms");
    expect(formatTestDuration(1250)).toBe("1.25s");
    expect(formatTestDuration(1000)).toBe("1s");
  });
});
