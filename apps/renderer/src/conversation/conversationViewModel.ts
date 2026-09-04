import type {
  ConversationCompactionItem,
  ConversationContentBlock,
  ConversationItem,
  ConversationMessageError,
  ConversationMessageItem,
  ConversationResetBoundaryItem,
  JsonValue,
  OpaqueCursor,
} from "@omp-studio/client-contract";
import type { ComposerDoc } from "../composer/types";
import type { ConversationIdentity } from "./conversationHost";
import type { UserMessageThumb, UserThumbMap } from "./userMessageThumbs";

export type ToolStatus = "queued" | "running" | "succeeded" | "failed" | "aborted" | "missing";
export type LiveBlock = { readonly blockId: string; readonly blockType: "text" | "thinking"; readonly text: string; readonly truncated?: boolean };
export type LiveMessage = { readonly messageId: string; readonly turnId: string; readonly role: ConversationMessageItem["role"]; readonly createdAt: string; readonly blocks: readonly LiveBlock[]; readonly aborted: boolean };
export type LiveTool = { readonly toolCallId: string; readonly messageId: string; readonly turnId: string; readonly toolName: string; readonly arguments?: JsonValue; readonly output?: string; readonly truncated?: boolean; readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>; readonly status: ToolStatus };
export type PendingUser = { readonly requestId: string; readonly text: string; readonly draft: string; readonly status: "pending" | "failed"; readonly knownItemIds: readonly string[]; readonly error?: string; readonly doc?: ComposerDoc };
export type ConversationNotice = { readonly id: string; readonly level: "info" | "warning" | "error"; readonly message: string; readonly source?: string };
export type HydrateStatus = "idle" | "loading" | "ready" | "error" | "resyncing" | "unavailable";
export type ConversationState = {
  readonly generation: number; readonly identity: ConversationIdentity | null; readonly items: readonly ConversationItem[];
  readonly liveMessages: { readonly [messageId: string]: LiveMessage }; readonly liveTools: { readonly [toolCallId: string]: LiveTool }; readonly liveOrder: readonly string[];
  readonly olderCursor?: OpaqueCursor; readonly headCursor?: OpaqueCursor; readonly hasMoreBefore: boolean; readonly hydrateStatus: HydrateStatus;
  readonly unavailableReason?: string; readonly error?: { readonly code: string; readonly message: string }; readonly notices: readonly ConversationNotice[];
  readonly pendingUsers: readonly PendingUser[]; readonly lastEventSeq?: number; readonly resyncRequired: boolean;
  readonly userDisplays: { readonly [itemId: string]: ComposerDoc }; readonly userThumbs: UserThumbMap; readonly openTurnItems: { readonly [itemId: string]: string };
  readonly compacting?: { readonly action: string }; readonly messageErrors?: { readonly [messageId: string]: ConversationMessageError };
};
export type ToolView = { readonly toolCallId: string; readonly toolName: string; readonly arguments?: JsonValue; readonly output?: string; readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>; readonly status: ToolStatus; readonly truncated?: boolean };
export type AssistantSegment =
  | { readonly type: "text"; readonly key: string; readonly text: string; readonly truncated?: boolean; readonly streaming?: boolean }
  | { readonly type: "thinking"; readonly key: string; readonly text: string; readonly truncated?: boolean }
  | { readonly type: "batch"; readonly key: string; readonly tools: readonly ToolView[] };
export type TimelineRow =
  | { readonly type: "user"; readonly itemId: string; readonly createdAt: string; readonly text: string; readonly pending?: PendingUser["status"]; readonly requestId?: string; readonly error?: string; readonly doc?: ComposerDoc; readonly thumbs?: readonly UserMessageThumb[] }
  | { readonly type: "assistant"; readonly itemId: string; readonly createdAt: string; readonly segments: readonly AssistantSegment[]; readonly status: "streaming" | "completed" | "aborted" | "error"; readonly presentation?: "process" | "reply"; readonly turnOpen?: boolean; readonly error?: ConversationMessageError }
  | { readonly type: "compaction"; readonly item: ConversationCompactionItem }
  | { readonly type: "compacting"; readonly action?: string }
  | { readonly type: "resetBoundary"; readonly item: ConversationResetBoundaryItem };

export const COMPACTING_ROW_ID = "compacting";
const EMPTY_MESSAGE_PROTOCOL_PLACEHOLDER = "[System: Empty message content sanitised to satisfy protocol]";

function isEmptyMessageProtocolPlaceholder(text: string): boolean {
  return text.trim() === EMPTY_MESSAGE_PROTOCOL_PLACEHOLDER;
}

export function timelineRowKey(row: TimelineRow): string { return row.type === "compacting" ? COMPACTING_ROW_ID : row.type === "compaction" || row.type === "resetBoundary" ? row.item.itemId : row.itemId; }
export function withCompactingRow(rows: readonly TimelineRow[], compacting: boolean, action?: string): readonly TimelineRow[] {
  if (!compacting || rows[rows.length - 1]?.type === "compacting") return rows;
  return [...rows, { type: "compacting", ...(action ? { action } : {}) }];
}

/**
 * 尾部是否正在流式产出。
 *
 * 用途是「这一帧要不要把动画和小地图测量让给流式」，所以只需要一个便宜的判定：流式行
 * 只可能出现在时间线末尾（后面最多再跟一条 compacting/边界行），从尾部看几行就够，不
 * 必扫全表 —— 这个函数在流式期间每帧都会被调用。
 */
export function tailStreaming(rows: readonly TimelineRow[]): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    // compacting 与尚未落盘的用户请求只是当前尾部的附属 UI；它们后面的运行回合仍应
    // 获得流式预算。遇到任何其他实质行就必须停，不能固定向前猜三行——否则一条历史
    // stale streaming 行会让后续一两个完整回合仍被误判为忙碌。
    if (row.type === "compacting") continue;
    if (row.type === "user" && (row.pending !== undefined || row.itemId.startsWith("pending:"))) continue;
    return row.type === "assistant" && (row.status === "streaming" || row.turnOpen === true);
  }
  return false;
}

/**
 * 时间线的两级内容版本。
 *
 * `structure` 在**任何**行内容变化时前进（含工具启停 —— 见 store 的 `markRowChanged`），
 * `shape` 只在行序列/行类型变化时前进。区分两者的原因：`renderItems` 这类只按行 type
 * 分组的派生结果不该因为某张工具卡开始跑就对全对话重算，而 `turnChangeBinds` /
 * `planCreatedBinds` 确实要读工具内容，必须跟着 `structure`。
 */
type TimelineTokens = { readonly structure: object; readonly shape: object };
const timelineStructureTokens = new WeakMap<readonly TimelineRow[], TimelineTokens>();
export function tagTimelineStructure<T extends readonly TimelineRow[]>(rows: T, token: object, shape: object = token): T {
  timelineStructureTokens.set(rows, { structure: token, shape });
  return rows;
}
export function timelineStructureToken(rows: readonly TimelineRow[]): object {
  return timelineStructureTokens.get(rows)?.structure ?? rows;
}
export function timelineShapeToken(rows: readonly TimelineRow[]): object {
  return timelineStructureTokens.get(rows)?.shape ?? rows;
}
export function emptyConversationState(generation = 0): ConversationState {
  return { generation, identity: null, items: [], liveMessages: {}, liveTools: {}, liveOrder: [], hasMoreBefore: false, hydrateStatus: "idle", notices: [], pendingUsers: [], resyncRequired: false, userDisplays: {}, userThumbs: {}, openTurnItems: {} };
}
export function resetConversation(generation: number, identity: ConversationIdentity | null, hydrateStatus: HydrateStatus, unavailableReason?: string): ConversationState {
  return { ...emptyConversationState(generation), identity, hydrateStatus, ...(unavailableReason === undefined ? {} : { unavailableReason }) };
}
export function messageText(item: ConversationMessageItem): string { return item.content.filter((block): block is Extract<ConversationContentBlock, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n"); }
export function jsonRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined { return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: JsonValue } : undefined; }
export function jsonString(value: JsonValue | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
export function formatJson(value: JsonValue): string { return JSON.stringify(value, null, 2); }

type RowCacheEntry = { readonly dependencies: readonly unknown[]; readonly row: TimelineRow };
export type TimelineRowCache = Map<string, RowCacheEntry>;
function cachedRow(cache: TimelineRowCache, key: string, dependencies: readonly unknown[], create: () => TimelineRow): TimelineRow {
  const previous = cache.get(key);
  if (previous !== undefined && previous.dependencies.length === dependencies.length && previous.dependencies.every((value, index) => value === dependencies[index])) return previous.row;
  const row = create(); cache.set(key, { dependencies, row }); return row;
}
function toolViews(content: readonly ConversationContentBlock[], live: readonly LiveTool[], turnOpen: boolean): readonly ToolView[] {
  const results = new Map(content.filter((block): block is Extract<ConversationContentBlock, { type: "toolResult" }> => block.type === "toolResult").map((block) => [block.toolCallId, block]));
  const liveById = new Map(live.map((tool) => [tool.toolCallId, tool]));
  const persisted = content.filter((block): block is Extract<ConversationContentBlock, { type: "toolCall" }> => block.type === "toolCall").map((call): ToolView => {
    const persistedResult = results.get(call.toolCallId);
    const liveTool = liveById.get(call.toolCallId);
    const result = persistedResult ?? liveTool?.result;
    const status = persistedResult !== undefined
      ? (persistedResult.isError ? "failed" : "succeeded")
      : liveTool?.status ?? (turnOpen ? "running" : "missing");
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
      ...(liveTool?.output === undefined ? {} : { output: liveTool.output }),
      ...(result === undefined ? {} : { result }),
      status,
      ...(call.truncated || liveTool?.truncated === true ? { truncated: true } : {}),
    };
  });
  const known = new Set(persisted.map((tool) => tool.toolCallId));
  return [...persisted, ...live.filter((tool) => !known.has(tool.toolCallId)).map((tool): ToolView => ({ toolCallId: tool.toolCallId, toolName: tool.toolName, ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }), ...(tool.output === undefined ? {} : { output: tool.output }), ...(tool.result === undefined ? {} : { result: tool.result }), status: tool.status, ...(tool.truncated ? { truncated: true } : {}) }))];
}
function assistantSegments(content: readonly ConversationContentBlock[], liveTools: readonly LiveTool[], turnOpen: boolean, streaming = false): readonly AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]!;
    if (block.type === "text" && !isEmptyMessageProtocolPlaceholder(block.text)) segments.push({ type: "text", key: `text-${index}`, text: block.text, ...(block.truncated ? { truncated: true } : {}), ...(streaming ? { streaming: true } : {}) });
    else if (block.type === "thinking") segments.push({ type: "thinking", key: `thinking-${index}`, text: block.text, ...(block.truncated ? { truncated: true } : {}) });
  }
  const tools = toolViews(content, liveTools, turnOpen);
  if (tools.length > 0) segments.push({ type: "batch", key: `tools-${tools.map((tool) => tool.toolCallId).join("-")}`, tools });
  return segments;
}

function liveToolsByMessage(state: ConversationState): Map<string, LiveTool[]> {
  const liveByMessage = new Map<string, LiveTool[]>();
  for (const tool of Object.values(state.liveTools)) { const list = liveByMessage.get(tool.messageId) ?? []; list.push(tool); liveByMessage.set(tool.messageId, list); }
  return liveByMessage;
}

function persistedTimelineRow(state: ConversationState, item: ConversationItem, tools: readonly LiveTool[], cache: TimelineRowCache): TimelineRow {
  if (item.kind === "compaction" || item.kind === "resetBoundary") return cachedRow(cache, item.itemId, [item], () => item.kind === "compaction" ? { type: "compaction", item } : { type: "resetBoundary", item });
  if (item.role === "user") {
    const doc = state.userDisplays[item.itemId]; const thumbs = state.userThumbs[item.itemId];
    return cachedRow(cache, item.itemId, [item, doc, thumbs], () => ({ type: "user", itemId: item.itemId, createdAt: item.createdAt, text: messageText(item), ...(doc === undefined ? {} : { doc }), ...(thumbs === undefined ? {} : { thumbs }) }));
  }
  const turnOpen = state.openTurnItems[item.itemId] !== undefined; const error = state.messageErrors?.[item.itemId];
  return cachedRow(cache, item.itemId, [item, ...tools, turnOpen, error], () => ({ type: "assistant", itemId: item.itemId, createdAt: item.createdAt, segments: assistantSegments(item.content, tools, turnOpen), status: error === undefined ? "completed" : "error", presentation: "reply", ...(turnOpen ? { turnOpen: true } : {}), ...(error === undefined ? {} : { error }) }));
}

export function buildPersistedTimelineRow(state: ConversationState, item: ConversationItem, cache: TimelineRowCache = new Map()): TimelineRow {
  const tools = Object.values(state.liveTools).filter((tool) => tool.messageId === item.itemId);
  return persistedTimelineRow(state, item, tools, cache);
}

/** Projects the bounded persisted prefix. The Store only calls this after a structural mutation. */
export function buildPersistedTimeline(state: ConversationState, cache: TimelineRowCache = new Map()): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const liveByMessage = liveToolsByMessage(state);
  for (const item of state.items) {
    rows.push(persistedTimelineRow(state, item, liveByMessage.get(item.itemId) ?? [], cache));
  }
  return rows;
}

/** Projects only the mutable tail; its work is bounded independently of transcript length. */
export function buildTransientTimeline(state: ConversationState, persistedIds: ReadonlySet<string>, cache: TimelineRowCache = new Map()): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const liveByMessage = liveToolsByMessage(state);
  for (const messageId of state.liveOrder) {
    if (persistedIds.has(messageId)) continue; const message = state.liveMessages[messageId]; if (message === undefined) continue;
    const tools = liveByMessage.get(messageId) ?? []; const content: ConversationContentBlock[] = message.blocks.map((block) => ({ type: block.blockType, text: block.text, ...(block.truncated ? { truncated: true } : {}) }));
    rows.push(cachedRow(cache, messageId, [message, ...tools], () => message.role === "user" ? { type: "user", itemId: message.messageId, createdAt: message.createdAt, text: message.blocks.filter((block) => block.blockType === "text").map((block) => block.text).join("\n") } : { type: "assistant", itemId: message.messageId, createdAt: message.createdAt, segments: assistantSegments(content, tools, true, true), status: message.aborted ? "aborted" : "streaming", presentation: "process", turnOpen: true }));
  }
  for (const pending of state.pendingUsers) rows.push(cachedRow(cache, `pending:${pending.requestId}`, [pending], () => ({ type: "user", itemId: `pending:${pending.requestId}`, createdAt: "", text: pending.text, pending: pending.status, requestId: pending.requestId, ...(pending.error === undefined ? {} : { error: pending.error }), ...(pending.doc === undefined ? {} : { doc: pending.doc }) })));
  if (state.compacting !== undefined) rows.push(cachedRow(cache, COMPACTING_ROW_ID, [state.compacting.action], () => ({ type: "compacting", ...(state.compacting?.action ? { action: state.compacting.action } : {}) })));
  return rows;
}

/** Pure full projection used outside the hot Store path and by focused tests. */
export function buildTimeline(state: ConversationState, cache: TimelineRowCache = new Map()): TimelineRow[] {
  const persistedIds = new Set(state.items.map((item) => item.itemId));
  return [...buildPersistedTimeline(state, cache), ...buildTransientTimeline(state, persistedIds, cache)];
}
