import {
  CONVERSATION_LIMITS,
  truncateUtf8,
  type ClientError,
  type ClientEvent,
  type ConversationItem,
  type ConversationMessageError,
  type ConversationMessageItem,
  type ConversationRuntimeEvent,
  type ConversationTranscriptPage,
  type ConversationTranscriptReadPage,
  type RuntimeEpoch,
  type SessionId,
} from "@omp-studio/client-contract";

import {
  CONVERSATION_STATE_ITEM_CAP,
  CONVERSATION_STATE_LIVE_TOOLS_CAP,
  clearConversationState,
  createInitialConversationState,
  type ConversationLiveBlock,
  type ConversationLiveMessage,
  type ConversationLiveTool,
  type ConversationIdentity,
  type ConversationState,
  type StickyProviderError,
} from "./conversation-state.js";

/** UTF-8 byte cap for one accumulated live block; see appendBoundedText. */
const LIVE_BLOCK_TEXT_CAP = CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES;

export type ConversationAction =
  | { readonly type: "beginHydrate"; readonly identity: ConversationIdentity }
  | { readonly type: "hydrate"; readonly page: ConversationTranscriptPage; readonly generation: number }
  | { readonly type: "prepend"; readonly page: ConversationTranscriptPage; readonly generation: number }
  | { readonly type: "hydrateArchive"; readonly page: ConversationTranscriptReadPage; readonly generation: number }
  | { readonly type: "prependArchive"; readonly page: ConversationTranscriptReadPage; readonly generation: number }
  | { readonly type: "error"; readonly error: ClientError; readonly generation: number }
  | { readonly type: "live"; readonly event: Extract<ClientEvent, { readonly kind: "conversation.changed" }> }
  | { readonly type: "resync"; readonly reason?: string }
  | { readonly type: "clear" };

export function reduceConversationState(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "beginHydrate":
      return beginHydrate(state, action.identity);
    case "hydrate":
      return reduceHydrate(state, action.page, action.generation, false);
    case "prepend":
      return reduceHydrate(state, action.page, action.generation, true);
    case "hydrateArchive":
      return reduceHydrate(state, action.page, action.generation, false);
    case "prependArchive":
      return reduceHydrate(state, action.page, action.generation, true);
    case "error":
      if (action.generation !== state.hydrateGeneration) return state;
      return { ...state, hydrateStatus: "error", error: action.error };
    case "live":
      return reduceLive(state, action.event);
    case "resync":
      return { ...state, resyncRequired: true };
    case "clear":
      return clearConversationState(state);
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

function beginHydrate(state: ConversationState, identity: ConversationIdentity): ConversationState {
  const generation = state.hydrateGeneration + 1;
  if (state.identity !== undefined && sameIdentity(state.identity, identity)) {
    return {
      ...stripError(state),
      identity,
      hydrateStatus: "loading",
      hydrateGeneration: generation,
    };
  }
  return {
    ...createInitialConversationState(),
    identity,
    hydrateStatus: "loading",
    hydrateGeneration: generation,
    stickyProviderErrors: state.stickyProviderErrors,
  };
}

function stripError(state: ConversationState): ConversationState {
  if (state.error === undefined) return state;
  const { error: _error, ...rest } = state;
  return rest;
}

function reduceHydrate(
  state: ConversationState,
  page: ConversationTranscriptPage | ConversationTranscriptReadPage,
  generation: number,
  prepend: boolean,
): ConversationState {
  if (generation !== state.hydrateGeneration) return state;
  const pageIdentity = {
    ...("runtimeEpoch" in page ? { runtimeEpoch: page.runtimeEpoch } : {}),
    sessionId: page.sessionId,
    ...("transcriptRevision" in page ? { transcriptRevision: page.transcriptRevision } : {}),
  };
  if (state.identity !== undefined) {
    const sameSession = state.identity.sessionId === pageIdentity.sessionId;
    const sameRuntimeEpoch =
      state.identity.runtimeEpoch === undefined ||
      pageIdentity.runtimeEpoch === undefined ||
      state.identity.runtimeEpoch === pageIdentity.runtimeEpoch;
    if (!sameSession || !sameRuntimeEpoch || (prepend && !sameIdentity(state.identity, pageIdentity))) {
      return state;
    }
  }
  const itemsById: Record<string, ConversationItem> = prepend ? { ...state.itemsById } : {};
  const order: string[] = prepend ? [...state.order] : [];
  if (prepend) {
    const incoming = page.items.filter((item) => itemsById[item.itemId] === undefined).map((item) => item.itemId);
    for (const item of page.items) {
      if (itemsById[item.itemId] === undefined) itemsById[item.itemId] = item;
    }
    order.unshift(...incoming);
  } else {
    for (const item of page.items) {
      itemsById[item.itemId] = item;
      order.push(item.itemId);
    }
  }
  trimOldest(itemsById, order);
  const liveMessages = prepend ? state.liveMessages : retainLive(state.liveMessages, itemsById);
  const liveTools = prepend
    ? state.liveTools
    : capSettledLiveTools(retainTools(state.liveTools, itemsById));
  for (const messageId of Object.keys(liveMessages)) {
    if (!order.includes(messageId)) order.push(messageId);
  }
  const next: ConversationState = {
    identity: pageIdentity,
    itemsById,
    order,
    liveMessages,
    liveTools,
    notices: prepend ? state.notices : [],
    hasMoreBefore: page.hasMoreBefore,
    ...( "transcriptRevision" in page ? { transcriptRevision: page.transcriptRevision } : {}),
    hydrateStatus: "ready",
    hydrateGeneration: state.hydrateGeneration,
    resyncRequired: false,
    ...(page.olderCursor === undefined ? {} : { olderCursor: page.olderCursor }),
    headCursor: page.headCursor,
    abortedTurns: prepend ? state.abortedTurns : {},
    itemErrors: applyStickyProviderError(
      prepend ? { ...state.itemErrors } : retainItemErrors(state.itemErrors, itemsById, liveMessages),
      state.stickyProviderErrors[pageIdentity.sessionId],
    ),
    stickyProviderErrors: state.stickyProviderErrors,
    openTurnItems: state.openTurnItems,
    ...(prepend && state.lastEventSeq !== undefined ? { lastEventSeq: state.lastEventSeq } : {}),
    ...(state.compacting === undefined ? {} : { compacting: state.compacting }),
  };
  return next;
}

function retainLive(
  live: ConversationState["liveMessages"],
  itemsById: Readonly<Record<string, ConversationItem>>,
): ConversationState["liveMessages"] {
  const next: Record<string, ConversationLiveMessage> = {};
  for (const [id, message] of Object.entries(live)) {
    if (message !== undefined && itemsById[id] === undefined) next[id] = message;
  }
  return next;
}

function retainTools(
  live: ConversationState["liveTools"],
  itemsById: Readonly<Record<string, ConversationItem>>,
): ConversationState["liveTools"] {
  const next: Record<string, ConversationLiveTool> = {};
  for (const [id, tool] of Object.entries(live)) {
    if (tool === undefined) continue;
    if (toolResultPersisted(itemsById, tool)) continue;
    next[id] = tool;
  }
  return next;
}

function toolResultPersisted(
  itemsById: Readonly<Record<string, ConversationItem>>,
  tool: ConversationLiveTool,
): boolean {
  if (tool.messageId === undefined) return false;
  const item = itemsById[tool.messageId];
  if (item === undefined || item.kind !== "message") return false;
  return item.content.some((block) => block.type === "toolResult" && block.toolCallId === tool.toolCallId);
}

function reduceLive(
  state: ConversationState,
  event: Extract<ClientEvent, { readonly kind: "conversation.changed" }>,
): ConversationState {
  const update = event.update;
  const identity = { runtimeEpoch: event.runtimeEpoch as RuntimeEpoch, sessionId: update.sessionId };
  if (event.runtimeEpoch === undefined) return state;
  if (state.identity !== undefined && !sameIdentity(state.identity, identity)) {
    return state;
  }
  if (state.lastEventSeq !== undefined) {
    if (event.eventSeq <= state.lastEventSeq) return state;
  }
  const base: ConversationState = {
    ...state,
    identity: state.identity ?? identity,
    lastEventSeq: event.eventSeq,
    resyncRequired: state.resyncRequired,
  };
  return applyRuntimeEvent(base, update);
}

function applyRuntimeEvent(state: ConversationState, update: ConversationRuntimeEvent): ConversationState {
  switch (update.kind) {
    case "conversation.message.started":
      return startMessage(state, update);
    case "conversation.message.delta":
      return deltaMessage(state, update);
    case "conversation.message.completed":
      return completeMessage(state, update);
    case "conversation.tool.started":
      return startTool(state, update);
    case "conversation.tool.updated":
      return updateTool(state, update);
    case "conversation.tool.completed":
      return completeTool(state, update);
    case "conversation.turn.completed":
      return closeTurn(state, update.turnId);
    case "conversation.turn.aborted":
      return abortTurn(state, update);
    case "conversation.compaction.started":
      return { ...state, compacting: { action: update.action } };
    case "conversation.compaction.completed":
      return completeCompaction(state, update);
    case "conversation.notice": {
      const notice = {
        level: update.level,
        message: update.message,
        ...(update.source === undefined ? {} : { source: update.source }),
      };
      return { ...state, notices: [...state.notices, notice].slice(-32) };
    }
    default: {
      const _exhaustive: never = update;
      return state;
    }
  }
}

function startMessage(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.message.started" }>,
): ConversationState {
  if (state.itemsById[update.messageId] !== undefined) return state;
  if (state.abortedTurns[update.turnId] === true) return state;
  if (state.liveMessages[update.messageId] !== undefined) return state;
  const live: ConversationLiveMessage = {
    messageId: update.messageId,
    turnId: update.turnId,
    role: update.role,
    createdAt: update.createdAt,
    blocks: {},
    completed: false,
    aborted: false,
  };
  return {
    ...state,
    liveMessages: { ...state.liveMessages, [update.messageId]: live },
    order: state.order.includes(update.messageId) ? state.order : [...state.order, update.messageId],
  };
}

function deltaMessage(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }>,
): ConversationState {
  if (state.itemsById[update.messageId] !== undefined) return state;
  if (state.abortedTurns[update.turnId] === true) return state;
  const current = state.liveMessages[update.messageId];
  if (current === undefined || current.completed || current.aborted) return state;
  const existing = current.blocks[update.blockId];
  if (existing?.truncated === true) return state;
  const appended = appendBoundedText(existing?.text ?? "", update.delta);
  const block: ConversationLiveBlock = {
    blockId: update.blockId,
    blockType: update.blockType,
    text: appended.text,
    ...(appended.truncated ? { truncated: true } : {}),
  };
  return {
    ...state,
    liveMessages: {
      ...state.liveMessages,
      [update.messageId]: { ...current, blocks: { ...current.blocks, [update.blockId]: block } },
    },
  };
}

/**
 * Memory guard for the live streaming buffer: each delta is byte-bounded by
 * validation, but the accumulated block was not. The cap matches the persisted
 * sanitizer: UTF-8 bytes, never splitting a codepoint.
 */
function appendBoundedText(existing: string, delta: string): { readonly text: string; readonly truncated: boolean } {
  return truncateUtf8(existing + delta, LIVE_BLOCK_TEXT_CAP);
}

function completeMessage(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.message.completed" }>,
): ConversationState {
  if (update.item.itemId !== update.messageId) return state;
  const previous = state.liveMessages[update.messageId];
  const aborted = state.abortedTurns[update.turnId] === true || previous?.aborted === true;
  if (aborted) {
    const fromItem = blocksFromMessageItem(update.item);
    const live: ConversationLiveMessage = {
      messageId: update.messageId,
      turnId: update.turnId,
      role: update.item.role,
      createdAt: update.item.createdAt,
      blocks: Object.keys(fromItem).length > 0 ? fromItem : (previous?.blocks ?? {}),
      completed: true,
      aborted: true,
    };
    return {
      ...state,
      liveMessages: { ...state.liveMessages, [update.messageId]: live },
      order: state.order.includes(update.messageId) ? state.order : [...state.order, update.messageId],
      abortedTurns: { ...state.abortedTurns, [update.turnId]: true },
      ...providerErrorState(state, update.sessionId, update.messageId, update.error, false),
    };
  }
  const itemsById = { ...state.itemsById, [update.item.itemId]: update.item };
  const liveMessages = { ...state.liveMessages };
  delete liveMessages[update.messageId];
  const order = state.order.includes(update.item.itemId) ? state.order : [...state.order, update.item.itemId];
  return {
    ...state,
    itemsById,
    liveMessages,
    order,
    openTurnItems: { ...state.openTurnItems, [update.item.itemId]: update.turnId },
    ...providerErrorState(state, update.sessionId, update.messageId, update.error, update.item.role === "assistant"),
  };
}

function blocksFromMessageItem(item: ConversationMessageItem): Record<string, ConversationLiveBlock> {
  const blocks: Record<string, ConversationLiveBlock> = {};
  let index = 0;
  for (const block of item.content) {
    if (block.type !== "text" && block.type !== "thinking") continue;
    const blockId = `${block.type}-${index}`;
    index += 1;
    blocks[blockId] = { blockId, blockType: block.type, text: block.text };
  }
  return blocks;
}

function startTool(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.started" }>,
): ConversationState {
  const existing = state.liveTools[update.toolCallId];
  if (existing?.status === "aborted") return state;
  const existingStatus = existing?.status;
  const keepStream = existingStatus !== undefined && existingStatus !== "completed";
  const tool: ConversationLiveTool = {
    toolCallId: update.toolCallId,
    turnId: update.turnId,
    messageId: update.messageId,
    toolName: update.toolName,
    status: keepStream && existingStatus === "updated" ? "updated" : "started",
    startedAt: update.startedAt,
    ...(update.arguments === undefined ? {} : { arguments: update.arguments }),
    ...(keepStream && existing?.output !== undefined ? { output: existing.output } : {}),
    ...(keepStream && existing?.truncated === true ? { truncated: true } : {}),
  };
  return { ...state, liveTools: capSettledLiveTools({ ...state.liveTools, [update.toolCallId]: tool }) };
}

/**
 * Only `conversation.tool.started` carries the owning messageId, so a live tool
 * whose start we never saw (dropped after a resync) has to recover its owner
 * from the persisted item that declares the call, or its result would orphan and
 * the call would keep rendering as resultless.
 */
function ownerMessageId(state: ConversationState, toolCallId: string): string | undefined {
  for (const itemId of state.order) {
    const item = state.itemsById[itemId];
    if (item?.kind !== "message") continue;
    for (const block of item.content) {
      if (block.type === "toolCall" && block.toolCallId === toolCallId) return item.itemId;
    }
  }
  return undefined;
}

function updateTool(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.updated" }>,
): ConversationState {
  const existing = state.liveTools[update.toolCallId];
  if (existing?.status === "completed" || existing?.status === "aborted") return state;
  const previous = existing?.output ?? "";
  const raw = update.updateMode === "replace" ? (update.output ?? "") : previous + (update.output ?? "");
  const bounded = truncateUtf8(raw, LIVE_BLOCK_TEXT_CAP);
  const output = bounded.text;
  const truncated = existing?.truncated === true || update.truncated === true || bounded.truncated;
  const messageId = existing?.messageId ?? ownerMessageId(state, update.toolCallId);
  const tool: ConversationLiveTool = {
    toolCallId: update.toolCallId,
    turnId: update.turnId,
    status: "updated",
    ...(messageId === undefined ? {} : { messageId }),
    ...(existing?.toolName === undefined ? {} : { toolName: existing.toolName }),
    ...(existing?.arguments === undefined ? {} : { arguments: existing.arguments }),
    ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
    ...(output.length === 0 ? {} : { output }),
    ...(truncated ? { truncated: true } : {}),
  };
  return { ...state, liveTools: capSettledLiveTools({ ...state.liveTools, [update.toolCallId]: tool }) };
}

function completeTool(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.completed" }>,
): ConversationState {
  const existing = state.liveTools[update.toolCallId];
  const toolName = update.result.toolName ?? existing?.toolName;
  const messageId = existing?.messageId ?? ownerMessageId(state, update.toolCallId);
  const tool: ConversationLiveTool = {
    toolCallId: update.toolCallId,
    turnId: update.turnId,
    status: "completed",
    completedAt: update.completedAt,
    isError: update.result.isError,
    ...(messageId === undefined ? {} : { messageId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(existing?.arguments === undefined ? {} : { arguments: existing.arguments }),
    ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
    result: update.result,
    ...(update.result.output === undefined ? existing?.output === undefined ? {} : { output: existing.output } : { output: update.result.output }),
    ...(update.result.truncated === undefined ? {} : { truncated: update.result.truncated }),
  };
  return { ...state, liveTools: capSettledLiveTools({ ...state.liveTools, [update.toolCallId]: tool }) };
}

function abortTurn(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.turn.aborted" }>,
): ConversationState {
  if (state.abortedTurns[update.turnId] === true) return state;
  const liveMessages: Record<string, ConversationLiveMessage> = { ...state.liveMessages };
  for (const [id, message] of Object.entries(liveMessages)) {
    if (message === undefined || message.turnId !== update.turnId || message.aborted) continue;
    liveMessages[id] = { ...message, aborted: true };
  }
  // A hard-killed tool may never emit tool.completed; without this it would
  // keep rendering as running forever. A late tool.completed still overrides
  // the aborted marker with the authoritative result.
  const liveTools: Record<string, ConversationLiveTool> = { ...state.liveTools };
  for (const [id, tool] of Object.entries(liveTools)) {
    if (tool === undefined || tool.turnId !== update.turnId) continue;
    if (tool.status === "completed" || tool.status === "aborted") continue;
    liveTools[id] = { ...tool, status: "aborted" };
  }
  return {
    ...closeTurn(state, update.turnId),
    liveMessages,
    liveTools: capSettledLiveTools(liveTools),
    abortedTurns: { ...state.abortedTurns, [update.turnId]: true },
  };
}

/** Drops the turn's items from `openTurnItems`; their tools can no longer start. */
function closeTurn(state: ConversationState, turnId: string): ConversationState {
  const openTurnItems: Record<string, string> = {};
  for (const [itemId, owner] of Object.entries(state.openTurnItems)) {
    if (owner !== turnId) openTurnItems[itemId] = owner;
  }
  if (Object.keys(openTurnItems).length === Object.keys(state.openTurnItems).length) return state;
  return { ...state, openTurnItems };
}

function completeCompaction(
  state: ConversationState,
  update: Extract<ConversationRuntimeEvent, { kind: "conversation.compaction.completed" }>,
): ConversationState {
  const cleared = clearCompacting(state);
  if (update.item === undefined) {
    if (!update.aborted) return cleared;
    return {
      ...cleared,
      notices: [...cleared.notices, { level: "warning" as const, message: "上下文压缩已中止" }].slice(-32),
    };
  }
  const item = update.item;
  const itemsById = { ...cleared.itemsById, [item.itemId]: item };
  const order = cleared.order.includes(item.itemId) ? cleared.order : [...cleared.order, item.itemId];
  return { ...cleared, itemsById, order };
}

function clearCompacting(state: ConversationState): ConversationState {
  if (state.compacting === undefined) return state;
  const { compacting: _dropped, ...rest } = state;
  return rest;
}

function sameIdentity(
  left: { readonly runtimeEpoch?: RuntimeEpoch; readonly sessionId: SessionId; readonly transcriptRevision?: string },
  right: { readonly runtimeEpoch?: RuntimeEpoch; readonly sessionId: SessionId; readonly transcriptRevision?: string },
): boolean {
  if (left.sessionId !== right.sessionId) return false;
  if (left.runtimeEpoch !== undefined && right.runtimeEpoch !== undefined && left.runtimeEpoch !== right.runtimeEpoch) return false;
  if (
    left.transcriptRevision !== undefined &&
    right.transcriptRevision !== undefined &&
    left.transcriptRevision !== right.transcriptRevision
  ) return false;
  return true;
}

function trimOldest(itemsById: Record<string, ConversationItem>, order: string[]): void {
  while (order.length > CONVERSATION_STATE_ITEM_CAP) {
    const oldest = order.shift();
    if (oldest === undefined) break;
    delete itemsById[oldest];
  }
}

function capSettledLiveTools(
  liveTools: ConversationState["liveTools"],
): ConversationState["liveTools"] {
  const entries = Object.entries(liveTools).filter(
    (entry): entry is [string, ConversationLiveTool] => entry[1] !== undefined,
  );
  if (entries.length <= CONVERSATION_STATE_LIVE_TOOLS_CAP) return liveTools;
  let overflow = entries.length - CONVERSATION_STATE_LIVE_TOOLS_CAP;
  const drop = new Set<string>();
  for (const [id, tool] of entries) {
    if (overflow <= 0) break;
    if (tool.status !== "completed" && tool.status !== "aborted") continue;
    drop.add(id);
    overflow -= 1;
  }
  if (drop.size === 0) return liveTools;
  const next: Record<string, ConversationLiveTool> = {};
  for (const [id, tool] of entries) {
    if (!drop.has(id)) next[id] = tool;
  }
  return next;
}

function retainItemErrors(
  current: ConversationState["itemErrors"],
  itemsById: Readonly<Record<string, ConversationItem>>,
  liveMessages: ConversationState["liveMessages"],
): Record<string, ConversationMessageError> {
  const next: Record<string, ConversationMessageError> = {};
  for (const [id, error] of Object.entries(current)) {
    if (error !== undefined && (itemsById[id] !== undefined || liveMessages[id] !== undefined)) {
      next[id] = error;
    }
  }
  return next;
}

function applyStickyProviderError(
  itemErrors: Record<string, ConversationMessageError>,
  sticky: StickyProviderError | undefined,
): Record<string, ConversationMessageError> {
  if (sticky === undefined) return itemErrors;
  return { ...itemErrors, [sticky.itemId]: sticky.error };
}

function providerErrorState(
  state: ConversationState,
  sessionId: SessionId,
  itemId: string,
  error: ConversationMessageError | undefined,
  clearOnSuccess: boolean,
): Pick<ConversationState, "itemErrors" | "stickyProviderErrors"> {
  if (error !== undefined) {
    const sticky: StickyProviderError = { sessionId, itemId, error };
    return {
      itemErrors: { ...state.itemErrors, [itemId]: error },
      stickyProviderErrors: { ...state.stickyProviderErrors, [sessionId]: sticky },
    };
  }
  if (!clearOnSuccess) {
    return { itemErrors: state.itemErrors, stickyProviderErrors: state.stickyProviderErrors };
  }
  const stickyProviderErrors = { ...state.stickyProviderErrors };
  delete stickyProviderErrors[sessionId];
  return { itemErrors: {}, stickyProviderErrors };
}
