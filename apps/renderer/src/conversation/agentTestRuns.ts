/**
 * Bottom-bar Tests projector: Agent bash/powershell commands that look like
 * test runs. Uses argv tokens only — never parses runner stdout or ANSI.
 */

import { jsonString, type TimelineRow, type ToolView } from "./conversationViewModel";
import { jsonNumber, toolFields, toolKind } from "./toolMeta";

export type AgentTestRunStatus = "running" | "pass" | "fail" | "aborted";

export type AgentTestRun = {
  readonly toolCallId: string;
  readonly itemId: string;
  readonly command: string;
  readonly status: AgentTestRunStatus;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly cwd?: string;
  readonly output?: string;
  readonly truncated?: boolean;
};

export type AgentTestRunSummary = {
  readonly total: number;
  readonly running: number;
  readonly passed: number;
  readonly failed: number;
  readonly aborted: number;
};

const PACKAGE_MANAGERS = new Set(["npm", "npx", "bun", "bunx", "pnpm", "yarn"]);
const STANDALONE_RUNNERS = new Set(["vitest", "jest", "pytest"]);
const LANGUAGE_RUNNERS = new Set(["cargo", "go", "dotnet"]);
const PYTHON_BINS = new Set(["python", "python3", "py"]);

export function rerunTestPrompt(command: string): string {
  return `请重新运行这条测试命令，不要改命令本身：\n${command}`;
}

export function formatTestDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(2).replace(/\.?0+$/, "")}s`;
}

export function agentTestRunSummary(runs: readonly AgentTestRun[]): AgentTestRunSummary {
  let running = 0;
  let passed = 0;
  let failed = 0;
  let aborted = 0;
  for (const run of runs) {
    if (run.status === "running") running += 1;
    else if (run.status === "pass") passed += 1;
    else if (run.status === "fail") failed += 1;
    else aborted += 1;
  }
  return { total: runs.length, running, passed, failed, aborted };
}

export function projectAgentTestRuns(rows: readonly TimelineRow[]): readonly AgentTestRun[] {
  const seen = new Map<string, AgentTestRun>();
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    for (const segment of row.segments) {
      if (segment.type !== "batch") continue;
      for (const tool of segment.tools) {
        const run = projectTool(tool, row.itemId);
        if (run !== undefined) seen.set(run.toolCallId, run);
      }
    }
  }
  return Array.from(seen.values()).reverse();
}

export function isTestCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  for (let index = 0; index < tokens.length; index += 1) {
    const name = commandBasename(tokens[index]!);
    if (STANDALONE_RUNNERS.has(name)) return true;
    if (LANGUAGE_RUNNERS.has(name)) {
      const verb = nextNonFlag(tokens, index + 1);
      if (verb === "test") return true;
    }
    if (PYTHON_BINS.has(name) && isPythonPytest(tokens, index + 1)) return true;
    if (PACKAGE_MANAGERS.has(name) && isPackageManagerTest(tokens, index + 1)) return true;
  }
  return false;
}

function projectTool(tool: ToolView, itemId: string): AgentTestRun | undefined {
  const kind = toolKind(tool);
  if (kind !== "bash" && kind !== "powershell") return undefined;
  const fields = toolFields(tool);
  const command = jsonString(fields.command) ?? jsonString(fields.cmd) ?? jsonString(fields.target) ?? "";
  if (!command || !isTestCommand(command)) return undefined;
  const exitCode = jsonNumber(fields.exitCode) ?? jsonNumber(fields.exit);
  const durationMs = jsonNumber(fields.wallTimeMs) ?? jsonNumber(fields.durationMs);
  const cwd = jsonString(fields.cwd);
  const output = toolOutputText(fields.output ?? tool.output);
  return {
    toolCallId: tool.toolCallId,
    itemId,
    command,
    status: runStatus(tool.status, exitCode),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(output === undefined || output === "" ? {} : { output }),
    ...(tool.truncated === true || tool.result?.truncated === true ? { truncated: true } : {}),
  };
}

function toolOutputText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return undefined;
  const lines = raw.map((line) => (Array.isArray(line) ? String(line[0] ?? "") : String(line)));
  const text = lines.join("\n");
  return text === "" ? undefined : text;
}

function runStatus(status: ToolView["status"], exitCode: number | undefined): AgentTestRunStatus {
  if (status === "queued" || status === "running") return "running";
  if (status === "aborted") return "aborted";
  if (exitCode !== undefined) return exitCode === 0 ? "pass" : "fail";
  if (status === "failed" || status === "missing") return "fail";
  return "pass";
}

function tokenizeCommand(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|])/).flatMap((segment) => {
    const tokens: string[] = [];
    const matcher = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g;
    let match = matcher.exec(segment);
    while (match !== null) {
      let token = match[0] ?? "";
      if (
        (token.startsWith("\"") && token.endsWith("\"")) ||
        (token.startsWith("'") && token.endsWith("'"))
      ) {
        token = token.slice(1, -1);
      }
      if (token) tokens.push(token);
      match = matcher.exec(segment);
    }
    return tokens;
  });
}

function commandBasename(token: string): string {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const name = (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
  return name.replace(/\.(cmd|exe|bat|ps1)$/i, "");
}

function nextNonFlag(tokens: readonly string[], start: number): string | undefined {
  let index = start;
  while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
  return index < tokens.length ? tokens[index]!.toLowerCase() : undefined;
}

function isPackageManagerTest(tokens: readonly string[], start: number): boolean {
  const verbIndex = skipFlags(tokens, start);
  if (verbIndex === undefined) return false;
  const verb = tokens[verbIndex]!.toLowerCase();
  if (verb === "test") return true;
  if (STANDALONE_RUNNERS.has(commandBasename(verb))) return true;
  if (verb !== "run" && verb !== "exec") return false;
  const scriptIndex = skipFlags(tokens, verbIndex + 1);
  if (scriptIndex === undefined) return false;
  const script = tokens[scriptIndex]!.toLowerCase();
  return script === "test" || script === "tests" || script.startsWith("test:") || script.startsWith("test-")
    || STANDALONE_RUNNERS.has(commandBasename(script));
}

function isPythonPytest(tokens: readonly string[], start: number): boolean {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index] === "-m" && tokens[index + 1]?.toLowerCase() === "pytest") return true;
  }
  return false;
}

function skipFlags(tokens: readonly string[], start: number): number | undefined {
  let index = start;
  while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
  return index < tokens.length ? index : undefined;
}
