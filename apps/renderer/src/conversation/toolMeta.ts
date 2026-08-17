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
};

/** Hub identities look like `agent-019fcb01`; task names such as `deps` are display-only. */
export function isRealSubagentId(value: string): boolean {
  if (value.length === 0) return false;
  if (/^agent-[0-9a-z]+$/i.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  return false;
}

export function resolveSubagentHubTarget(agent: SubagentView): SubagentHubTarget | undefined {
  if (agent.agentId === undefined || !isRealSubagentId(agent.agentId)) return undefined;
  return {
    agentId: agent.agentId,
    toolCallId: agent.toolCallId,
    ...(agent.task === undefined ? {} : { task: agent.task }),
  };
}

export function subagentCardKey(agent: SubagentView): string {
  return `${agent.toolCallId}:${agent.agentId ?? agent.name}`;
}

const KIND_ICON: Record<string, string> = {
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

const KIND_LABEL: Record<string, string> = {
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

const NAME_TO_KIND: Record<string, string> = {
  inspect: "inspect_image",
  generateimage: "generate_image",
  "speech generation": "tts",
  "vibe wait": "vibe",
  "submit result": "yield",
};

const PATH_KINDS = new Set(["read", "write", "edit", "inspect_image", "glob", "generate_image", "tts"]);

const STATUS_LABEL: Record<ToolStatus, string> = {
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
function askQuestionText(args: { readonly [key: string]: JsonValue } | undefined): string | undefined {
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

const CHANGE_NOTE: Readonly<Record<FileEditKind, string>> = {
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
  if (!normalized || normalized.includes(" → ")) return;
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

/* ---------- 会话级变更（右侧 Changes 页签） ---------- */

export type SessionPatchMark = "+" | "-" | " ";

/** 单文件的一段 patch：保留旧/新行号，供 Changes Diff 双栏 gutter 使用。 */
export type SessionPatchLine = {
  readonly mark: SessionPatchMark;
  readonly oldLn: string;
  readonly newLn: string;
  readonly text: string;
};

export type SessionPatchBlock = {
  readonly kind: FileEditKind;
  readonly lines: readonly SessionPatchLine[];
  readonly truncated?: boolean;
};

/** write 全量内容按 + 行渲染的截断上限，超出部分丢弃并打 truncated 标记。 */
const PATCH_LINE_CAP = 500;

function normalizedPatchPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const normalized = path.replaceAll("\\", "/").trim();
  return normalized !== "" && !normalized.includes(" → ") ? normalized : undefined;
}

function patchMark(value: unknown): SessionPatchMark {
  return value === "+" || value === "-" ? value : " ";
}

function numberedPatchLine(mark: SessionPatchMark, ln: string, text: string): SessionPatchLine {
  return {
    mark,
    oldLn: mark === "+" ? "" : ln,
    newLn: mark === "-" ? "" : ln,
    text,
  };
}

/** edit 工具 diff 字段 → 统一 patch 行。解析口径与 ToolBody 的 EditBody 完全一致：
    数组行 [mark, 旧行号, 新行号, 文本]、字符串行 `mark 行号|文本`（不匹配视为上下文行）。 */
function editPatchLines(diff: JsonValue | undefined): SessionPatchLine[] {
  const lines: SessionPatchLine[] = [];
  if (Array.isArray(diff)) {
    for (const row of diff) {
      if (!Array.isArray(row)) continue;
      lines.push({
        mark: patchMark(row[0]),
        oldLn: String(row[1] ?? ""),
        newLn: String(row[2] ?? ""),
        text: String(row[3] ?? ""),
      });
    }
  } else if (typeof diff === "string" && diff.length > 0) {
    for (const line of diff.split("\n")) {
      const match = /^([ +\-])(\d*)\|(.*)$/.exec(line);
      if (match === null) {
        lines.push({ mark: " ", oldLn: "", newLn: "", text: line });
        continue;
      }
      lines.push(numberedPatchLine(patchMark(match[1]), match[2] ?? "", match[3] ?? ""));
    }
  }
  return lines;
}

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const GROUPED_HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const GROUPED_HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;
const GROUPED_BODY_RE = /^([ +\-])(\d*)│(.*)$/;

/**
 * ast_edit only reports per-file replacement counts as data; the changed line
 * text lives in its grouped `displayContent` tree — `# dir/` headers one `#` per
 * level, `## file.ts (2 replacements)` file headers, then `-468│text` body
 * lines. Rebuild cwd-relative paths from the header stack the same way upstream
 * `classifyGroupedLines` does, so the Changes tab can show a real patch body.
 */
function astEditDisplayPatches(display: string): Map<string, SessionPatchLine[]> {
  const byFile = new Map<string, SessionPatchLine[]>();
  const dirAtDepth = new Map<number, string>();
  let current: SessionPatchLine[] | undefined;
  for (const line of display.split("\n")) {
    const header = GROUPED_HEADER_RE.exec(line);
    if (header === null) {
      const body = GROUPED_BODY_RE.exec(line);
      if (body !== null && current !== undefined) {
        current.push(numberedPatchLine(patchMark(body[1]), body[2] ?? "", body[3] ?? ""));
      }
      continue;
    }
    const depth = header[1]!.length;
    const rest = header[2]!.trimEnd().replace(GROUPED_HEADER_SUFFIX_RE, "");
    for (const level of [...dirAtDepth.keys()]) {
      if (level >= depth) dirAtDepth.delete(level);
    }
    const parent = depth > 1 ? dirAtDepth.get(depth - 1) : undefined;
    const joined = (name: string) => (parent === undefined ? name : `${parent}/${name}`);
    current = undefined;
    if (rest.endsWith("/")) {
      const name = rest.slice(0, -1);
      if (name !== "") dirAtDepth.set(depth, joined(name));
      continue;
    }
    const name = rest.replace(GROUPED_HEADER_HASH_TAG_RE, "");
    if (name === "") continue;
    const file = normalizedPatchPath(joined(name));
    if (file === undefined) continue;
    current = byFile.get(file) ?? [];
    byFile.set(file, current);
  }
  return byFile;
}

/** 从 assistant 段按时间序聚出每个文件的 patch 块（edit 的 diff / write 的内容 / ast_edit 的 before-after）。
    与 collectToolFileChanges 同口径：只收 succeeded 工具、跳过重命名展示串。 */
export function sessionFilePatches(segments: readonly AssistantSegment[]): Map<string, SessionPatchBlock[]> {
  const patches = new Map<string, SessionPatchBlock[]>();
  const push = (path: string, block: SessionPatchBlock) => {
    const blocks = patches.get(path);
    if (blocks === undefined) patches.set(path, [block]);
    else blocks.push(block);
  };
  for (const segment of segments) {
    if (segment.type !== "batch") continue;
    for (const tool of segment.tools) {
      if (tool.status !== "succeeded") continue;
      const kind = asFileEditKind(toolKind(tool));
      if (kind === undefined) continue;
      const fields = toolFields(tool);
      if (kind === "ast_edit") {
        if (Array.isArray(fields.changes)) {
          // 一个 ast_edit 可改多文件：按 file 归组，before → - 行、after → + 行。
          const byFile = new Map<string, SessionPatchLine[]>();
          for (const entry of fields.changes) {
            const record = jsonRecord(entry);
            const file = normalizedPatchPath(jsonString(record?.file));
            if (file === undefined) continue;
            const before = jsonString(record?.before);
            const after = jsonString(record?.after);
            const lines = byFile.get(file) ?? [];
            if (before !== undefined) lines.push({ mark: "-", oldLn: "", newLn: "", text: before });
            if (after !== undefined) lines.push({ mark: "+", oldLn: "", newLn: "", text: after });
            byFile.set(file, lines);
          }
          for (const [file, lines] of byFile) push(file, { kind: "ast_edit", lines });
          continue;
        }
        const display = jsonString(fields.displayContent);
        if (display !== undefined) {
          for (const [file, lines] of astEditDisplayPatches(display)) {
            if (lines.length > 0) push(file, { kind: "ast_edit", lines });
          }
        }
        continue;
      }
      const path = normalizedPatchPath(toolFilePath(tool));
      if (path === undefined) continue;
      if (kind === "write") {
        const content = fields.content;
        let raw: string[] | undefined;
        if (typeof content === "string") raw = content.length === 0 ? [] : content.split("\n");
        else if (Array.isArray(content)) raw = content.map((entry) => String(entry));
        if (raw === undefined) continue;
        const truncated = raw.length > PATCH_LINE_CAP;
        push(path, {
          kind: "write",
          lines: raw.slice(0, PATCH_LINE_CAP).map((line, index) => ({
            mark: "+",
            oldLn: "",
            newLn: String(index + 1),
            text: line,
          })),
          ...(truncated ? { truncated: true } : {}),
        });
        continue;
      }
      const lines = editPatchLines(fields.diff);
      if (lines.length > 0) push(path, { kind: "edit", lines });
    }
  }
  return patches;
}

export type SessionFileChanges = {
  /** 当前 Turn：最后一段连续 assistant 行（含流式中），与 TaskProgressDock 口径一致。 */
  readonly turn: readonly TurnFileChange[];
  /** 本会话累积：全部 assistant 段。 */
  readonly session: readonly TurnFileChange[];
};

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

function assistantSegmentsOf(rows: readonly TimelineRow[]): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const row of rows) {
    if (row.type === "assistant") segments.push(...row.segments);
  }
  return segments;
}

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

function lastAssistantRunRange(rows: readonly TimelineRow[]): AssistantRunRange | undefined {
  const ranges = assistantRunRanges(rows);
  return ranges[ranges.length - 1];
}

function rangeTurnId(rows: readonly TimelineRow[], range: AssistantRunRange): string {
  const row = rows[range.end];
  return row?.type === "assistant" ? row.itemId : `turn:${range.start}-${range.end}`;
}

function filesInRange(rows: readonly TimelineRow[], range: AssistantRunRange): TurnFileChange[] {
  return collectTurnFileChanges(assistantSegmentsOf(rows.slice(range.start, range.end + 1)));
}

function segmentsInRange(rows: readonly TimelineRow[], range: AssistantRunRange): AssistantSegment[] {
  return assistantSegmentsOf(rows.slice(range.start, range.end + 1));
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
    files: collectTurnFileChanges(assistantSegmentsOf(rows)),
  });
  return items;
}

/** 选中轮次的文件清单与 patch 段。未知 id 回退到最近一轮。 */
export function sessionChangeScope(rows: readonly TimelineRow[], turnId: string): SessionChangeScope {
  if (turnId === SESSION_CHANGE_SESSION_ID) {
    return {
      id: SESSION_CHANGE_SESSION_ID,
      kind: "session",
      label: "本会话",
      files: collectTurnFileChanges(assistantSegmentsOf(rows)),
      segments: assistantSegmentsOf(rows),
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

/** 会话变更视图：当前 Turn 与本会话累积两组文件清单。 */
export function sessionFileChanges(rows: readonly TimelineRow[]): SessionFileChanges {
  const run = lastAssistantRunRange(rows);
  return {
    turn: run === undefined ? [] : filesInRange(rows, run),
    session: collectTurnFileChanges(assistantSegmentsOf(rows)),
  };
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export type TodoTask = {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly phase?: string;
};

export type TaskProgress = {
  readonly todos: readonly TodoTask[];
  readonly files: readonly TurnFileChange[];
};

export type TodoPhaseGroup = {
  readonly phase: string | undefined;
  readonly tasks: readonly TodoTask[];
};

/** Native flattened `init { items }` uses this phase name. */
const DEFAULT_TODO_PHASE = "Tasks";

export function groupTodosByPhase(todos: readonly TodoTask[]): TodoPhaseGroup[] {
  const groups: Array<{ phase: string | undefined; tasks: TodoTask[] }> = [];
  const indexByPhase = new Map<string | undefined, number>();
  for (const todo of todos) {
    const key = todo.phase;
    let index = indexByPhase.get(key);
    if (index === undefined) {
      index = groups.length;
      indexByPhase.set(key, index);
      groups.push({ phase: key, tasks: [] });
    }
    groups[index]!.tasks.push(todo);
  }
  return groups;
}

export function todoPhaseHeadersVisible(groups: readonly TodoPhaseGroup[]): boolean {
  if (groups.length > 1) return groups.some((group) => group.phase !== undefined);
  const name = groups[0]?.phase;
  return name !== undefined && name !== DEFAULT_TODO_PHASE;
}

export function isTodoPhaseComplete(group: TodoPhaseGroup): boolean {
  return group.tasks.length > 0 && group.tasks.every((task) => task.status === "completed" || task.status === "abandoned");
}

export function todoPhaseOpenByDefault(groups: readonly TodoPhaseGroup[]): boolean[] {
  if (groups.length === 0) return [];
  if (groups.every(isTodoPhaseComplete)) return groups.map(() => true);
  return groups.map((group) => !isTodoPhaseComplete(group));
}

const TODO_STATUS: Record<string, TodoStatus> = {
  pending: "pending",
  todo: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  doing: "in_progress",
  completed: "completed",
  done: "completed",
  abandoned: "abandoned",
  blocked: "blocked",
};

function todoStatusOf(raw: string | undefined): TodoStatus {
  return TODO_STATUS[raw?.trim().toLowerCase() ?? ""] ?? "pending";
}

function todoContentOf(task: { readonly [key: string]: JsonValue }): string | undefined {
  return jsonString(task.content) ?? jsonString(task.text) ?? jsonString(task.label);
}

function tasksFromTodoFields(fields: { readonly [key: string]: JsonValue }): TodoTask[] {
  const out: TodoTask[] = [];
  const pushTask = (entry: JsonValue, phase: string | undefined, index: number) => {
    const record = jsonRecord(entry);
    if (record === undefined) return;
    const content = todoContentOf(record);
    if (content === undefined || content.trim().length === 0) return;
    const id = jsonString(record.id) ?? `${phase ?? "todo"}-${index}`;
    out.push({
      id,
      content,
      status: todoStatusOf(jsonString(record.status)),
      ...(phase === undefined ? {} : { phase }),
    });
  };
  if (Array.isArray(fields.phases)) {
    for (const [phaseIndex, entry] of fields.phases.entries()) {
      const phase = jsonRecord(entry) ?? {};
      const name = jsonString(phase.name) ?? `phase-${phaseIndex}`;
      const tasks = Array.isArray(phase.tasks) ? phase.tasks : Array.isArray(phase.items) ? phase.items : [];
      for (const [taskIndex, task] of tasks.entries()) pushTask(task, name, out.length + taskIndex);
    }
  }
  if (out.length > 0) return out;
  const items = Array.isArray(fields.items) ? fields.items : Array.isArray(fields.list) ? fields.list : [];
  for (const [index, item] of items.entries()) pushTask(item, undefined, index);
  return out;
}

function extractTodoSnapshot(tool: ToolView): TodoTask[] | undefined {
  if (toolKind(tool) !== "todo") return undefined;
  const fields = toolFields(tool);
  const tasks = tasksFromTodoFields(fields);
  if (tasks.length > 0) return tasks;
  const op = jsonString(fields.op)?.toLowerCase();
  if (op === "clear" || op === "rm" || op === "reset") return [];
  return undefined;
}

export function collectLatestTodos(segments: readonly AssistantSegment[]): TodoTask[] {
  let latest: TodoTask[] = [];
  for (const segment of segments) {
    if (segment.type !== "batch") continue;
    for (const tool of segment.tools) {
      const snapshot = extractTodoSnapshot(tool);
      if (snapshot !== undefined) latest = snapshot;
    }
  }
  return latest;
}

export function todoStepProgress(todos: readonly TodoTask[]): { current: number; total: number; completed: number } {
  const active = todos.filter((task) => task.status !== "abandoned");
  const total = active.length;
  const completed = active.filter((task) => task.status === "completed").length;
  const inProgress = active.findIndex((task) => task.status === "in_progress");
  if (total === 0) return { current: 0, total: 0, completed: 0 };
  if (inProgress >= 0) return { current: inProgress + 1, total, completed };
  if (completed >= total) return { current: total, total, completed };
  return { current: Math.min(total, completed + 1), total, completed };
}

/** Session HUD: latest todo snapshot plus files from the current (possibly streaming) turn. */
export function sessionTaskProgress(rows: readonly TimelineRow[]): TaskProgress {
  const todos = collectLatestTodos(assistantSegmentsOf(rows));
  const run = lastAssistantRunRange(rows);
  if (run === undefined) return { todos, files: [] };
  return { todos, files: collectTurnFileChanges(assistantSegmentsOf(rows.slice(run.start, run.end + 1))) };
}

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
      const name = jsonString(record?.name) ?? jsonString(record?.agent) ?? rawId;
      if (!name) continue;
      const agentId = rawId !== undefined && isRealSubagentId(rawId) ? rawId : undefined;
      const task = jsonString(record?.task) ?? jsonString(record?.assignment) ?? taskTextForName(jsonRecord(tool.arguments), name);
      const status = jsonString(record?.status) ?? "done";
      const durationMs = jsonNumber(record?.durationMs);
      const dur = jsonString(record?.dur) ?? (durationMs === undefined ? undefined : `${(durationMs / 1000).toFixed(1)}s`);
      const tokens = jsonString(record?.tokens) ?? (jsonNumber(record?.tokens) === undefined ? undefined : String(jsonNumber(record?.tokens)));
      const toolsCount = metricValue(record?.tools);
      const requests = metricValue(record?.requests);
      const files = metricValue(record?.files);
      const cost = jsonString(record?.cost);
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
  if (status === "waiting") return { cls: "waiting", label: "Waiting for User" };
  if (status === "error" || status === "failed") return { cls: "aborted", label: "Failed" };
  if (status === "aborted") return { cls: "aborted", label: "Aborted" };
  if (status === "done" || status === "succeeded" || status === "completed") return { cls: "idle", label: "Done" };
  return { cls: "parked", label: status };
}
