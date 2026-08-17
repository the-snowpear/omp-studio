import { fileBase, isPathKind, toolKind, toolLabel, toolTarget } from "./toolMeta";
import type { ConversationState, LiveTool } from "./conversationViewModel";

export type ActivityPhase = "waiting" | "thinking" | "responding" | "tool" | "queued";

export const WORKING_LABEL = "working";

export interface ActivityStatus {
  readonly phase: ActivityPhase;
  /** Verb phrase shown after elapsed time once the model has started responding. */
  readonly label: string;
  /** Concrete target of the operation (file, command, query); already shortened. */
  readonly detail?: string;
}

export function isLiveActivityPhase(phase: ActivityPhase): boolean {
  return phase === "thinking" || phase === "responding" || phase === "tool";
}

/** Verb per tool kind so the line reads as a sentence; unknown kinds fall back to the tool label. */
const KIND_VERB: Record<string, string> = {
  read: "正在读取",
  write: "正在写入",
  edit: "正在修改",
  ast_edit: "正在修改",
  bash: "正在运行",
  eval: "正在执行代码",
  grep: "正在搜索",
  ast_grep: "正在搜索",
  glob: "正在查找文件",
  lsp: "正在分析代码",
  web_search: "正在联网检索",
  web: "正在联网检索",
  browser: "正在操作浏览器",
  task: "正在派发子 Agent",
  hub: "正在协调子 Agent",
  todo: "正在整理任务",
  think: "正在思考",
  reflect: "正在思考",
  debug: "正在调试",
  security_scan: "正在做安全扫描",
  inspect_image: "正在查看图片",
  generate_image: "正在生成图片",
  mcp: "正在调用 MCP",
};

const DETAIL_MAX_CHARS = 56;

/** First line only, collapsed whitespace, capped — bash commands are often multi-line. */
export function shortenDetail(value: string, maxChars = DETAIL_MAX_CHARS): string {
  const firstLine = value.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

function toolDetail(tool: LiveTool): string {
  const target = toolTarget(tool);
  if (target === "") return "";
  return shortenDetail(isPathKind(toolKind(tool)) ? fileBase(target) : target);
}

/** Latest tool the Runtime is actually executing; queued tools are the fallback. */
function activeTool(state: ConversationState): LiveTool | undefined {
  const tools = Object.values(state.liveTools);
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.status === "running") return tool;
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.status === "queued") return tool;
  }
  return undefined;
}

function lastLiveBlockType(state: ConversationState): "text" | "thinking" | undefined {
  for (let index = state.liveOrder.length - 1; index >= 0; index -= 1) {
    const messageId = state.liveOrder[index];
    const live = messageId === undefined ? undefined : state.liveMessages[messageId];
    if (live === undefined || live.aborted) continue;
    const block = live.blocks.at(-1);
    if (block !== undefined) return block.blockType;
  }
  return undefined;
}

export function hasLiveActivityProgress(state: ConversationState): boolean {
  return activeTool(state) !== undefined || lastLiveBlockType(state) !== undefined;
}

/**
 * Latch from send until the run ends. Covers the receipt → isStreaming gap
 * after the optimistic user row is reconciled and before the first assistant
 * event: the line stays on `working` instead of disappearing.
 */
export function reduceAwaitingTurn(
  prev: { readonly latched: boolean; readonly wasStreaming: boolean },
  input: {
    readonly sending: boolean;
    readonly pending: boolean;
    readonly streaming: boolean;
    readonly failed: boolean;
  },
): { readonly latched: boolean; readonly wasStreaming: boolean } {
  if (input.failed && !input.sending && !input.streaming) {
    return { latched: false, wasStreaming: input.streaming };
  }
  if (prev.wasStreaming && !input.streaming && !input.sending && !input.pending) {
    return { latched: false, wasStreaming: false };
  }
  return {
    latched: prev.latched || input.sending || input.pending || input.streaming,
    wasStreaming: input.streaming,
  };
}

/**
 * Composer abort must cover the same window as the activity line. Snapshot
 * `isStreaming` only flips on message/tool/turn completion, so gating abort
 * on that field alone shows a stop button that does nothing until the first
 * completed event.
 */
export function isAbortEligible(input: {
  readonly executionMatches: boolean;
  readonly streaming: boolean;
  readonly pendingMessages: number;
  readonly awaiting: boolean;
}): boolean {
  return input.executionMatches && (input.streaming || input.pendingMessages > 0 || input.awaiting);
}

/**
 * What the run is doing right now, for the activity line at the bottom of the
 * transcript. Returns `null` when there is nothing to report — an idle session
 * shows no line at all rather than a placeholder.
 *
 * Before the first assistant event, the phase is `waiting` (Claude: only
 * "working"). Time and the live operation appear once thinking, text, or a
 * tool has started.
 */
export function deriveActivityStatus(input: {
  readonly state: ConversationState;
  readonly streaming: boolean;
  readonly pendingMessages: number;
  readonly awaiting?: boolean;
}): ActivityStatus | null {
  const { state, streaming, pendingMessages, awaiting = false } = input;
  if (streaming && hasLiveActivityProgress(state)) {
    const tool = activeTool(state);
    if (tool !== undefined) {
      const kind = toolKind(tool);
      const label = KIND_VERB[kind] ?? `正在执行 ${toolLabel(tool)}`;
      const detail = toolDetail(tool);
      return { phase: "tool", label, ...(detail === "" ? {} : { detail }) };
    }
    const blockType = lastLiveBlockType(state);
    if (blockType === "thinking") return { phase: "thinking", label: "正在思考" };
    if (blockType === "text") return { phase: "responding", label: "正在回复" };
  }
  if (streaming || awaiting) return { phase: "waiting", label: WORKING_LABEL };
  if (pendingMessages > 0) return { phase: "queued", label: `已排队 ${pendingMessages} 条消息` };
  return null;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) {
    const value = count / 1000;
    return `${(value < 10 ? value.toFixed(1) : Math.round(value).toString()).replace(/\.0$/, "")}k`;
  }
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
