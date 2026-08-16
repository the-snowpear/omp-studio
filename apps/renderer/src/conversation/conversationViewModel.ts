import type {
  ConversationState as ClientConversationState,
  ConversationLiveMessage,
  ConversationLiveTool,
  ConversationView,
} from "@omp-studio/client";
import type {
  ConversationCompactionItem,
  ConversationContentBlock,
  ConversationItem,
  ConversationMessageItem,
  ConversationResetBoundaryItem,
  ConversationRuntimeEvent,
  ConversationTranscriptPage,
  JsonValue,
  OpaqueCursor,
} from "@omp-studio/client-contract";
import type { ConversationIdentity } from "./conversationHost";
import { sameIdentity } from "./conversationHost";

export type ToolStatus = "queued" | "running" | "succeeded" | "failed" | "aborted" | "missing";

export type LiveBlock = {
  readonly blockId: string;
  readonly blockType: "text" | "thinking";
  readonly text: string;
};

export type LiveMessage = {
  readonly messageId: string;
  readonly turnId: string;
  readonly role: ConversationMessageItem["role"];
  readonly createdAt: string;
  readonly blocks: readonly LiveBlock[];
  readonly aborted: boolean;
};

export type LiveTool = {
  readonly toolCallId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly arguments?: JsonValue;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>;
  readonly status: ToolStatus;
};

export type PendingUser = {
  readonly requestId: string;
  readonly text: string;
  readonly draft: string;
  readonly status: "pending" | "failed";
  readonly knownItemIds: readonly string[];
  readonly error?: string;
};

export type ConversationNotice = {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
};

export type HydrateStatus = "idle" | "loading" | "ready" | "error" | "resyncing" | "unavailable";

export type ConversationState = {
  readonly generation: number;
  readonly identity: ConversationIdentity | null;
  readonly items: readonly ConversationItem[];
  readonly liveMessages: { readonly [messageId: string]: LiveMessage };
  readonly liveTools: { readonly [toolCallId: string]: LiveTool };
  readonly liveOrder: readonly string[];
  readonly olderCursor?: OpaqueCursor;
  readonly headCursor?: OpaqueCursor;
  readonly hasMoreBefore: boolean;
  readonly hydrateStatus: HydrateStatus;
  readonly unavailableReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly notices: readonly ConversationNotice[];
  readonly pendingUsers: readonly PendingUser[];
  readonly lastEventSeq?: number;
  readonly resyncRequired: boolean;
};

export type ToolView = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments?: JsonValue;
  readonly output?: string;
  readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>;
  readonly status: ToolStatus;
  readonly truncated?: boolean;
};

export type AssistantSegment =
  | { readonly type: "text"; readonly key: string; readonly text: string; readonly truncated?: boolean; readonly streaming?: boolean }
  | { readonly type: "thinking"; readonly key: string; readonly text: string; readonly truncated?: boolean }
  | { readonly type: "batch"; readonly key: string; readonly tools: readonly ToolView[] };

export type TimelineRow =
  | {
      readonly type: "user";
      readonly itemId: string;
      readonly createdAt: string;
      readonly text: string;
      readonly pending?: PendingUser["status"];
      readonly requestId?: string;
      readonly error?: string;
    }
  | {
      readonly type: "assistant";
      readonly itemId: string;
      readonly createdAt: string;
      readonly segments: readonly AssistantSegment[];
      readonly status: "streaming" | "completed" | "aborted" | "error";
      /** Process rows omit the repeated OMP identity header; only the final reply in a turn uses reply. */
      readonly presentation?: "process" | "reply";
    }
  | { readonly type: "compaction"; readonly item: ConversationCompactionItem }
  | { readonly type: "resetBoundary"; readonly item: ConversationResetBoundaryItem };

export function emptyConversationState(generation = 0): ConversationState {
  return {
    generation,
    identity: null,
    items: [],
    liveMessages: {},
    liveTools: {},
    liveOrder: [],
    hasMoreBefore: false,
    hydrateStatus: "idle",
    notices: [],
    pendingUsers: [],
    resyncRequired: false,
  };
}

export function resetConversation(
  generation: number,
  identity: ConversationIdentity | null,
  hydrateStatus: HydrateStatus,
  unavailableReason?: string,
): ConversationState {
  return {
    ...emptyConversationState(generation),
    identity,
    hydrateStatus,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

export function messageText(item: ConversationMessageItem): string {
  return item.content
    .filter((block): block is Extract<ConversationContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function itemIdsOf(items: readonly ConversationItem[]): readonly string[] {
  return items.map((item) => item.itemId);
}

function upsertItem(items: readonly ConversationItem[], item: ConversationItem): ConversationItem[] {
  const index = items.findIndex((entry) => entry.itemId === item.itemId);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function dropLiveMessage(state: ConversationState, messageId: string): Pick<ConversationState, "liveMessages" | "liveOrder"> {
  if (!(messageId in state.liveMessages)) {
    return { liveMessages: state.liveMessages, liveOrder: state.liveOrder };
  }
  const { [messageId]: _dropped, ...liveMessages } = state.liveMessages;
  return {
    liveMessages,
    liveOrder: state.liveOrder.filter((id) => id !== messageId),
  };
}

function appendNotice(state: ConversationState, notice: ConversationNotice): ConversationState {
  if (state.notices.some((entry) => entry.message === notice.message && entry.level === notice.level)) {
    return state;
  }
  return { ...state, notices: [...state.notices.slice(-19), notice] };
}

export function reconcilePendingUsers(
  pending: readonly PendingUser[],
  items: readonly ConversationItem[],
): readonly PendingUser[] {
  const used = new Set<string>();
  return pending.filter((entry) => {
    if (entry.status === "failed") return true;
    const known = new Set(entry.knownItemIds);
    const match = items.find(
      (item) =>
        item.kind === "message" &&
        item.role === "user" &&
        !known.has(item.itemId) &&
        !used.has(item.itemId) &&
        messageText(item) === entry.text,
    );
    if (match === undefined) return true;
    used.add(match.itemId);
    return false;
  });
}

export function hydratePage(
  state: ConversationState,
  page: ConversationTranscriptPage,
  generation: number,
  mode: "replace" | "prepend",
): ConversationState {
  if (generation !== state.generation) return state;
  if (!sameIdentity(state.identity, page)) return state;
  if (mode === "prepend") {
    const existing = new Set(itemIdsOf(state.items));
    const incoming = page.items.filter((item) => !existing.has(item.itemId));
    const items = [...incoming, ...state.items];
    return {
      ...state,
      items,
      hasMoreBefore: page.hasMoreBefore,
      hydrateStatus: "ready",
      resyncRequired: false,
      pendingUsers: reconcilePendingUsers(state.pendingUsers, items),
      ...(page.olderCursor === undefined ? {} : { olderCursor: page.olderCursor }),
    };
  }
  const persisted = new Set(itemIdsOf(page.items));
  const liveMessages: { [messageId: string]: LiveMessage } = {};
  const liveOrder: string[] = [];
  for (const id of state.liveOrder) {
    const live = state.liveMessages[id];
    if (live && !persisted.has(id)) {
      liveMessages[id] = live;
      liveOrder.push(id);
    }
  }
  const liveTools: { [toolCallId: string]: LiveTool } = {};
  for (const [id, tool] of Object.entries(state.liveTools)) {
    if (!persisted.has(tool.messageId) || !page.items.some((item) => itemHasToolResult(item, tool.toolCallId))) {
      liveTools[id] = tool;
    }
  }
  const { olderCursor: _dropOlder, error: _dropError, unavailableReason: _dropReason, ...rest } = state;
  return {
    ...rest,
    items: page.items,
    liveMessages,
    liveTools,
    liveOrder,
    hasMoreBefore: page.hasMoreBefore,
    headCursor: page.headCursor,
    hydrateStatus: "ready",
    resyncRequired: false,
    pendingUsers: reconcilePendingUsers(state.pendingUsers, page.items),
    ...(page.olderCursor === undefined ? {} : { olderCursor: page.olderCursor }),
  };
}

function itemHasToolResult(item: ConversationItem, toolCallId: string): boolean {
  if (item.kind !== "message") return false;
  return item.content.some((block) => block.type === "toolResult" && block.toolCallId === toolCallId);
}

export function applyLiveEvent(
  state: ConversationState,
  event: ConversationRuntimeEvent,
  identity: ConversationIdentity,
  eventSeq?: number,
): ConversationState {
  if (!sameIdentity(state.identity, identity)) return state;
  if (event.sessionId !== identity.sessionId) return state;
  if (eventSeq !== undefined && state.lastEventSeq !== undefined) {
    if (eventSeq <= state.lastEventSeq) return state;
  }
  const withSeq =
    eventSeq === undefined ? state : { ...state, lastEventSeq: eventSeq };
  switch (event.kind) {
    case "conversation.message.started":
      return startMessage(withSeq, event);
    case "conversation.message.delta":
      return deltaMessage(withSeq, event);
    case "conversation.message.completed":
      return completeMessage(withSeq, event);
    case "conversation.tool.started":
      return startTool(withSeq, event);
    case "conversation.tool.updated":
      return updateTool(withSeq, event);
    case "conversation.tool.completed":
      return completeTool(withSeq, event);
    case "conversation.turn.aborted":
      return abortTurn(withSeq, event.turnId);
    case "conversation.turn.completed":
      return withSeq;
    case "conversation.compaction.started":
      return appendNotice(withSeq, {
        id: `compaction-start-${withSeq.notices.length}`,
        level: "info",
        message: "正在同步压缩摘要",
      });
    case "conversation.compaction.completed": {
      if (event.item) {
        return { ...withSeq, items: upsertItem(withSeq.items, event.item) };
      }
      if (event.aborted) {
        return appendNotice(withSeq, {
          id: `compaction-abort-${withSeq.notices.length}`,
          level: "warning",
          message: "上下文压缩已中止",
        });
      }
      return withSeq;
    }
    case "conversation.notice":
      return appendNotice(withSeq, {
        id: `notice-${withSeq.notices.length}-${event.level}`,
        level: event.level,
        message: event.message,
      });
  }
}

function startMessage(
  state: ConversationState,
  event: Extract<ConversationRuntimeEvent, { kind: "conversation.message.started" }>,
): ConversationState {
  if (state.items.some((item) => item.itemId === event.messageId) || event.messageId in state.liveMessages) {
    return state;
  }
  return {
    ...state,
    liveMessages: {
      ...state.liveMessages,
      [event.messageId]: {
        messageId: event.messageId,
        turnId: event.turnId,
        role: event.role,
        createdAt: event.createdAt,
        blocks: [],
        aborted: false,
      },
    },
    liveOrder: [...state.liveOrder, event.messageId],
  };
}

function deltaMessage(
  state: ConversationState,
  event: Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }>,
): ConversationState {
  if (state.items.some((item) => item.itemId === event.messageId)) return state;
  const live = state.liveMessages[event.messageId];
  if (live === undefined || live.aborted) return state;
  const index = live.blocks.findIndex((block) => block.blockId === event.blockId);
  const blocks = live.blocks.slice();
  if (index === -1) {
    blocks.push({ blockId: event.blockId, blockType: event.blockType, text: event.delta });
  } else {
    const current = blocks[index]!;
    blocks[index] = { ...current, text: `${current.text}${event.delta}` };
  }
  return {
    ...state,
    liveMessages: { ...state.liveMessages, [event.messageId]: { ...live, blocks } },
  };
}

function completeMessage(
  state: ConversationState,
  event: Extract<ConversationRuntimeEvent, { kind: "conversation.message.completed" }>,
): ConversationState {
  if (event.item.itemId !== event.messageId) return state;
  const dropped = dropLiveMessage(state, event.messageId);
  const items = upsertItem(state.items, event.item);
  return {
    ...state,
    items,
    liveMessages: dropped.liveMessages,
    liveOrder: dropped.liveOrder,
    pendingUsers: reconcilePendingUsers(state.pendingUsers, items),
  };
}

function startTool(
  state: ConversationState,
  event: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.started" }>,
): ConversationState {
  const existing = state.liveTools[event.toolCallId];
  if (existing?.result) return state;
  return {
    ...state,
    liveTools: {
      ...state.liveTools,
      [event.toolCallId]: {
        toolCallId: event.toolCallId,
        messageId: event.messageId,
        turnId: event.turnId,
        toolName: event.toolName,
        status: "running",
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
        ...(existing?.output === undefined ? {} : { output: existing.output }),
      },
    },
  };
}

function updateTool(
  state: ConversationState,
  event: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.updated" }>,
): ConversationState {
  const existing = state.liveTools[event.toolCallId];
  if (existing?.result) return state;
  const previous = event.updateMode === "replace" ? "" : (existing?.output ?? "");
  const output = `${previous}${event.output ?? ""}`;
  const next: LiveTool = {
    toolCallId: event.toolCallId,
    messageId: existing?.messageId ?? "",
    turnId: event.turnId,
    toolName: existing?.toolName ?? "tool",
    status: "running",
    output,
    ...(existing?.arguments === undefined ? {} : { arguments: existing.arguments }),
    ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
  };
  return { ...state, liveTools: { ...state.liveTools, [event.toolCallId]: next } };
}

function completeTool(
  state: ConversationState,
  event: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.completed" }>,
): ConversationState {
  const existing = state.liveTools[event.toolCallId];
  const status: ToolStatus = event.result.isError ? "failed" : "succeeded";
  const next: LiveTool = {
    toolCallId: event.toolCallId,
    messageId: existing?.messageId ?? "",
    turnId: event.turnId,
    toolName: event.result.toolName ?? existing?.toolName ?? "tool",
    status,
    result: event.result,
    ...(existing?.arguments === undefined ? {} : { arguments: existing.arguments }),
    ...(event.result.output === undefined ? existing?.output === undefined ? {} : { output: existing.output } : { output: event.result.output }),
    ...(event.result.truncated === undefined ? {} : { truncated: event.result.truncated }),
  };
  return { ...state, liveTools: { ...state.liveTools, [event.toolCallId]: next } };
}

function abortTurn(state: ConversationState, turnId: string): ConversationState {
  const liveMessages: { [messageId: string]: LiveMessage } = {};
  for (const [id, live] of Object.entries(state.liveMessages)) {
    liveMessages[id] = live.turnId === turnId ? { ...live, aborted: true } : live;
  }
  const liveTools: { [toolCallId: string]: LiveTool } = {};
  for (const [id, tool] of Object.entries(state.liveTools)) {
    liveTools[id] =
      tool.turnId === turnId && tool.status === "running"
        ? { ...tool, status: "aborted" }
        : tool;
  }
  return { ...state, liveMessages, liveTools };
}

export function jsonRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as { readonly [key: string]: JsonValue };
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function formatJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function toolViewFromBlocks(
  call: Extract<ConversationContentBlock, { type: "toolCall" }>,
  result: Extract<ConversationContentBlock, { type: "toolResult" }> | undefined,
  live: LiveTool | undefined,
): ToolView {
  if (result) {
    return {
      toolCallId: call.toolCallId,
      toolName: result.toolName ?? call.toolName,
      status: result.isError ? "failed" : "succeeded",
      result,
      ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.truncated === true || call.truncated === true ? { truncated: true } : {}),
    };
  }
  if (live) {
    return {
      toolCallId: live.toolCallId,
      toolName: live.toolName || call.toolName,
      status: live.status,
      ...(live.arguments === undefined ? call.arguments === undefined ? {} : { arguments: call.arguments } : { arguments: live.arguments }),
      ...(live.output === undefined ? {} : { output: live.output }),
      ...(live.result === undefined ? {} : { result: live.result }),
      ...(live.truncated === undefined ? {} : { truncated: live.truncated }),
    };
  }
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    // Persisted transcript items are already complete history. A call with
    // no result is not a live queued operation and must never show a spinner.
    status: "missing",
    ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
    ...(call.truncated === undefined ? {} : { truncated: call.truncated }),
  };
}

function flushBatch(segments: AssistantSegment[], tools: ToolView[], key: string): void {
  if (tools.length === 0) return;
  segments.push({ type: "batch", key, tools: tools.slice() });
  tools.length = 0;
}

export function segmentsFromContent(
  content: readonly ConversationContentBlock[],
  liveTools: ConversationState["liveTools"],
  streaming = false,
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  const batch: ToolView[] = [];
  const results = new Map<string, Extract<ConversationContentBlock, { type: "toolResult" }>>();
  for (const block of content) {
    if (block.type === "toolResult") results.set(block.toolCallId, block);
  }
  let index = 0;
  for (const block of content) {
    if (block.type === "toolResult") continue;
    if (block.type === "toolCall") {
      batch.push(toolViewFromBlocks(block, results.get(block.toolCallId), liveTools[block.toolCallId]));
      continue;
    }
    flushBatch(segments, batch, `batch-${index}`);
    if (block.type === "thinking") {
      segments.push({
        type: "thinking",
        key: `thinking-${index}`,
        text: block.text,
        ...(block.truncated === undefined ? {} : { truncated: block.truncated }),
      });
    } else {
      segments.push({
        type: "text",
        key: `text-${index}`,
        text: block.text,
        ...(block.truncated === undefined ? {} : { truncated: block.truncated }),
        ...(streaming ? { streaming: true } : {}),
      });
    }
    index += 1;
  }
  flushBatch(segments, batch, `batch-${index}`);
  return segments;
}

function segmentsFromLive(live: LiveMessage, tools: readonly LiveTool[]): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  for (const block of live.blocks) {
    if (block.blockType === "thinking") {
      if (block.text.length === 0) continue;
      segments.push({ type: "thinking", key: block.blockId, text: block.text });
    } else {
      segments.push({
        type: "text",
        key: block.blockId,
        text: block.text,
        streaming: !live.aborted,
      });
    }
  }
  if (tools.length > 0) {
    segments.push({
      type: "batch",
      key: `live-tools-${live.messageId}`,
      tools: tools.map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        status: tool.status,
        ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
        ...(tool.output === undefined ? {} : { output: tool.output }),
        ...(tool.result === undefined ? {} : { result: tool.result }),
        ...(tool.truncated === undefined ? {} : { truncated: tool.truncated }),
      })),
    });
  }
  return segments;
}

function pendingRow(entry: PendingUser): TimelineRow {
  return {
    type: "user",
    itemId: `pending:${entry.requestId}`,
    createdAt: "",
    text: entry.text,
    pending: entry.status,
    requestId: entry.requestId,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

type AssistantRow = Extract<TimelineRow, { type: "assistant" }>;

function hasVisibleAssistantText(row: AssistantRow): boolean {
  return row.segments.some((segment) => segment.type === "text" && segment.text.trim().length > 0);
}

function mergedProcessStatus(rows: readonly AssistantRow[]): AssistantRow["status"] {
  if (rows.some((row) => row.status === "streaming")) return "streaming";
  if (rows.some((row) => row.status === "error")) return "error";
  if (rows.some((row) => row.status === "aborted")) return "aborted";
  return "completed";
}

function mergeProcessRows(rows: readonly AssistantRow[]): AssistantRow {
  const first = rows[0]!;
  const thinking: Extract<AssistantSegment, { type: "thinking" }>[] = [];
  const tools: ToolView[] = [];
  for (const row of rows) {
    for (const segment of row.segments) {
      if (segment.type === "thinking") {
        thinking.push({ ...segment, key: `${row.itemId}:${segment.key}` });
      } else if (segment.type === "batch") {
        tools.push(...segment.tools);
      }
    }
  }
  const segments: AssistantSegment[] = [...thinking];
  if (tools.length > 0) {
    segments.push({ type: "batch", key: `turn-process:${first.itemId}`, tools });
  }
  return {
    ...first,
    segments,
    status: mergedProcessStatus(rows),
    presentation: "process",
  };
}

/**
 * OMP persists each tool step as a separate assistant item. Present those
 * implementation steps as one process chain, then reserve the identity header
 * for the last text-bearing assistant item in the contiguous user turn.
 */
function presentAssistantTurns(rows: readonly TimelineRow[]): TimelineRow[] {
  const presented: TimelineRow[] = [];
  let assistantRun: AssistantRow[] = [];

  const flushRun = () => {
    if (assistantRun.length === 0) return;
    const merged: AssistantRow[] = [];
    let processRun: AssistantRow[] = [];
    const flushProcess = () => {
      if (processRun.length === 0) return;
      merged.push(mergeProcessRows(processRun));
      processRun = [];
    };
    for (const row of assistantRun) {
      if (!hasVisibleAssistantText(row)) {
        processRun.push(row);
        continue;
      }
      flushProcess();
      merged.push(row);
    }
    flushProcess();

    const last = merged[merged.length - 1];
    for (const row of merged) {
      presented.push({
        ...row,
        presentation: row === last && hasVisibleAssistantText(row) ? "reply" : "process",
      });
    }
    assistantRun = [];
  };

  for (const row of rows) {
    if (row.type === "assistant") {
      assistantRun.push(row);
      continue;
    }
    flushRun();
    presented.push(row);
  }
  flushRun();
  return presented;
}

export function buildTimeline(state: ConversationState): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const persisted = new Set(itemIdsOf(state.items));
  for (const item of state.items) {
    if (item.kind === "compaction") {
      rows.push({ type: "compaction", item });
      continue;
    }
    if (item.kind === "resetBoundary") {
      rows.push({ type: "resetBoundary", item });
      continue;
    }
    if (item.role === "user") {
      rows.push({
        type: "user",
        itemId: item.itemId,
        createdAt: item.createdAt,
        text: messageText(item),
      });
      continue;
    }
    const row = rowFromItem(item, state.liveTools);
    if (row.type === "assistant" && row.segments.length === 0) continue;
    rows.push(row);
  }
  for (const messageId of state.liveOrder) {
    if (persisted.has(messageId)) continue;
    const live = state.liveMessages[messageId];
    if (live === undefined) continue;
    const tools = Object.values(state.liveTools).filter((tool) => tool.messageId === messageId);
    if (live.role === "user") {
      rows.push({
        type: "user",
        itemId: live.messageId,
        createdAt: live.createdAt,
        text: live.blocks.map((block) => block.text).join("\n"),
      });
      continue;
    }
    rows.push({
      type: "assistant",
      itemId: live.messageId,
      createdAt: live.createdAt,
      segments: segmentsFromLive(live, tools),
      status: live.aborted ? "aborted" : "streaming",
    });
  }
  for (const pending of state.pendingUsers) {
    rows.push(pendingRow(pending));
  }
  return presentAssistantTurns(rows);
}

export function trackPending(state: ConversationState, pending: PendingUser): ConversationState {
  if (state.pendingUsers.some((entry) => entry.requestId === pending.requestId)) return state;
  return { ...state, pendingUsers: [...state.pendingUsers, pending] };
}

export function failPending(state: ConversationState, requestId: string, error: string): ConversationState {
  return {
    ...state,
    pendingUsers: state.pendingUsers.map((entry) =>
      entry.requestId === requestId ? { ...entry, status: "failed" as const, error } : entry,
    ),
  };
}

export function dropPending(state: ConversationState, requestId: string): ConversationState {
  return { ...state, pendingUsers: state.pendingUsers.filter((entry) => entry.requestId !== requestId) };
}

export function persistedItemsOf(convo: ClientConversationState): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const id of convo.order) {
    const item = convo.itemsById[id];
    if (item !== undefined) items.push(item);
  }
  return items;
}

function toolStatusFromClient(tool: ConversationLiveTool): ToolStatus {
  if (tool.status === "completed") return tool.isError === true ? "failed" : "succeeded";
  if (tool.status === "started" || tool.status === "updated") return "running";
  return "queued";
}

function liveToolFromClient(tool: ConversationLiveTool): LiveTool {
  return {
    toolCallId: tool.toolCallId,
    messageId: tool.messageId ?? "",
    turnId: tool.turnId,
    toolName: tool.toolName ?? "tool",
    status: toolStatusFromClient(tool),
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
    ...(tool.output === undefined ? {} : { output: tool.output }),
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(tool.truncated === undefined ? {} : { truncated: tool.truncated }),
  };
}

function liveMessageFromClient(message: ConversationLiveMessage): LiveMessage {
  return {
    messageId: message.messageId,
    turnId: message.turnId,
    role: message.role,
    createdAt: message.createdAt,
    blocks: Object.values(message.blocks),
    aborted: message.aborted,
  };
}

export function projectClientConversation(
  convo: ClientConversationState,
  pendingUsers: readonly PendingUser[],
  extras: {
    identityFallback?: ConversationIdentity | null;
    hydrateStatus?: HydrateStatus;
    error?: { readonly code: string; readonly message: string };
    unavailableReason?: string;
  } = {},
): ConversationState {
  const items = persistedItemsOf(convo);
  const liveMessages: { [messageId: string]: LiveMessage } = {};
  const liveOrder: string[] = [];
  for (const id of convo.order) {
    if (convo.itemsById[id] !== undefined) continue;
    const live = convo.liveMessages[id];
    if (live === undefined) continue;
    liveMessages[id] = liveMessageFromClient(live);
    liveOrder.push(id);
  }
  for (const [id, live] of Object.entries(convo.liveMessages)) {
    if (live === undefined || id in liveMessages || convo.itemsById[id] !== undefined) continue;
    liveMessages[id] = liveMessageFromClient(live);
    liveOrder.push(id);
  }
  const liveTools: { [toolCallId: string]: LiveTool } = {};
  for (const [id, tool] of Object.entries(convo.liveTools)) {
    if (tool !== undefined) liveTools[id] = liveToolFromClient(tool);
  }
  const identity = convo.identity ?? extras.identityFallback ?? null;
  const hydrateStatus = extras.hydrateStatus ?? mapClientHydrateStatus(convo);
  return {
    generation: convo.hydrateGeneration,
    identity,
    items,
    liveMessages,
    liveTools,
    liveOrder,
    hasMoreBefore: convo.hasMoreBefore,
    hydrateStatus,
    notices: convo.notices.map((notice, index) => ({
      id: `notice-${index}`,
      level: notice.level,
      message: notice.message,
    })),
    pendingUsers,
    resyncRequired: convo.resyncRequired,
    ...(convo.olderCursor === undefined ? {} : { olderCursor: convo.olderCursor }),
    ...(convo.headCursor === undefined ? {} : { headCursor: convo.headCursor }),
    ...(convo.lastEventSeq === undefined ? {} : { lastEventSeq: convo.lastEventSeq }),
    ...(extras.error === undefined ? convo.error === undefined ? {} : { error: convo.error } : { error: extras.error }),
    ...(extras.unavailableReason === undefined ? {} : { unavailableReason: extras.unavailableReason }),
  };
}

function mapClientHydrateStatus(convo: ClientConversationState): HydrateStatus {
  if (convo.resyncRequired && convo.hydrateStatus !== "error") return "resyncing";
  return convo.hydrateStatus;
}

function rowFromItem(item: ConversationItem, liveTools: ConversationState["liveTools"]): TimelineRow {
  if (item.kind === "compaction") return { type: "compaction", item };
  if (item.kind === "resetBoundary") return { type: "resetBoundary", item };
  if (item.role === "user") {
    return {
      type: "user",
      itemId: item.itemId,
      createdAt: item.createdAt,
      text: messageText(item),
    };
  }
  const used = new Set<string>();
  for (const block of item.content) {
    if (block.type === "toolCall" || block.type === "toolResult") used.add(block.toolCallId);
  }
  const extra = Object.values(liveTools).filter(
    (tool) => tool.messageId === item.itemId && !used.has(tool.toolCallId),
  );
  const segments = segmentsFromContent(item.content, liveTools);
  if (extra.length > 0) {
    segments.push({
      type: "batch",
      key: `live-tools-${item.itemId}`,
      tools: extra,
    });
  }
  const running = extra.some((tool) => tool.status === "running" || tool.status === "queued");
  return {
    type: "assistant",
    itemId: item.itemId,
    createdAt: item.createdAt,
    segments,
    status: running ? "streaming" : "completed",
  };
}

function liveToolMap(tools: readonly LiveTool[]): ConversationState["liveTools"] {
  const next: { [toolCallId: string]: LiveTool } = {};
  for (const tool of tools) next[tool.toolCallId] = tool;
  return next;
}

export function rowsFromConversationViews(
  views: readonly ConversationView[],
  pendingUsers: readonly PendingUser[] = [],
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const view of views) {
    if (view.kind === "item") {
      const row = rowFromItem(view.item, liveToolMap(view.tools.map(liveToolFromClient)));
      if (row.type === "assistant" && row.segments.length === 0) continue;
      rows.push(row);
      continue;
    }
    const live = liveMessageFromClient(view.message);
    const tools = view.tools.map(liveToolFromClient);
    if (live.role === "user") {
      rows.push({
        type: "user",
        itemId: live.messageId,
        createdAt: live.createdAt,
        text: live.blocks.map((block) => block.text).join("\n"),
      });
      continue;
    }
    rows.push({
      type: "assistant",
      itemId: live.messageId,
      createdAt: live.createdAt,
      segments: segmentsFromLive(live, tools),
      status: view.message.aborted ? "aborted" : view.message.completed ? "completed" : "streaming",
    });
  }
  for (const pending of pendingUsers) rows.push(pendingRow(pending));
  return presentAssistantTurns(rows);
}
