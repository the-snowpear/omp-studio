import { ContractValidationError } from "./contract-error.js";
import {
  CONVERSATION_LIMITS,
  type ConversationCompactionItem,
  type ConversationContentBlock,
  type ConversationItem,
  type ConversationMessageError,
  type ConversationMessageItem,
  type ConversationResetBoundaryItem,
  type ConversationRole,
  type ConversationOpenResult,
  type ConversationResolvedTarget,
  type ConversationRuntimeEvent,
  type ConversationStreamEvent,
  type ConversationTranscriptPage,
  type JsonValue,
} from "./contracts/conversation.js";
import type { AgentId, OpaqueCursor, SessionId } from "./contracts/ids.js";

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError("expected an object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new ContractValidationError(`unknown field ${JSON.stringify(unknown)}`, path);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError("expected a non-empty string", path);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractValidationError("expected a boolean", path);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return booleanValue(value, path);
}

function boundedId(value: unknown, path: string): string {
  const id = nonEmptyString(value, path);
  if (id.length > CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS) {
    throw new ContractValidationError(
      `id must be at most ${CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS} characters`,
      path,
    );
  }
  return id;
}

function boundedUtf8(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") throw new ContractValidationError("expected a string", path);
  if (utf8Bytes(value) > maxBytes) {
    throw new ContractValidationError(`exceeds ${maxBytes} UTF-8 bytes`, path);
  }
  return value;
}

function parseMessageError(value: unknown, path: string): ConversationMessageError {
  const input = record(value, path);
  exactKeys(input, ["message", "status", "provider", "model"], path);
  const message = boundedUtf8(input.message, `${path}.message`, CONVERSATION_LIMITS.NOTICE_MESSAGE_MAX_CHARS);
  if (message.length === 0) throw new ContractValidationError("expected a non-empty string", `${path}.message`);
  const error: ConversationMessageError = { message };
  if (input.status !== undefined) {
    if (!Number.isSafeInteger(input.status)) {
      throw new ContractValidationError("expected a safe integer", `${path}.status`);
    }
    error.status = input.status as number;
  }
  if (input.provider !== undefined) error.provider = boundedId(input.provider, `${path}.provider`);
  if (input.model !== undefined) error.model = boundedId(input.model, `${path}.model`);
  return error;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ContractValidationError("expected a positive safe integer", path);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractValidationError("expected a non-negative safe integer", path);
  }
  return value as number;
}

function jsonValueLimited(value: unknown, path: string, depth: number, seen: Set<object>): JsonValue {
  if (depth > CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH) {
    throw new ContractValidationError(
      `JSON depth exceeds ${CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH}`,
      path,
    );
  }
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw new ContractValidationError("expected a finite JSON number", path);
    case "object": {
      if (seen.has(value)) {
        throw new ContractValidationError("cyclic value is not JSON-safe", path);
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item, index) => jsonValueLimited(item, `${path}[${index}]`, depth + 1, seen));
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new ContractValidationError("expected a plain object", path);
        }
        const result: Record<string, JsonValue> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          result[key] = jsonValueLimited(item, `${path}.${key}`, depth + 1, seen);
        }
        return result;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new ContractValidationError("expected a JSON-safe value", path);
  }
}

function parseJsonValue(value: unknown, path: string): JsonValue {
  const parsed = jsonValueLimited(value, path, 1, new Set());
  const encoded = JSON.stringify(parsed);
  if (utf8Bytes(encoded) > CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES) {
    throw new ContractValidationError(
      `JSON value exceeds ${CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES} UTF-8 bytes`,
      path,
    );
  }
  return parsed;
}

function parseTruncated(value: unknown, path: string): boolean | undefined {
  return optionalBoolean(value, path);
}

export function parseOpaqueConversationCursor(value: unknown, path: string): OpaqueCursor {
  const cursor = nonEmptyString(value, path);
  if (cursor.length > CONVERSATION_LIMITS.CURSOR_MAX_CHARS) {
    throw new ContractValidationError(
      `cursor must be at most ${CONVERSATION_LIMITS.CURSOR_MAX_CHARS} characters`,
      path,
    );
  }
  return cursor as OpaqueCursor;
}

function parseRole(value: unknown, path: string): ConversationRole {
  if (value !== "user" && value !== "assistant" && value !== "system") {
    throw new ContractValidationError("unsupported conversation role", path);
  }
  return value;
}

export function parseConversationContentBlock(value: unknown, path: string): ConversationContentBlock {
  const input = record(value, path);
  const type = nonEmptyString(input.type, `${path}.type`);
  if (type === "text" || type === "thinking") {
    exactKeys(input, ["type", "text", "truncated"], path);
    const text = boundedUtf8(input.text, `${path}.text`, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
    const truncated = parseTruncated(input.truncated, `${path}.truncated`);
    return truncated === undefined ? { type, text } : { type, text, truncated };
  }
  if (type === "toolCall") {
    exactKeys(input, ["type", "toolCallId", "toolName", "arguments", "truncated"], path);
    const toolCallId = boundedId(input.toolCallId, `${path}.toolCallId`);
    const toolName = boundedUtf8(input.toolName, `${path}.toolName`, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
    if (toolName.length === 0) {
      throw new ContractValidationError("expected a non-empty string", `${path}.toolName`);
    }
    const truncated = parseTruncated(input.truncated, `${path}.truncated`);
    const block: Extract<ConversationContentBlock, { type: "toolCall" }> = {
      type: "toolCall",
      toolCallId,
      toolName,
    };
    if ("arguments" in input) block.arguments = parseJsonValue(input.arguments, `${path}.arguments`);
    if (truncated !== undefined) block.truncated = truncated;
    return block;
  }
  if (type === "toolResult") {
    exactKeys(input, ["type", "toolCallId", "toolName", "output", "data", "isError", "truncated"], path);
    const toolCallId = boundedId(input.toolCallId, `${path}.toolCallId`);
    const isError = booleanValue(input.isError, `${path}.isError`);
    const truncated = parseTruncated(input.truncated, `${path}.truncated`);
    const block: Extract<ConversationContentBlock, { type: "toolResult" }> = {
      type: "toolResult",
      toolCallId,
      isError,
    };
    if (input.toolName !== undefined) {
      const toolName = boundedUtf8(input.toolName, `${path}.toolName`, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
      if (toolName.length === 0) {
        throw new ContractValidationError("expected a non-empty string", `${path}.toolName`);
      }
      block.toolName = toolName;
    }
    if (input.output !== undefined) {
      block.output = boundedUtf8(input.output, `${path}.output`, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
    }
    if ("data" in input) block.data = parseJsonValue(input.data, `${path}.data`);
    if (truncated !== undefined) block.truncated = truncated;
    return block;
  }
  throw new ContractValidationError("unsupported content block type", `${path}.type`);
}

function parseParentId(value: unknown, path: string): string | null {
  if (value === null) return null;
  return boundedId(value, path);
}

export function parseConversationItem(value: unknown, path: string): ConversationItem {
  const input = record(value, path);
  const kind = nonEmptyString(input.kind, `${path}.kind`);
  const itemId = boundedId(input.itemId, `${path}.itemId`);
  const parentId = parseParentId(input.parentId, `${path}.parentId`);
  const createdAt = nonEmptyString(input.createdAt, `${path}.createdAt`);
  if (kind === "message") {
    exactKeys(input, ["kind", "itemId", "parentId", "createdAt", "role", "content"], path);
    if (!Array.isArray(input.content)) {
      throw new ContractValidationError("expected an array", `${path}.content`);
    }
    const content = input.content.map((block, index) =>
      parseConversationContentBlock(block, `${path}.content[${index}]`),
    );
    return {
      kind: "message",
      itemId,
      parentId,
      createdAt,
      role: parseRole(input.role, `${path}.role`),
      content,
    } satisfies ConversationMessageItem;
  }
  if (kind === "compaction") {
    exactKeys(input, ["kind", "itemId", "parentId", "createdAt", "summary", "shortSummary", "warning"], path);
    const summary = boundedUtf8(input.summary, `${path}.summary`, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
    if (summary.length === 0) {
      throw new ContractValidationError("expected a non-empty string", `${path}.summary`);
    }
    const item: ConversationCompactionItem = { kind: "compaction", itemId, parentId, createdAt, summary };
    if (input.shortSummary !== undefined) {
      item.shortSummary = boundedUtf8(
        input.shortSummary,
        `${path}.shortSummary`,
        CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES,
      );
    }
    if (input.warning !== undefined) {
      item.warning = boundedUtf8(input.warning, `${path}.warning`, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
    }
    return item;
  }
  if (kind === "resetBoundary") {
    exactKeys(input, ["kind", "itemId", "parentId", "createdAt"], path);
    return { kind: "resetBoundary", itemId, parentId, createdAt } satisfies ConversationResetBoundaryItem;
  }
  throw new ContractValidationError("unsupported conversation item kind", `${path}.kind`);
}

export function parseConversationTranscriptPage(value: unknown, path = "$page"): ConversationTranscriptPage {
  const input = record(value, path);
  exactKeys(
    input,
    ["runtimeEpoch", "sessionId", "branchLeafId", "items", "olderCursor", "headCursor", "hasMoreBefore"],
    path,
  );
  const runtimeEpoch = positiveInteger(input.runtimeEpoch, `${path}.runtimeEpoch`);
  const sessionId = nonEmptyString(input.sessionId, `${path}.sessionId`);
  if (input.branchLeafId !== null) boundedId(input.branchLeafId, `${path}.branchLeafId`);
  if (!Array.isArray(input.items)) {
    throw new ContractValidationError("expected an array", `${path}.items`);
  }
  if (input.items.length > CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX) {
    throw new ContractValidationError(
      `items must contain at most ${CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX} entries`,
      `${path}.items`,
    );
  }
  const items = input.items.map((item, index) => parseConversationItem(item, `${path}.items[${index}]`));
  const headCursor = parseOpaqueConversationCursor(input.headCursor, `${path}.headCursor`);
  const hasMoreBefore = booleanValue(input.hasMoreBefore, `${path}.hasMoreBefore`);
  const encoded = JSON.stringify(input);
  if (utf8Bytes(encoded) > CONVERSATION_LIMITS.PAGE_MAX_BYTES) {
    throw new ContractValidationError(
      `transcript page exceeds ${CONVERSATION_LIMITS.PAGE_MAX_BYTES} UTF-8 bytes`,
      path,
    );
  }
  const page: ConversationTranscriptPage = {
    runtimeEpoch: runtimeEpoch as ConversationTranscriptPage["runtimeEpoch"],
    sessionId: sessionId as ConversationTranscriptPage["sessionId"],
    branchLeafId: input.branchLeafId as string | null,
    items,
    headCursor,
    hasMoreBefore,
  };
  if (input.olderCursor !== undefined) {
    page.olderCursor = parseOpaqueConversationCursor(input.olderCursor, `${path}.olderCursor`);
  }
  return page;
}

function parseConversationResolvedTarget(value: unknown, path: string): ConversationResolvedTarget {
  const input = record(value, path);
  const kind = nonEmptyString(input.kind, `${path}.kind`);
  if (kind === "session") {
    exactKeys(input, ["kind", "sessionId", "conversationSessionId"], path);
    const sessionId = boundedId(input.sessionId, `${path}.sessionId`);
    const conversationSessionId = boundedId(input.conversationSessionId, `${path}.conversationSessionId`);
    if (conversationSessionId !== sessionId) {
      throw new ContractValidationError("conversationSessionId must equal sessionId", `${path}.conversationSessionId`);
    }
    return {
      kind,
      sessionId: sessionId as SessionId,
      conversationSessionId: conversationSessionId as SessionId,
    };
  }
  if (kind === "agent") {
    exactKeys(input, ["kind", "parentSessionId", "agentId", "conversationSessionId"], path);
    return {
      kind,
      parentSessionId: boundedId(input.parentSessionId, `${path}.parentSessionId`) as SessionId,
      agentId: boundedId(input.agentId, `${path}.agentId`) as AgentId,
      conversationSessionId: boundedId(input.conversationSessionId, `${path}.conversationSessionId`) as SessionId,
    };
  }
  throw new ContractValidationError("unsupported conversation target kind", `${path}.kind`);
}

function parseConversationStreamEvent(value: unknown, path: string): ConversationStreamEvent {
  const input = record(value, path);
  exactKeys(input, ["streamSeq", "eventSeq", "stateVersion", "occurredAt", "update"], path);
  return {
    streamSeq: positiveInteger(input.streamSeq, `${path}.streamSeq`),
    eventSeq: positiveInteger(input.eventSeq, `${path}.eventSeq`),
    stateVersion: nonNegativeInteger(input.stateVersion, `${path}.stateVersion`),
    occurredAt: nonEmptyString(input.occurredAt, `${path}.occurredAt`),
    update: parseConversationRuntimeEvent(input.update, `${path}.update`),
  };
}

export function parseConversationOpenResult(value: unknown, path = "$result"): ConversationOpenResult {
  const input = record(value, path);
  exactKeys(input, ["target", "page", "live"], path);
  const target = parseConversationResolvedTarget(input.target, `${path}.target`);
  const page = parseConversationTranscriptPage(input.page, `${path}.page`);
  if (page.sessionId !== target.conversationSessionId) {
    throw new ContractValidationError("page session does not match resolved target", `${path}.page.sessionId`);
  }
  const liveInput = record(input.live, `${path}.live`);
  const status = nonEmptyString(liveInput.status, `${path}.live.status`);
  const watermark = nonNegativeInteger(liveInput.watermark, `${path}.live.watermark`);
  if (!Array.isArray(liveInput.events)) {
    throw new ContractValidationError("expected an array", `${path}.live.events`);
  }
  if (status === "complete") {
    exactKeys(liveInput, ["status", "watermark", "events"], `${path}.live`);
    const events = liveInput.events.map((event, index) =>
      parseConversationStreamEvent(event, `${path}.live.events[${index}]`),
    );
    if (events.length > CONVERSATION_LIMITS.LIVE_REPLAY_MAX_EVENTS) {
      throw new ContractValidationError(
        `live replay must contain at most ${CONVERSATION_LIMITS.LIVE_REPLAY_MAX_EVENTS} events`,
        `${path}.live.events`,
      );
    }
    if (utf8Bytes(JSON.stringify(liveInput)) > CONVERSATION_LIMITS.LIVE_REPLAY_MAX_BYTES) {
      throw new ContractValidationError(
        `live replay exceeds ${CONVERSATION_LIMITS.LIVE_REPLAY_MAX_BYTES} UTF-8 bytes`,
        `${path}.live`,
      );
    }
    let previous = 0;
    for (const event of events) {
      if (event.streamSeq <= previous || event.streamSeq > watermark) {
        throw new ContractValidationError("stream sequences must increase and not exceed watermark", `${path}.live.events`);
      }
      if (event.update.sessionId !== target.conversationSessionId) {
        throw new ContractValidationError("live event session does not match resolved target", `${path}.live.events`);
      }
      previous = event.streamSeq;
    }
    return { target, page, live: { status, watermark, events } };
  }
  if (status === "resyncRequired") {
    exactKeys(liveInput, ["status", "watermark", "events", "reason"], `${path}.live`);
    if (liveInput.events.length !== 0) {
      throw new ContractValidationError("resyncRequired replay must not contain partial events", `${path}.live.events`);
    }
    return {
      target,
      page,
      live: {
        status,
        watermark,
        events: [],
        reason: nonEmptyString(liveInput.reason, `${path}.live.reason`),
      },
    };
  }
  throw new ContractValidationError("unsupported live replay status", `${path}.live.status`);
}

export function parseSessionTranscriptReadLimit(value: unknown, path: string): number {
  const limit = positiveInteger(value, path);
  if (limit < CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN || limit > CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX) {
    throw new ContractValidationError(
      `limit must be between ${CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN} and ${CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX}`,
      path,
    );
  }
  return limit;
}

function parseMessageItem(value: unknown, path: string): ConversationMessageItem {
  const item = parseConversationItem(value, path);
  if (item.kind !== "message") {
    throw new ContractValidationError("expected a message item", path);
  }
  return item;
}

function parseCompactionItem(value: unknown, path: string): ConversationCompactionItem {
  const item = parseConversationItem(value, path);
  if (item.kind !== "compaction") {
    throw new ContractValidationError("expected a compaction item", path);
  }
  return item;
}

function parseToolResultBlock(
  value: unknown,
  path: string,
): Extract<ConversationContentBlock, { type: "toolResult" }> {
  const block = parseConversationContentBlock(value, path);
  if (block.type !== "toolResult") {
    throw new ContractValidationError("expected a toolResult block", path);
  }
  return block;
}

export function isConversationRuntimeEventKind(kind: unknown): kind is string {
  return typeof kind === "string" && kind.startsWith("conversation.");
}

export function parseConversationRuntimeEvent(value: unknown, path = "$event.event"): ConversationRuntimeEvent {
  const input = record(value, path);
  const kind = nonEmptyString(input.kind, `${path}.kind`);
  const sessionId = nonEmptyString(input.sessionId, `${path}.sessionId`);
  switch (kind) {
    case "conversation.message.started": {
      exactKeys(input, ["kind", "sessionId", "turnId", "messageId", "role", "createdAt"], path);
      return {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
        messageId: boundedId(input.messageId, `${path}.messageId`),
        role: parseRole(input.role, `${path}.role`),
        createdAt: nonEmptyString(input.createdAt, `${path}.createdAt`),
      };
    }
    case "conversation.message.delta": {
      exactKeys(input, ["kind", "sessionId", "turnId", "messageId", "blockId", "blockType", "delta"], path);
      if (input.blockType !== "text" && input.blockType !== "thinking") {
        throw new ContractValidationError("unsupported block type", `${path}.blockType`);
      }
      const delta = boundedUtf8(input.delta, `${path}.delta`, CONVERSATION_LIMITS.DELTA_MAX_BYTES);
      if (delta.length === 0) {
        throw new ContractValidationError("expected a non-empty string", `${path}.delta`);
      }
      return {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
        messageId: boundedId(input.messageId, `${path}.messageId`),
        blockId: boundedId(input.blockId, `${path}.blockId`),
        blockType: input.blockType,
        delta,
      };
    }
    case "conversation.message.completed": {
      exactKeys(input, ["kind", "sessionId", "turnId", "messageId", "item", "error"], path);
      const messageId = boundedId(input.messageId, `${path}.messageId`);
      const item = parseMessageItem(input.item, `${path}.item`);
      if (item.itemId !== messageId) {
        throw new ContractValidationError("item.itemId must equal messageId", `${path}.item.itemId`);
      }
      const error = input.error === undefined ? undefined : parseMessageError(input.error, `${path}.error`);
      return {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
        messageId,
        item,
        ...(error === undefined ? {} : { error }),
      };
    }
    case "conversation.tool.started": {
      exactKeys(
        input,
        ["kind", "sessionId", "turnId", "messageId", "toolCallId", "toolName", "arguments", "startedAt"],
        path,
      );
      const event: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.started" }> = {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
        messageId: boundedId(input.messageId, `${path}.messageId`),
        toolCallId: boundedId(input.toolCallId, `${path}.toolCallId`),
        toolName: boundedUtf8(input.toolName, `${path}.toolName`, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS),
        startedAt: nonEmptyString(input.startedAt, `${path}.startedAt`),
      };
      if (event.toolName.length === 0) {
        throw new ContractValidationError("expected a non-empty string", `${path}.toolName`);
      }
      if ("arguments" in input) event.arguments = parseJsonValue(input.arguments, `${path}.arguments`);
      return event;
    }
    case "conversation.tool.updated": {
      exactKeys(input, ["kind", "sessionId", "turnId", "toolCallId", "updateMode", "output", "truncated"], path);
      if (input.updateMode !== "append" && input.updateMode !== "replace") {
        throw new ContractValidationError("unsupported update mode", `${path}.updateMode`);
      }
      const event: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.updated" }> = {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
        toolCallId: boundedId(input.toolCallId, `${path}.toolCallId`),
        updateMode: input.updateMode,
      };
      if (input.output !== undefined) {
        event.output = boundedUtf8(input.output, `${path}.output`, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
      }
      const truncated = parseTruncated(input.truncated, `${path}.truncated`);
      if (truncated !== undefined) event.truncated = truncated;
      return event;
    }
    case "conversation.tool.completed": {
      exactKeys(input, ["kind", "sessionId", "turnId", "toolCallId", "result", "completedAt"], path);
      const result = parseToolResultBlock(input.result, `${path}.result`);
      const toolCallId = boundedId(input.toolCallId, `${path}.toolCallId`);
      if (result.toolCallId !== toolCallId) {
        throw new ContractValidationError("result.toolCallId must equal toolCallId", `${path}.result.toolCallId`);
      }
      return {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
        toolCallId,
        result,
        completedAt: nonEmptyString(input.completedAt, `${path}.completedAt`),
      };
    }
    case "conversation.turn.completed":
    case "conversation.turn.aborted": {
      exactKeys(input, ["kind", "sessionId", "turnId"], path);
      return {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        turnId: boundedId(input.turnId, `${path}.turnId`),
      };
    }
    case "conversation.compaction.started": {
      exactKeys(input, ["kind", "sessionId", "action"], path);
      return {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        action: nonEmptyString(input.action, `${path}.action`),
      };
    }
    case "conversation.compaction.completed": {
      exactKeys(input, ["kind", "sessionId", "item", "aborted"], path);
      const aborted = booleanValue(input.aborted, `${path}.aborted`);
      const event: Extract<ConversationRuntimeEvent, { kind: "conversation.compaction.completed" }> = {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        aborted,
      };
      if (input.item !== undefined) event.item = parseCompactionItem(input.item, `${path}.item`);
      return event;
    }
    case "conversation.notice": {
      exactKeys(input, ["kind", "sessionId", "level", "message", "source"], path);
      if (input.level !== "info" && input.level !== "warning" && input.level !== "error") {
        throw new ContractValidationError("unsupported notice level", `${path}.level`);
      }
      const event: Extract<ConversationRuntimeEvent, { kind: "conversation.notice" }> = {
        kind,
        sessionId: sessionId as ConversationRuntimeEvent["sessionId"],
        level: input.level,
        message: boundedUtf8(input.message, `${path}.message`, CONVERSATION_LIMITS.NOTICE_MESSAGE_MAX_CHARS),
      };
      if (event.message.length === 0) {
        throw new ContractValidationError("expected a non-empty string", `${path}.message`);
      }
      if (input.source !== undefined) event.source = nonEmptyString(input.source, `${path}.source`);
      return event;
    }
    default:
      throw new ContractValidationError("unsupported event kind", `${path}.kind`);
  }
}
