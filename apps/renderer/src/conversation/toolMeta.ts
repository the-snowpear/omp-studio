import type { JsonValue } from "@omp-studio/client-contract";
import { jsonRecord, jsonString, type ToolStatus, type ToolView } from "./conversationViewModel";

export type ToolKind = string;

export type ThinkView = {
  readonly key: string;
  readonly text: string;
  readonly truncated?: boolean;
};

export type SubagentView = {
  readonly name: string;
  readonly status: string;
  readonly activity?: string;
  readonly currentTool?: string;
  readonly dur?: string;
  readonly tokens?: string;
  readonly tools?: string | number;
  readonly requests?: string | number;
  readonly files?: string | number;
  readonly cost?: string;
};

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
    if (xdevTool.startsWith("mcp__")) return "mcp";
    if (xdevTool === "powershell") return "bash";
    return xdevTool.replace(/[\s-]+/g, "_");
  }
  const fromArgs = jsonString(jsonRecord(tool.arguments)?.kind);
  if (fromArgs) return fromArgs;
  const raw = tool.toolName.trim().toLowerCase();
  if (NAME_TO_KIND[raw]) return NAME_TO_KIND[raw]!;
  if (raw.includes(".")) return "mcp";
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
    return xdevTool ? `MCP · ${xdevTool.slice("mcp__".length).replace(/__/g, ".")}` : tool.toolName || "MCP";
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

export function jsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function jsonStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length === value.length ? items : undefined;
}

export function askAnswer(tool: ToolView): string | undefined {
  const fields = toolFields(tool);
  const answer = jsonString(fields.answer);
  if (answer) return answer;
  const selectedOptions = jsonStringArray(fields.selectedOptions);
  if (selectedOptions?.[0]) return selectedOptions[0];
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
    return jsonString(args?.pattern) ?? jsonString(args?.path) ?? jsonString(args?.glob) ?? "";
  }
  if (kind === "web_search" || kind === "web") return jsonString(args?.query) ?? jsonString(args?.url) ?? "";
  if (kind === "ask" || kind === "askuser") return askAnswer(tool) ?? jsonString(args?.prompt) ?? jsonString(args?.question) ?? "";
  if (kind === "task") {
    const spawn = jsonRecord(args?.spawn) ?? args;
    const tasks = spawn?.tasks;
    const n = Array.isArray(tasks) ? tasks.length : Array.isArray(args?.agents) ? args.agents.length : 0;
    return n ? `${n} agents` : jsonString(args?.goal) ?? "";
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
    return jsonString(fields.pattern) ?? target ?? "";
  }
  if (kind === "web_search" || kind === "web") return jsonString(fields.query) ?? target ?? "";
  if (kind === "lsp") return [jsonString(fields.action), target].filter(Boolean).join(" · ");
  if (kind === "browser") return [jsonString(fields.action), jsonString(fields.url) ?? target].filter(Boolean).join(" · ");
  if (kind === "github") return jsonString(fields.op) ?? target ?? "";
  if (kind === "eval") return jsonString(fields.lang) ?? target ?? "";
  if (kind === "todo") return jsonString(fields.op) ?? target ?? "";
  if (kind === "hub") return target ?? jsonString(fields.hubKind) ?? "";
  if (kind === "ask" || kind === "askuser") return askAnswer(tool) ?? jsonString(fields.question) ?? jsonString(fields.prompt) ?? target ?? "";
  if (kind === "goal") return jsonString(fields.op) ?? jsonString(fields.objective) ?? target ?? "";
  if (kind === "vibe") return target ?? jsonString(fields.vibeOp) ?? "";
  if (kind === "mcp") {
    return jsonString(fields.mcpToolName) ?? jsonString(fields.serverName) ?? target ?? "";
  }
  if (kind === "task") {
    const spawn = jsonRecord(fields.spawn) ?? {};
    const tasks = spawn.tasks;
    const agents = fields.agents;
    const n = Array.isArray(tasks) ? tasks.length : Array.isArray(agents) ? agents.length : 0;
    return n ? `${n} agents` : "";
  }
  if (kind === "debug") return jsonString(fields.action) ?? target ?? "";
  if (kind === "resolve") return jsonString(fields.action) ?? target ?? "";
  return target ?? jsonString(fields.summary) ?? jsonString(fields.query) ?? toolTarget(tool);
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

export function collectAgents(tools: readonly ToolView[]): SubagentView[] {
  const out: SubagentView[] = [];
  for (const tool of tools) {
    if (toolKind(tool) !== "task") continue;
    const fields = toolFields(tool);
    const agents = Array.isArray(fields.progress) ? fields.progress : fields.agents;
    if (!Array.isArray(agents)) continue;
    for (const entry of agents) {
      const record = jsonRecord(entry);
      const name = jsonString(record?.name) ?? jsonString(record?.id);
      if (!name) continue;
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
  const spawn = jsonRecord(args.spawn) ?? {};
  const goal = jsonString(spawn.goal) ?? jsonString(args.goal);
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
