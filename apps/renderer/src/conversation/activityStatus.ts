import { fileBase, isPathKind, toolKind, toolLabel, toolTarget } from "./toolMeta";
import type { ConversationState, LiveTool } from "./conversationViewModel";

export type ActivityPhase = "waiting" | "thinking" | "responding" | "tool" | "queued";

export const WORKING_LABEL = "working";

/** Live auto-retry counter from Runtime `conversation.notice` (`Retry 5/10`). */
export interface ActivityRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface ActivityStatus {
  readonly phase: ActivityPhase;
  /** Verb phrase shown after elapsed time once the model has started responding. */
  readonly label: string;
  /** Concrete target of the operation (file, command, query); already shortened. */
  readonly detail?: string;
  /** Outstanding auto-retry; shown immediately to the right of `working`. */
  readonly retry?: ActivityRetry;
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
 *
 * `cancelGeneration` is the same escape hatch `reduceActivityRetry` has, for the
 * same reason: a latch armed while `streaming` was false has no falling edge to
 * clear it, so a user abort has to be ground truth on its own.
 */
export function reduceAwaitingTurn(
  prev: { readonly latched: boolean; readonly wasStreaming: boolean; readonly cancelGeneration?: number },
  input: {
    readonly sending: boolean;
    readonly pending: boolean;
    readonly streaming: boolean;
    readonly failed: boolean;
    readonly cancelGeneration?: number;
  },
): { readonly latched: boolean; readonly wasStreaming: boolean; readonly cancelGeneration: number } {
  const cancelGeneration = input.cancelGeneration ?? 0;
  if (cancelGeneration > (prev.cancelGeneration ?? 0)) {
    // Abort accepted mid-stream still re-latches from `streaming` on the next
    // pass — the run is genuinely winding down — and clears on its falling edge.
    return { latched: false, wasStreaming: input.streaming, cancelGeneration };
  }
  if (input.failed && !input.sending && !input.streaming) {
    return { latched: false, wasStreaming: input.streaming, cancelGeneration };
  }
  if (prev.wasStreaming && !input.streaming && !input.sending && !input.pending) {
    return { latched: false, wasStreaming: false, cancelGeneration };
  }
  return {
    latched: prev.latched || input.sending || input.pending || input.streaming,
    wasStreaming: input.streaming,
    cancelGeneration,
  };
}

/** Who the run signal is currently believed from. See {@link reduceRunStreaming}. */
export type RunTrust = "early" | "runtime-live" | "runtime-settled";

/**
 * Whether a run is live, and whether the Runtime has affirmatively settled it.
 *
 * Residual live-projection state (`openTurnItems`, folded tools) is an EARLY
 * signal only: it exists to cover the send → `isStreaming` snapshot gap. A turn
 * whose close event never arrives leaves that state behind forever — a
 * retryable provider error parks the logical turn on `agent_end{isTerminal:
 * false}` and it is closed only by the terminal `agent_end` of the scheduled
 * continuation, which a user abort supersedes — so trusting it *after* the
 * Runtime reports idle pins `working` and the stop button up until the
 * conversation store is rebuilt (leave the session and come back). Once the
 * Runtime has reported streaming for this run and then reported idle, its
 * verdict wins.
 *
 * A later rising edge of the conversation signal is new information (an
 * agent-initiated turn whose events beat the snapshot), not residue, so it
 * re-arms the early path.
 */
export function reduceRunStreaming(
  prev: { readonly identityKey: string; readonly trust: RunTrust; readonly conversationLive: boolean },
  input: { readonly identityKey: string; readonly runtimeStreaming: boolean; readonly conversationLive: boolean },
): {
  readonly identityKey: string;
  readonly trust: RunTrust;
  readonly conversationLive: boolean;
  readonly streaming: boolean;
  readonly settled: boolean;
} {
  const hold: { readonly trust: RunTrust; readonly conversationLive: boolean } = prev.identityKey === input.identityKey
    ? prev
    : { trust: "early", conversationLive: false };
  const next = (trust: RunTrust, streaming: boolean) => ({
    identityKey: input.identityKey,
    trust,
    conversationLive: input.conversationLive,
    streaming,
    settled: trust === "runtime-settled",
  });
  if (input.runtimeStreaming) return next("runtime-live", true);
  if (hold.trust === "runtime-live") return next("runtime-settled", false);
  if (hold.trust === "runtime-settled") {
    return input.conversationLive && !hold.conversationLive ? next("early", true) : next("runtime-settled", false);
  }
  return next("early", input.conversationLive);
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
  readonly retrying?: boolean;
}): boolean {
  return input.executionMatches && (
    input.streaming || input.pendingMessages > 0 || input.awaiting || input.retrying === true
  );
}

const PENDING_RUN_WINDOW_KEY = "__pending__";

function runWindowKey(identityKey: string): string {
  return identityKey === "" ? PENDING_RUN_WINDOW_KEY : identityKey;
}

/**
 * Persist the run clock by session identity so leaving the workbench (homepage
 * unmounts `WorkbenchCanvas`) does not restart elapsed time at 0s. An empty
 * identity is stored as a pending key and migrated when the session id arrives.
 */
export function syncRunWindow(
  identityKey: string,
  active: boolean,
  now: number,
  store: Map<string, number>,
): number | null {
  const key = runWindowKey(identityKey);
  if (!active) {
    store.delete(key);
    return null;
  }
  const existing = store.get(key) ?? (key === PENDING_RUN_WINDOW_KEY ? undefined : store.get(PENDING_RUN_WINDOW_KEY));
  if (existing !== undefined) {
    if (key !== PENDING_RUN_WINDOW_KEY && store.has(PENDING_RUN_WINDOW_KEY)) {
      store.delete(PENDING_RUN_WINDOW_KEY);
      store.set(key, existing);
    }
    return existing;
  }
  store.set(key, now);
  return now;
}

const RETRY_NOTICE = /^Retry (\d+)\/(\d+)$/;

export function parseRetryNotice(message: string, source?: string): ActivityRetry | undefined {
  if (source !== undefined && source !== "retry") return undefined;
  const match = RETRY_NOTICE.exec(message.trim());
  if (match === null) return undefined;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts) || attempt < 1 || maxAttempts < 1) {
    return undefined;
  }
  return { attempt, maxAttempts };
}

export function isRetryActivityNotice(message: string, source?: string): boolean {
  return parseRetryNotice(message, source) !== undefined;
}

/** Runtime `auto_retry_end` — not shown in the transcript; clears the activity Retry latch. */
export function isRetryEndNotice(_message: string, source?: string): boolean {
  return source === "retry-end";
}

export function isRetryTranscriptNotice(message: string, source?: string): boolean {
  return isRetryActivityNotice(message, source) || isRetryEndNotice(message, source);
}

export function formatRetry(retry: ActivityRetry): string {
  return `Retry ${retry.attempt}/${retry.maxAttempts}`;
}

export function latestActivityRetry(
  notices: readonly { readonly message: string; readonly source?: string }[],
): ActivityRetry | undefined {
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index];
    if (notice === undefined) continue;
    const parsed = parseRetryNotice(notice.message, notice.source);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function retryNoticeCount(notices: readonly { readonly message: string; readonly source?: string }[]): number {
  let count = 0;
  for (const notice of notices) {
    if (parseRetryNotice(notice.message, notice.source) !== undefined) count += 1;
  }
  return count;
}

function retryEndNoticeCount(notices: readonly { readonly message: string; readonly source?: string }[]): number {
  let count = 0;
  for (const notice of notices) {
    if (isRetryEndNotice(notice.message, notice.source)) count += 1;
  }
  return count;
}

/**
 * Hold the latest `Retry N/M` notice until that retry attempt's stream ends
 * without a further retry. A new notice during backoff refreshes the counter;
 * a streaming falling edge after the retried request has started clears it.
 * User abort and Runtime `auto_retry_end` also clear it — backoff never
 * starts a stream, so the falling-edge path alone leaves the stop button up.
 */
export function reduceActivityRetry(
  prev: {
    readonly identityKey: string;
    readonly retry?: ActivityRetry;
    readonly noticeCount: number;
    readonly endCount?: number;
    readonly cancelGeneration?: number;
    readonly seenStream: boolean;
    readonly wasStreaming: boolean;
  },
  input: {
    readonly identityKey: string;
    readonly notices: readonly { readonly message: string; readonly source?: string }[];
    readonly streaming: boolean;
    readonly failed: boolean;
    readonly cancelGeneration?: number;
  },
): {
  readonly identityKey: string;
  readonly retry?: ActivityRetry;
  readonly noticeCount: number;
  readonly endCount: number;
  readonly cancelGeneration: number;
  readonly seenStream: boolean;
  readonly wasStreaming: boolean;
} {
  const noticeCount = retryNoticeCount(input.notices);
  const endCount = retryEndNoticeCount(input.notices);
  const cancelGeneration = input.cancelGeneration ?? 0;
  const latest = latestActivityRetry(input.notices);
  const hold = prev.identityKey === input.identityKey
    ? {
        ...prev,
        endCount: prev.endCount ?? 0,
        cancelGeneration: prev.cancelGeneration ?? 0,
      }
    : {
        identityKey: input.identityKey,
        noticeCount: 0,
        endCount: 0,
        cancelGeneration: 0,
        seenStream: false,
        wasStreaming: false,
      };
  const cleared = {
    identityKey: input.identityKey,
    noticeCount,
    endCount,
    cancelGeneration,
    seenStream: false,
    wasStreaming: input.streaming,
  };
  if (input.failed && !input.streaming) {
    return { ...cleared, wasStreaming: false };
  }
  if (cancelGeneration > hold.cancelGeneration || endCount > hold.endCount) {
    return cleared;
  }
  if (latest !== undefined && noticeCount > hold.noticeCount) {
    return {
      ...cleared,
      retry: latest,
      seenStream: false,
      wasStreaming: input.streaming,
    };
  }
  if (hold.retry === undefined) {
    return cleared;
  }
  const rising = !hold.wasStreaming && input.streaming;
  const seenStream = hold.seenStream || rising;
  if (hold.wasStreaming && !input.streaming && seenStream && noticeCount === hold.noticeCount) {
    return { ...cleared, wasStreaming: false };
  }
  return {
    identityKey: input.identityKey,
    retry: hold.retry,
    noticeCount,
    endCount,
    cancelGeneration,
    seenStream,
    wasStreaming: input.streaming,
  };
}

/**
 * What the run is doing right now, for the activity line at the bottom of the
 * transcript. Returns `null` when there is nothing to report — an idle session
 * shows no line at all rather than a placeholder.
 *
 * Before the first assistant event, the phase is `waiting` (Claude: only
 * "working", plus `Retry N/M` while auto-retry is outstanding). Time and the
 * live operation appear once thinking, text, or a tool has started — retry
 * is omitted from that live line.
 */
export function deriveActivityStatus(input: {
  readonly state: ConversationState;
  readonly streaming: boolean;
  readonly pendingMessages: number;
  readonly awaiting?: boolean;
  readonly retry?: ActivityRetry;
}): ActivityStatus | null {
  const { state, streaming, pendingMessages, awaiting = false, retry } = input;
  const withRetry = (status: ActivityStatus): ActivityStatus => (
    retry === undefined ? status : { ...status, retry }
  );
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
  if (streaming || awaiting || retry !== undefined) return withRetry({ phase: "waiting", label: WORKING_LABEL });
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
