import type { JsonValue } from "@omp-studio/client-contract";
import type { TreeGitStatus } from "../git/treeStatus";
import { jsonRecord, jsonString, type AssistantSegment, type TimelineRow, type ToolStatus, type ToolView } from "./conversationViewModel";

export type ToolKind = string;

export type ThinkView = {
  readonly key: string;
  readonly text: string;
  readonly truncated?: boolean;
};

export type SubagentView = {
  readonly name: string;
  readonly status: string;
  readonly toolCallId: string;
  readonly agentId?: string;
  readonly task?: string;
  readonly activity?: string;
  readonly currentTool?: string;
  readonly dur?: string;
  readonly tokens?: string;
  readonly tools?: string | number;
  readonly requests?: string | number;
  readonly files?: string | number;
  readonly cost?: string;
};

export type SubagentHubTarget = {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly task?: string;
  readonly tokens?: string;
  readonly tools?: string | number;
  readonly requests?: string | number;
  readonly files?: string | number;
  readonly cost?: string;
};

/**
 * Registry identities from Runtime `AgentOutputManager`: the task label
 * (`deps`, `Anna-2`) or a nested child (`Anna.Bob`). Preview/Hub fixtures also
 * use `agent-<ulid>`. `Main` is the parent session, not a child card.
 * A display-only `name` without an `id`/`agentId` field is not an identity.
 */
export function isRealSubagentId(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (/^main$/i.test(value)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

export function resolveSubagentHubTarget(agent: SubagentView): SubagentHubTarget | undefined {
  if (agent.agentId === undefined || !isRealSubagentId(agent.agentId)) return undefined;
  return {
    agentId: agent.agentId,
    toolCallId: agent.toolCallId,
    ...(agent.task === undefined ? {} : { task: agent.task }),
    ...(agent.tokens === undefined ? {} : { tokens: agent.tokens }),
    ...(agent.tools === undefined ? {} : { tools: agent.tools }),
    ...(agent.requests === undefined ? {} : { requests: agent.requests }),
    ...(agent.files === undefined ? {} : { files: agent.files }),
    ...(agent.cost === undefined ? {} : { cost: agent.cost }),
  };
}

export function subagentCardKey(agent: SubagentView): string {
  return `${agent.toolCallId}:${agent.agentId ?? agent.name}`;
}

export const KIND_ICON: Record<string, string> = {
  think: "brain",
  read: "file",
  write: "file-plus",
  edit: "pencil",
  bash: "terminal",
  grep: "search",
  glob: "folder",
  ast_grep: "search",
  ast_edit: "pencil",
  ask: "message",
  askuser: "message",
  debug: "bug",
  eval: "flask",
  github: "commit",
  lsp: "cpu",
  inspect_image: "image",
  browser: "globe",
  computer: "monitor",
  checkpoint: "commit",
  rewind: "rewind",
  security_scan: "shield",
  task: "bot",
  hub: "network",
  todo: "check",
  web_search: "globe",
  web: "globe",
  retain: "archive",
  recall: "search",
  reflect: "brain",
  memory_edit: "pencil",
  learn: "book",
  manage_skill: "sparkles",
  yield: "export",
  goal: "pin",
  generate_image: "image",
  tts: "pulse",
  vibe: "zap",
  mcp: "plug",
  report_issue: "bug",
  resolve: "check",
};

export const KIND_LABEL: Record<string, string> = {
  think: "Think",
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  ast_grep: "AST Grep",
  ast_edit: "AST Edit",
  ask: "Ask",
  askuser: "Ask",
  debug: "Debug",
  eval: "Eval",
  github: "GitHub",
  lsp: "LSP",
  inspect_image: "Inspect",
  browser: "Browser",
  computer: "Computer",
  checkpoint: "Checkpoint",
  rewind: "Rewind",
  security_scan: "Security Scan",
  task: "Task",
  hub: "Hub",
  todo: "Todo",
  web_search: "Web Search",
  retain: "Retain",
  recall: "Recall",
  reflect: "Reflect",
  memory_edit: "Memory Edit",
  learn: "Learn",
  manage_skill: "Manage Skill",
  yield: "Submit Result",
  goal: "Goal",
  generate_image: "GenerateImage",
  tts: "Speech Generation",
  vibe: "Vibe",
  mcp: "MCP",
  report_issue: "Report Issue",
  resolve: "Resolve",
};

export const NAME_TO_KIND: Record<string, string> = {
  inspect: "inspect_image",
  generateimage: "generate_image",
  "speech generation": "tts",
  "vibe wait": "vibe",
  "submit result": "yield",
};

const PATH_KINDS = new Set(["read", "write", "edit", "inspect_image", "glob", "generate_image", "tts"]);

export const STATUS_LABEL: Record<ToolStatus, string> = {
  queued: "等待",
  running: "运行中",
  succeeded: "完成",
  failed: "失败",
  aborted: "已中止",
  missing: "结果缺失",
};

const MCP_NAME_PREFIX = "mcp__";

function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_NAME_PREFIX);
}

/**
 * `mcp__<server>_<tool>` → `<server>.<tool>`, split at the first underscore the
 * way upstream `parseMCPToolName` does: server names are sanitized to
 * `[a-z_]`, so the first separator is the only reliable boundary.
 */
function mcpNameBody(name: string): string {
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const separator = rest.indexOf("_");
  if (separator <= 0) return rest;
  return `${rest.slice(0, separator)}.${rest.slice(separator + 1)}`;
}

function xdevEnvelope(tool: ToolView): { readonly [key: string]: JsonValue } | undefined {
  return jsonRecord(jsonRecord(tool.result?.data)?.xdev);
}

function xdevToolName(tool: ToolView): string | undefined {
  return jsonString(xdevEnvelope(tool)?.tool);
}

function xdevOutput(inner: { readonly [key: string]: JsonValue }): string | undefined {
  const result = jsonString(inner.result);
  if (result !== undefined) return result;
  const raw = inner.rawContent;
  if (!Array.isArray(raw)) return undefined;
  const text = raw
    .map((entry) => jsonString(jsonRecord(entry)?.text))
    .filter((entry): entry is string => entry !== undefined)
    .join("\n");
  return text || undefined;
}

export function toolFields(tool: ToolView): { readonly [key: string]: JsonValue } {
  const args = jsonRecord(tool.arguments) ?? {};
  const data = jsonRecord(tool.result?.data) ?? {};
  const xdev = jsonRecord(data.xdev);
  const xdevArgs = jsonRecord(xdev?.args) ?? {};
  const xdevInner = jsonRecord(xdev?.inner) ?? {};
  const merged: { [key: string]: JsonValue } = xdev === undefined
    ? { ...data, ...args }
    : { ...data, ...args, ...xdevInner, ...xdevArgs, args: xdevArgs };
  const transportPath = jsonString(args.path);
  if (xdev !== undefined && transportPath?.startsWith("xd://")) {
    merged.transportPath = transportPath;
  }
  if (merged.output === undefined) {
    const output = tool.output ?? xdevOutput(xdevInner);
    if (output !== undefined) merged.output = output;
  }
  return merged;
}

const PLAN_PROPOSE_PATH = /^xd:\/\/propose\/?$/i;

export function isPlanProposeTool(tool: ToolView): boolean {
  if (xdevToolName(tool) === "propose") return true;
  const fields = toolFields(tool);
  const path = jsonString(fields.transportPath) ?? jsonString(fields.path) ?? jsonString(jsonRecord(tool.arguments)?.path);
  return path !== undefined && PLAN_PROPOSE_PATH.test(path.trim());
}

export type PlanProposal = {
  readonly title: string;
};

export type PlanDocument = {
  readonly title: string;
  readonly body: string;
};

export function isPlanArtifactPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return normalized.startsWith("local://") && normalized.endsWith("plan.md");
}

function planProposalTitle(tool: ToolView): string {
  const fields = toolFields(tool);
  const titled = jsonString(fields.title)?.trim();
  if (titled) return titled;
  const content = jsonString(fields.content)?.trim();
  if (!content) return "Plan";
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as JsonValue;
      const fromJson = jsonString(jsonRecord(parsed)?.title)?.trim();
      if (fromJson) return fromJson;
    } catch {
      /* slug or markdown body */
    }
  }
  if (content.length < 120 && !content.includes("\n")) return content;
  return "Plan";
}

/** Latest plan markdown + propose title from the transcript, for viewing after approval. */
export function collectLatestPlanDocument(rows: readonly TimelineRow[]): PlanDocument | undefined {
  let title = "";
  let body = "";
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    for (const segment of row.segments) {
      if (segment.type !== "batch") continue;
      for (const call of segment.tools) {
        if (call.status === "failed" || call.status === "aborted" || call.status === "missing") continue;
        if (isPlanProposeTool(call)) {
          title = planProposalTitle(call);
          continue;
        }
        if (toolKind(call) !== "write") continue;
        const fields = toolFields(call);
        const path = jsonString(fields.path) ?? jsonString(jsonRecord(call.arguments)?.path) ?? "";
        if (!isPlanArtifactPath(path)) continue;
        const content = jsonString(fields.content) ?? jsonString(jsonRecord(call.arguments)?.content);
        if (content !== undefined && content.length > 0) body = content;
      }
    }
  }
  if (title.length === 0 && body.length === 0) return undefined;
  return { title: title || "Plan", body };
}

/** Last succeeded/in-flight `xd://propose` in the slice; failed/aborted calls do not count. */
export function collectPlanProposal(segments: readonly AssistantSegment[]): PlanProposal | undefined {
  let found: PlanProposal | undefined;
  for (const segment of segments) {
    if (segment.type !== "batch") continue;
    for (const call of segment.tools) {
      if (!isPlanProposeTool(call)) continue;
      if (call.status === "failed" || call.status === "aborted" || call.status === "missing") continue;
      found = { title: planProposalTitle(call) };
    }
  }
  return found;
}

export function toolKind(tool: ToolView): ToolKind {
  const xdevTool = xdevToolName(tool);
  if (xdevTool !== undefined) {
    if (isMcpToolName(xdevTool)) return "mcp";
    if (xdevTool === "powershell") return "bash";
    return xdevTool.replace(/[\s-]+/g, "_");
  }
  const raw = tool.toolName.trim().toLowerCase();
  if (NAME_TO_KIND[raw]) return NAME_TO_KIND[raw]!;
  // Upstream mints MCP tool names as `mcp__<server>_<tool>`; the dot form only
  // appears in preview fixtures.
  if (isMcpToolName(raw) || raw.includes(".")) return "mcp";
  return raw.replace(/[\s-]+/g, "_");
}

export function toolIcon(kind: ToolKind): string {
  return KIND_ICON[kind] ?? "wrench";
}

export function toolLabel(tool: ToolView): string {
  const kind = toolKind(tool);
  const fields = toolFields(tool);
  if (kind === "mcp") {
    const server = jsonString(fields.serverName);
    const name = jsonString(fields.mcpToolName);
    if (server || name) return `MCP · ${[server, name].filter(Boolean).join(".")}`;
    const xdevTool = xdevToolName(tool);
    if (xdevTool !== undefined && isMcpToolName(xdevTool)) return `MCP · ${mcpNameBody(xdevTool)}`;
    if (isMcpToolName(tool.toolName)) return `MCP · ${mcpNameBody(tool.toolName)}`;
    return tool.toolName || "MCP";
  }
  if (xdevToolName(tool) === "powershell") return "PowerShell";
  if (kind === "vibe") return tool.toolName || `Vibe ${jsonString(fields.vibeOp) ?? ""}`.trim();
  if (kind === "think") return jsonString(fields.name) || tool.toolName || "Think";
  return KIND_LABEL[kind] ?? tool.toolName;
}

export function isPathKind(kind: ToolKind): boolean {
  return PATH_KINDS.has(kind);
}

export function statusLabel(status: ToolStatus): string {
  return STATUS_LABEL[status];
}

export function fileBase(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

export function splitDisplayPath(path: string): { readonly name: string; readonly dir: string } {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { name: normalized, dir: "" };
  return { name: normalized.slice(index + 1), dir: `${normalized.slice(0, index)}/` };
}

export function jsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function jsonStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length === value.length ? items : undefined;
}

/** Multi-question ask reports one `QuestionResult` per question instead of a flat selection. */
function askResultAnswers(fields: { readonly [key: string]: JsonValue }): string | undefined {
  if (!Array.isArray(fields.results)) return undefined;
  const picks: string[] = [];
  for (const entry of fields.results) {
    const record = jsonRecord(entry);
    const pick = jsonStringArray(record?.selectedOptions)?.[0] ?? jsonString(record?.customInput);
    if (pick) picks.push(pick);
  }
  return picks.length > 0 ? picks.join(" · ") : undefined;
}

/** Ask args are `questions[]`; there is no flat `prompt`/`question`. */
export function askQuestionText(args: { readonly [key: string]: JsonValue } | undefined): string | undefined {
  const questions = args?.questions;
  if (!Array.isArray(questions)) return undefined;
  for (const entry of questions) {
    const question = jsonString(jsonRecord(entry)?.question);
    if (question) return question;
  }
  return undefined;
}

export function askAnswer(tool: ToolView): string | undefined {
  const fields = toolFields(tool);
  const answer = jsonString(fields.answer);
  if (answer) return answer;
  const selectedOptions = jsonStringArray(fields.selectedOptions);
  if (selectedOptions?.[0]) return selectedOptions[0];
  const fromResults = askResultAnswers(fields);
  if (fromResults) return fromResults;
  const customInput = jsonString(fields.customInput);
  if (customInput) return customInput;
  const selected = jsonString(jsonRecord(tool.result?.data)?.selected);
  if (selected) return selected;
  const options = fields.options;
  if (Array.isArray(options)) {
    for (const option of options) {
      const record = jsonRecord(option);
      if (record?.selected === true) {
        const label = jsonString(record.label);
        if (label) return label;
      }
    }
  }
  const output = tool.output?.trim();
  return output ? output : undefined;
}

export function isAskPending(tool: ToolView): boolean {
  const kind = toolKind(tool);
  if (kind !== "ask" && kind !== "askuser") return false;
  if (tool.status === "succeeded" || tool.status === "failed" || tool.status === "aborted") return false;
  return askAnswer(tool) === undefined;
}

export function toolTarget(tool: ToolView): string {
  const args = jsonRecord(tool.arguments);
  const kind = toolKind(tool);
  if (kind === "bash") return jsonString(args?.command) ?? jsonString(args?.cmd) ?? "";
  if (kind === "grep" || kind === "ast_grep" || kind === "glob") {
    // ast_grep names its pattern `pat`; glob carries its pattern inside `path`.
    return (
      jsonString(args?.pattern) ??
      jsonString(args?.pat) ??
      jsonString(args?.path) ??
      jsonString(args?.glob) ??
      ""
    );
  }
  if (kind === "web_search" || kind === "web") return jsonString(args?.query) ?? jsonString(args?.url) ?? "";
  if (kind === "ask" || kind === "askuser") {
    return askAnswer(tool) ?? jsonString(args?.prompt) ?? jsonString(args?.question) ?? askQuestionText(args) ?? "";
  }
  if (kind === "task") {
    const spawn = jsonRecord(args?.spawn) ?? args;
    const tasks = spawn?.tasks;
    const n = Array.isArray(tasks) ? tasks.length : Array.isArray(args?.agents) ? args.agents.length : 0;
    if (n) return `${n} agents`;
    // Single spawn form is flat: `name` / `agent` / `task`.
    return jsonString(args?.goal) ?? jsonString(spawn?.name) ?? jsonString(spawn?.agent) ?? "";
  }
  return (
    jsonString(args?.path) ??
    jsonString(args?.target) ??
    jsonString(args?.url) ??
    jsonString(args?.goal) ??
    jsonString(args?.prompt) ??
    ""
  );
}

export function chainItemDetail(tool: ToolView): string {
  const kind = toolKind(tool);
  const fields = toolFields(tool);
  const target = jsonString(fields.target);
  if (kind === "think") {
    return jsonString(fields.preview) ?? (jsonString(fields.dur) ? `思考了 ${jsonString(fields.dur)}` : "");
  }
  if (kind === "bash") return jsonString(fields.cmd) ?? jsonString(fields.command) ?? target ?? "";
  if (kind === "grep" || kind === "ast_grep" || kind === "glob") {
    return jsonString(fields.pattern) ?? jsonString(fields.pat) ?? target ?? toolTarget(tool);
  }
  if (kind === "web_search" || kind === "web") return jsonString(fields.query) ?? target ?? "";
  if (kind === "lsp") return [jsonString(fields.action), target].filter(Boolean).join(" · ");
  if (kind === "browser") return [jsonString(fields.action), jsonString(fields.url) ?? target].filter(Boolean).join(" · ");
  if (kind === "github") return jsonString(fields.op) ?? target ?? "";
  if (kind === "eval") return jsonString(fields.lang) ?? target ?? "";
  if (kind === "todo") return jsonString(fields.op) ?? target ?? "";
  if (kind === "hub") return jsonString(fields.op) ?? target ?? jsonString(fields.hubKind) ?? "";
  if (kind === "ask" || kind === "askuser") {
    return (
      askAnswer(tool) ??
      jsonString(fields.question) ??
      jsonString(fields.prompt) ??
      askQuestionText(jsonRecord(tool.arguments)) ??
      target ??
      ""
    );
  }
  if (kind === "goal") return jsonString(fields.op) ?? jsonString(fields.objective) ?? target ?? "";
  if (kind === "vibe") return target ?? jsonString(fields.vibeOp) ?? "";
  if (kind === "mcp") {
    return jsonString(fields.mcpToolName) ?? jsonString(fields.serverName) ?? target ?? "";
  }
  if (kind === "task") {
    const spawn = jsonRecord(fields.spawn) ?? fields;
    const list = [spawn.tasks, fields.agents, fields.progress, fields.results].find((entry) => Array.isArray(entry));
    const n = Array.isArray(list) ? list.length : 0;
    return n > 1 ? `${n} agents` : toolTarget(tool);
  }
  if (kind === "debug") return jsonString(fields.action) ?? target ?? "";
  if (kind === "resolve") return jsonString(fields.action) ?? target ?? "";
  // The real target (path/command) beats a result-side summary; `summary` only
  // stands in when there is nothing addressable to show.
  return target ?? (toolTarget(tool) || jsonString(fields.summary) || jsonString(fields.query) || "");
}

export type BatchSummary = { readonly text: string; readonly add: number; readonly del: number };

export function toolDiffStats(tool: ToolView): { readonly add: number; readonly del: number } {
  const kind = toolKind(tool);
  const fields = toolFields(tool);
  if (kind === "write") {
    const explicit = jsonNumber(fields.lines);
    if (explicit !== undefined) return { add: explicit, del: 0 };
    const content = fields.content;
    if (typeof content === "string") {
      return { add: content.length === 0 ? 0 : content.split("\n").length, del: 0 };
    }
    if (Array.isArray(content)) return { add: content.length, del: 0 };
    return { add: 0, del: 0 };
  }
  if (kind !== "edit") return { add: 0, del: 0 };
  let add = 0;
  let del = 0;
  if (Array.isArray(fields.diff)) {
    for (const row of fields.diff) {
      if (!Array.isArray(row)) continue;
      if (row[0] === "+") add += 1;
      if (row[0] === "-") del += 1;
    }
  } else if (typeof fields.diff === "string") {
    for (const line of fields.diff.split("\n")) {
      if (/^\+\d*\|/.test(line)) add += 1;
      if (/^-\d*\|/.test(line)) del += 1;
    }
  }
  return { add, del };
}

export type FileEditKind = "write" | "edit" | "ast_edit";

export type TurnFileChange = {
  readonly path: string;
  readonly name: string;
  readonly dir: string;
  readonly add: number;
  readonly del: number;
  readonly status?: TreeGitStatus;
  readonly note?: string;
};

export const CHANGE_NOTE: Readonly<Record<FileEditKind, string>> = {
  write: "Write",
  edit: "Edit",
  ast_edit: "AST Edit",
};

function asFileEditKind(kind: string): FileEditKind | undefined {
  return kind === "write" || kind === "edit" || kind === "ast_edit" ? kind : undefined;
}

function changeStatus(add: number, del: number, kinds: readonly FileEditKind[]): TreeGitStatus {
  const writeOnly = kinds.length > 0 && kinds.every((kind) => kind === "write");
  if (writeOnly && del === 0) return "added";
  if (add === 0 && del > 0) return "deleted";
  return "modified";
}

function changeNote(kinds: readonly FileEditKind[]): string | undefined {
  const last = kinds.at(-1);
  return last === undefined ? undefined : CHANGE_NOTE[last];
}

function toolFilePath(tool: ToolView): string | undefined {
  const fields = toolFields(tool);
  return jsonString(fields.path) ?? jsonString(fields.resolvedPath) ?? jsonString(fields.target);
}

type FileChangeAcc = { add: number; del: number; kinds: FileEditKind[] };

function addTurnFile(
  files: Map<string, FileChangeAcc>,
  path: string | undefined,
  add: number,
  del: number,
  kind: FileEditKind,
): void {
  if (path === undefined) return;
  const normalized = path.replaceAll("\\", "/").trim();
  if (!normalized || normalized.includes(" → ") || normalized.toLowerCase().startsWith("xd://")) return;
  const previous = files.get(normalized);
  files.set(normalized, previous === undefined
    ? { add, del, kinds: [kind] }
    : { add: previous.add + add, del: previous.del + del, kinds: [...previous.kinds, kind] });
}

function collectToolFileChanges(tool: ToolView, files: Map<string, FileChangeAcc>): void {
  if (tool.status !== "succeeded") return;
  const kind = asFileEditKind(toolKind(tool));
  if (kind === undefined) return;
  const fields = toolFields(tool);
  if (kind === "ast_edit") {
    if (Array.isArray(fields.changes)) {
      for (const entry of fields.changes) {
        const record = jsonRecord(entry);
        const file = jsonString(record?.file);
        if (file === undefined) continue;
        const before = jsonString(record?.before);
        const after = jsonString(record?.after);
        addTurnFile(files, file, after ? 1 : 0, before ? 1 : 0, kind);
      }
      return;
    }
    // Upstream reports per-file replacement counts, not before/after text; each
    // replacement rewrites one span, so it counts as one removal plus one add.
    if (Array.isArray(fields.fileReplacements)) {
      for (const entry of fields.fileReplacements) {
        const record = jsonRecord(entry);
        const file = jsonString(record?.path);
        const count = jsonNumber(record?.count);
        if (file === undefined || count === undefined || count <= 0) continue;
        addTurnFile(files, file, count, count, kind);
      }
    }
    return;
  }
  const diff = toolDiffStats(tool);
  addTurnFile(files, toolFilePath(tool), diff.add, diff.del, kind);
}

export function collectTurnFileChanges(segments: readonly AssistantSegment[]): TurnFileChange[] {
  const files = new Map<string, FileChangeAcc>();
  for (const segment of segments) {
    if (segment.type !== "batch") continue;
    for (const tool of segment.tools) collectToolFileChanges(tool, files);
  }
  const changes: TurnFileChange[] = [];
  for (const [path, stats] of files) {
    const display = splitDisplayPath(path);
    const note = changeNote(stats.kinds);
    changes.push({
      path,
      name: display.name,
      dir: display.dir,
      add: stats.add,
      del: stats.del,
      status: changeStatus(stats.add, stats.del, stats.kinds),
      ...(note === undefined ? {} : { note }),
    });
  }
  return changes;
}

export function hasAssistantText(segments: readonly AssistantSegment[]): boolean {
  return segments.some((segment) => segment.type === "text" && segment.text.trim().length > 0);
}

/* ---------- 会话级变更（右侧 Changes 页签） ---------- */

/** 连续 assistant 行的闭区间；非 assistant 行切开一轮。 */
export type AssistantRunRange = {
  readonly start: number;
  readonly end: number;
};

export const SESSION_CHANGE_LAST_ID = "last";
export const SESSION_CHANGE_SESSION_ID = "session";

export type SessionChangeTurnKind = "last" | "turn" | "session";

export type SessionChangeTurn = {
  readonly id: string;
  readonly kind: SessionChangeTurnKind;
  readonly label: string;
  readonly files: readonly TurnFileChange[];
};

export type SessionChangeScope = {
  readonly id: string;
  readonly kind: SessionChangeTurnKind;
  readonly label: string;
  readonly files: readonly TurnFileChange[];
  readonly segments: readonly AssistantSegment[];
};

/** 非 assistant 行切开的连续 assistant 段。与对话 TurnDiffCard 的 turn 口径一致。 */
export function assistantRunRanges(rows: readonly TimelineRow[]): readonly AssistantRunRange[] {
  const ranges: AssistantRunRange[] = [];
  let start = -1;
  const flush = (endExclusive: number) => {
    if (start >= 0 && endExclusive > start) ranges.push({ start, end: endExclusive - 1 });
    start = -1;
  };
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.type === "assistant") {
      if (start < 0) start = index;
      continue;
    }
    flush(index);
  }
  flush(rows.length);
  return ranges;
}

function rangeTurnId(rows: readonly TimelineRow[], range: AssistantRunRange): string {
  const row = rows[range.end];
  return row?.type === "assistant" ? row.itemId : `turn:${range.start}-${range.end}`;
}

/** 与 `listSessionChangeTurns` 同一套 id：最后一段为 last，其余为该段末行 itemId。 */
export function sessionChangeTurnIdForRange(
  rows: readonly TimelineRow[],
  range: AssistantRunRange,
  ranges: readonly AssistantRunRange[] = assistantRunRanges(rows),
): string {
  const last = ranges[ranges.length - 1];
  if (last !== undefined && last.start === range.start && last.end === range.end) {
    return SESSION_CHANGE_LAST_ID;
  }
  return rangeTurnId(rows, range);
}

function filesInRange(rows: readonly TimelineRow[], range: AssistantRunRange): TurnFileChange[] {
  const segments: AssistantSegment[] = [];
  for (let i = range.start; i <= range.end; i += 1) {
    const row = rows[i];
    if (row?.type === "assistant") segments.push(...row.segments);
  }
  return collectTurnFileChanges(segments);
}

function segmentsInRange(rows: readonly TimelineRow[], range: AssistantRunRange): readonly AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (let i = range.start; i <= range.end; i += 1) {
    const row = rows[i];
    if (row?.type === "assistant") segments.push(...row.segments);
  }
  return segments;
}

function allAssistantSegments(rows: readonly TimelineRow[]): readonly AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const row of rows) {
    if (row.type === "assistant") segments.push(...row.segments);
  }
  return segments;
}

function changePathMatches(path: string, focus: string): boolean {
  const value = path.replaceAll("\\", "/");
  const normalized = focus.replaceAll("\\", "/");
  return value === normalized || value.endsWith(`/${normalized}`) || normalized.endsWith(`/${value}`);
}

/** 轮次菜单：最近一轮（跟随最新段）+ 有改动的历史轮 + 本会话。 */
export function listSessionChangeTurns(rows: readonly TimelineRow[]): SessionChangeTurn[] {
  const ranges = assistantRunRanges(rows);
  const last = ranges[ranges.length - 1];
  const items: SessionChangeTurn[] = [{
    id: SESSION_CHANGE_LAST_ID,
    kind: "last",
    label: "最近一轮",
    files: last === undefined ? [] : filesInRange(rows, last),
  }];
  let historyIndex = 0;
  for (let index = 0; index < ranges.length - 1; index += 1) {
    const range = ranges[index]!;
    const files = filesInRange(rows, range);
    if (files.length === 0) continue;
    historyIndex += 1;
    items.push({
      id: rangeTurnId(rows, range),
      kind: "turn",
      label: `第 ${historyIndex} 轮`,
      files,
    });
  }
  items.push({
    id: SESSION_CHANGE_SESSION_ID,
    kind: "session",
    label: "本会话",
    files: collectTurnFileChanges(allAssistantSegments(rows)),
  });
  return items;
}

/** 选中轮次的文件清单与 patch 段。未知 id 回退到最近一轮。 */
export function sessionChangeScope(rows: readonly TimelineRow[], turnId: string): SessionChangeScope {
  if (turnId === SESSION_CHANGE_SESSION_ID) {
    const segments = allAssistantSegments(rows);
    return {
      id: SESSION_CHANGE_SESSION_ID,
      kind: "session",
      label: "本会话",
      files: collectTurnFileChanges(segments),
      segments,
    };
  }
  const ranges = assistantRunRanges(rows);
  if (turnId !== SESSION_CHANGE_LAST_ID) {
    let historyIndex = 0;
    for (let index = 0; index < ranges.length - 1; index += 1) {
      const range = ranges[index]!;
      const files = filesInRange(rows, range);
      if (files.length === 0) continue;
      historyIndex += 1;
      if (rangeTurnId(rows, range) !== turnId) continue;
      return {
        id: turnId,
        kind: "turn",
        label: `第 ${historyIndex} 轮`,
        files,
        segments: segmentsInRange(rows, range),
      };
    }
  }
  const last = ranges[ranges.length - 1];
  return {
    id: SESSION_CHANGE_LAST_ID,
    kind: "last",
    label: "最近一轮",
    files: last === undefined ? [] : filesInRange(rows, last),
    segments: last === undefined ? [] : segmentsInRange(rows, last),
  };
}

/** 从后往前找改过该路径的一轮；最后一段用 last id，便于跟随新 turn。 */
export function sessionChangeTurnIdForPath(rows: readonly TimelineRow[], path: string): string | undefined {
  const ranges = assistantRunRanges(rows);
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    if (!filesInRange(rows, range).some((file) => changePathMatches(file.path, path))) continue;
    return index === ranges.length - 1 ? SESSION_CHANGE_LAST_ID : rangeTurnId(rows, range);
  }
  return undefined;
}

// --- Deleted: WeakMap segment caches, session patch tree builder, todo state machine, progress aggregation ---

export function batchSummary(thinking: readonly ThinkView[], tools: readonly ToolView[]): BatchSummary {
  const files = new Set<string>();
  let searches = 0;
  let commands = 0;
  let fetches = 0;
  let agents = 0;
  let asks = 0;
  let editing = "";
  let editingRun = false;
  let thinkDur = "";
  let askFirst = "";
  let add = 0;
  let del = 0;
  for (const tool of tools) {
    if (isAskPending(tool)) continue;
    const kind = toolKind(tool);
    const fields = toolFields(tool);
    const path = jsonString(fields.path) ?? jsonString(fields.target);
    if (kind === "think") thinkDur = jsonString(fields.dur) ?? thinkDur;
    if (kind === "read" || kind === "write" || kind === "edit") {
      if (path) files.add(path);
      if (kind === "edit" || kind === "write") {
        editing = path ?? editing;
        editingRun = tool.status === "running" || tool.status === "queued";
      }
    }
    if (kind === "grep" || kind === "ast_grep" || kind === "glob") searches += 1;
    if (kind === "bash") commands += 1;
    if (kind === "web" || kind === "web_search" || kind === "mcp" || kind === "browser" || kind === "github") fetches += 1;
    if (kind === "task") {
      const list = fields.agents;
      if (Array.isArray(list)) agents += list.length;
    }
    if (kind === "ask" || kind === "askuser") {
      const answer = askAnswer(tool);
      if (answer) {
        asks += 1;
        if (!askFirst) askFirst = answer;
      }
    }
    const diff = toolDiffStats(tool);
    add += diff.add;
    del += diff.del;
  }
  const parts: string[] = [];
  if (editing) parts.push(`${editingRun ? "正在编辑 " : "编辑 "}${fileBase(editing)}`);
  if (files.size) parts.push(`阅读 ${files.size} 个文件`);
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (commands) parts.push(`运行 ${commands} 条命令`);
  if (fetches) parts.push(`请求 ${fetches} 次`);
  if (agents) parts.push(`${agents} 个子 Agent`);
  if (asks === 1 && askFirst && parts.length === 0) parts.push(`Ask · ${askFirst}`);
  else if (asks) parts.push(`回答 ${asks} 次`);
  if (parts.length === 0 && thinkDur) parts.push(`思考了 ${thinkDur}`);
  if (parts.length === 0 && thinking.length > 0) {
    const preview = thinking[0]?.text.trim().replace(/\s+/g, " ") ?? "";
    parts.push(preview ? `思考 · ${preview.slice(0, 36)}${preview.length > 36 ? "…" : ""}` : "思考");
  }
  if (parts.length === 0) parts.push("工具调用");
  return { text: parts.join(" · "), add, del };
}

function metricValue(value: JsonValue | undefined): string | number | undefined {
  const text = jsonString(value);
  if (text !== undefined) return text;
  return jsonNumber(value);
}

function taskTextForName(args: { readonly [key: string]: JsonValue } | undefined, name: string): string | undefined {
  if (!args) return undefined;
  const spawn = jsonRecord(args.spawn) ?? args;
  const tasks = spawn.tasks;
  if (Array.isArray(tasks)) {
    for (const entry of tasks) {
      const record = jsonRecord(entry);
      if (jsonString(record?.name) === name) return jsonString(record?.task);
    }
  }
  return jsonString(spawn.task);
}

export function collectAgents(tools: readonly ToolView[]): SubagentView[] {
  const out: SubagentView[] = [];
  for (const tool of tools) {
    if (toolKind(tool) !== "task") continue;
    const fields = toolFields(tool);
    // `progress` is the live view; `results` is what a finished spawn reports.
    const agents = Array.isArray(fields.progress)
      ? fields.progress
      : Array.isArray(fields.results)
        ? fields.results
        : fields.agents;
    if (!Array.isArray(agents)) continue;
    for (const entry of agents) {
      const record = jsonRecord(entry);
      const rawId = jsonString(record?.agentId) ?? jsonString(record?.id);
      const name = jsonString(record?.name) ?? rawId ?? jsonString(record?.agent);
      if (!name) continue;
      const agentId = rawId !== undefined && isRealSubagentId(rawId) ? rawId : undefined;
      const task = jsonString(record?.task) ?? jsonString(record?.assignment) ?? taskTextForName(jsonRecord(tool.arguments), name);
      const status = jsonString(record?.status) ?? "done";
      const durationMs = jsonNumber(record?.durationMs);
      const dur = jsonString(record?.dur) ?? (durationMs === undefined ? undefined : `${(durationMs / 1000).toFixed(1)}s`);
      const rawTokens = jsonString(record?.tokens);
      const tokens = rawTokens === "[redacted]"
        ? undefined
        : rawTokens ?? (jsonNumber(record?.tokens) === undefined ? undefined : String(jsonNumber(record?.tokens)));
      const toolsCount = metricValue(record?.tools);
      const requests = metricValue(record?.requests);
      const files = metricValue(record?.files);
      const rawCost = jsonString(record?.cost);
      const cost = rawCost === "[redacted]" ? undefined : rawCost;
      const activity = jsonString(record?.activity);
      const currentTool = jsonString(jsonRecord(record?.currentTool)?.name);
      out.push({
        name,
        status,
        toolCallId: tool.toolCallId,
        ...(agentId === undefined ? {} : { agentId }),
        ...(task === undefined ? {} : { task }),
        ...(activity === undefined ? {} : { activity }),
        ...(currentTool === undefined ? {} : { currentTool }),
        ...(dur === undefined ? {} : { dur }),
        ...(tokens === undefined ? {} : { tokens }),
        ...(toolsCount === undefined ? {} : { tools: toolsCount }),
        ...(requests === undefined ? {} : { requests }),
        ...(files === undefined ? {} : { files }),
        ...(cost === undefined ? {} : { cost }),
      });
    }
  }
  return out;
}

export function parseTaskBrief(args: { readonly [key: string]: JsonValue } | undefined): { goal: string; constraints: string[] } {
  if (!args) return { goal: "", constraints: [] };
  // Upstream has no `spawn` wrapper: the batch form is `{ context, tasks[] }`
  // and the single form is flat `{ agent, task }`.
  const spawn = jsonRecord(args.spawn) ?? args;
  const goal = jsonString(spawn.goal) ?? jsonString(args.goal) ?? jsonString(spawn.task);
  const constraints = jsonStringArray(spawn.constraints) ?? jsonStringArray(args.constraints);
  if (goal || (constraints && constraints.length)) {
    return { goal: goal ?? "", constraints: constraints ?? [] };
  }
  const ctx = jsonString(spawn.context);
  if (!ctx?.trim()) return { goal: "", constraints: [] };
  const goalLines: string[] = [];
  const constraintLines: string[] = [];
  let mode = "";
  for (const line of ctx.split("\n")) {
    const heading = line.trim();
    if (/^#+\s*goal\b/i.test(heading)) {
      mode = "goal";
      continue;
    }
    if (/^#+\s*constraints\b/i.test(heading)) {
      mode = "constraints";
      continue;
    }
    if (/^#+\s+/.test(heading)) {
      mode = "";
      continue;
    }
    if (!heading) continue;
    if (mode === "goal") goalLines.push(heading.replace(/^[-*]\s+/, ""));
    else if (mode === "constraints") constraintLines.push(heading.replace(/^[-*]\s+/, ""));
  }
  if (!goalLines.length && !constraintLines.length) return { goal: ctx.trim(), constraints: [] };
  return { goal: goalLines.join("\n"), constraints: constraintLines };
}

export function taskJobs(args: { readonly [key: string]: JsonValue } | undefined): Array<{ name: string; agent?: string }> {
  if (!args) return [];
  const spawn = jsonRecord(args.spawn) ?? args;
  const tasks = spawn.tasks;
  if (!Array.isArray(tasks)) return [];
  const jobs: Array<{ name: string; agent?: string }> = [];
  for (const entry of tasks) {
    const record = jsonRecord(entry);
    const name = jsonString(record?.name);
    if (!name) continue;
    const agent = jsonString(record?.agent) ?? jsonString(spawn.agent);
    jobs.push(agent ? { name, agent } : { name });
  }
  return jobs;
}

export function saPill(agent: SubagentView | string): { cls: string; label: string } {
  const status = typeof agent === "string" ? agent : agent.status;
  const activity = typeof agent === "string" ? undefined : agent.activity;
  const currentTool = typeof agent === "string" ? undefined : agent.currentTool;
  if (status === "running") {
    if (activity === "tool" || currentTool) {
      return { cls: "tool", label: currentTool ? `Running Tool · ${currentTool}` : "Running Tool" };
    }
    return { cls: "thinking", label: "Thinking" };
  }
  if (status === "starting" || status === "reviving") return { cls: "thinking", label: "Starting" };
  if (status === "waiting") return { cls: "waiting", label: "Waiting for User" };
  if (status === "error" || status === "failed") return { cls: "aborted", label: "Failed" };
  if (status === "aborted") return { cls: "aborted", label: "Aborted" };
  if (status === "done" || status === "succeeded" || status === "completed" || status === "released") {
    return { cls: "idle", label: "Done" };
  }
  if (status === "idle") return { cls: "idle", label: "Idle" };
  if (status === "parked") return { cls: "parked", label: "Parked" };
  if (status === "pending") return { cls: "parked", label: "Pending" };
  return { cls: "parked", label: status };
}
