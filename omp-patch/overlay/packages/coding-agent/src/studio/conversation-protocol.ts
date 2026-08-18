export class StudioConversationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StudioConversationError";
	}
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ConversationRole = "user" | "assistant" | "system";

export type ConversationContentBlock =
	| { type: "text"; text: string; truncated?: boolean }
	| { type: "thinking"; text: string; truncated?: boolean }
	| {
			type: "toolCall";
			toolCallId: string;
			toolName: string;
			arguments?: JsonValue;
			truncated?: boolean;
	  }
	| {
			type: "toolResult";
			toolCallId: string;
			toolName?: string;
			output?: string;
			data?: JsonValue;
			isError: boolean;
			truncated?: boolean;
	  };

export type ConversationMessageItem = {
	kind: "message";
	itemId: string;
	parentId: string | null;
	createdAt: string;
	role: ConversationRole;
	content: readonly ConversationContentBlock[];
};

export type ConversationCompactionItem = {
	kind: "compaction";
	itemId: string;
	parentId: string | null;
	createdAt: string;
	summary: string;
	shortSummary?: string;
	warning?: string;
};

export type ConversationResetBoundaryItem = {
	kind: "resetBoundary";
	itemId: string;
	parentId: string | null;
	createdAt: string;
};

export type ConversationItem = ConversationMessageItem | ConversationCompactionItem | ConversationResetBoundaryItem;

/**
 * Why an assistant turn produced nothing. `provider`/`model` matter as much as
 * the text: a gateway that advertises a model through discovery but refuses to
 * serve it is only diagnosable from the pair that was actually requested.
 */
export type ConversationMessageError = {
	message: string;
	/** Provider HTTP status when the failure came from a request. */
	status?: number;
	provider?: string;
	model?: string;
};

export interface ConversationTranscriptPage {
	runtimeEpoch: number;
	sessionId: string;
	branchLeafId: string | null;
	items: readonly ConversationItem[];
	olderCursor?: string;
	headCursor: string;
	hasMoreBefore: boolean;
}

export const SESSION_TRANSCRIPT_READ_KIND = "session.transcript.read" as const;
export const SESSION_TRANSCRIPT_READ_CAPABILITY = "session.history" as const;
export const SESSION_TRANSCRIPT_READ_CONCURRENCY = "read-concurrent" as const;
export const CONVERSATION_CURSOR_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_CURSOR_DIRECTION = "older" as const;
export const CONVERSATION_CURSOR_NAMESPACE = "session.transcript.v1" as const;
export const CONVERSATION_BRANCH_SUMMARY_MAPPING = "ignore" as const;
export const CONVERSATION_PUBLIC_ITEM_KINDS = ["message", "compaction", "resetBoundary"] as const;
export const CONVERSATION_IGNORED_SESSION_ENTRY_TYPES = [
	"branch_summary",
	"custom",
	"label",
	"model_change",
	"service_tier_change",
] as const;
export const CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION = false as const;
export const CONVERSATION_REDACT_KEY_PATTERN =
	/token|secret|password|api[_-]?key|authorization|cookie|providerpayload/iu;

/** Runtime dispatcher allow-list. session.history is advertised only after the reader exists. */
export const STUDIO_CONVERSATION_DISPATCH_ALLOW_LIST = [SESSION_TRANSCRIPT_READ_KIND] as const;

export const CONVERSATION_LIMITS = {
	TRANSCRIPT_LIMIT_MIN: 1,
	TRANSCRIPT_LIMIT_MAX: 100,
	TRANSCRIPT_LIMIT_DEFAULT: 50,
	TEXT_BLOCK_MAX_BYTES: 256 * 1024,
	JSON_VALUE_MAX_BYTES: 256 * 1024,
	JSON_VALUE_MAX_DEPTH: 12,
	PAGE_MAX_BYTES: 768 * 1024,
	CURSOR_MAX_CHARS: 1024,
	ITEM_ID_MAX_CHARS: 256,
	TOOL_NAME_MAX_CHARS: 256,
	NOTICE_MESSAGE_MAX_CHARS: 16 * 1024,
	DELTA_MAX_BYTES: 32 * 1024,
	COMPACTION_SUMMARY_MAX_BYTES: 256 * 1024,
} as const;

export type ConversationRuntimeEvent =
	| {
			kind: "conversation.message.started";
			sessionId: string;
			turnId: string;
			messageId: string;
			role: ConversationRole;
			createdAt: string;
	  }
	| {
			kind: "conversation.message.delta";
			sessionId: string;
			turnId: string;
			messageId: string;
			blockId: string;
			blockType: "text" | "thinking";
			delta: string;
	  }
	| {
			kind: "conversation.message.completed";
			sessionId: string;
			turnId: string;
			messageId: string;
			item: ConversationMessageItem;
			/**
			 * Present when the assistant message ended with `stopReason: "error"`.
			 * The persisted item carries no error field. Studio latches the last
			 * live payload until that session's next assistant return succeeds.
			 */
			error?: ConversationMessageError;
	  }
	| {
			kind: "conversation.tool.started";
			sessionId: string;
			turnId: string;
			messageId: string;
			toolCallId: string;
			toolName: string;
			arguments?: JsonValue;
			startedAt: string;
	  }
	| {
			kind: "conversation.tool.updated";
			sessionId: string;
			turnId: string;
			toolCallId: string;
			updateMode: "append" | "replace";
			output?: string;
			truncated?: boolean;
	  }
	| {
			kind: "conversation.tool.completed";
			sessionId: string;
			turnId: string;
			toolCallId: string;
			result: Extract<ConversationContentBlock, { type: "toolResult" }>;
			completedAt: string;
	  }
	| { kind: "conversation.turn.completed"; sessionId: string; turnId: string }
	| { kind: "conversation.turn.aborted"; sessionId: string; turnId: string }
	| { kind: "conversation.compaction.started"; sessionId: string; action: string }
	| {
			kind: "conversation.compaction.completed";
			sessionId: string;
			item?: ConversationCompactionItem;
			aborted: boolean;
	  }
	| {
			kind: "conversation.notice";
			sessionId: string;
			level: "info" | "warning" | "error";
			message: string;
			source?: string;
	  };

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new StudioConversationError("Invalid conversation object");
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const allowedSet = new Set(allowed);
	if (Object.keys(value).some(key => !allowedSet.has(key))) {
		throw new StudioConversationError("Unknown conversation field");
	}
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function boundedId(value: unknown): string {
	if (!nonEmptyString(value) || value.length > CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS) {
		throw new StudioConversationError("Invalid conversation id");
	}
	return value;
}

function boundedUtf8(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || utf8Bytes(value) > maxBytes) {
		throw new StudioConversationError("Invalid conversation text");
	}
	return value;
}

function parseMessageError(value: unknown): ConversationMessageError {
	const input = record(value);
	exactKeys(input, ["message", "status", "provider", "model"]);
	const message = boundedUtf8(input.message, CONVERSATION_LIMITS.NOTICE_MESSAGE_MAX_CHARS);
	if (message.length === 0) throw new StudioConversationError("Invalid message error");
	if (input.status !== undefined && !Number.isSafeInteger(input.status)) {
		throw new StudioConversationError("Invalid message error status");
	}
	if (input.provider !== undefined) boundedId(input.provider);
	if (input.model !== undefined) boundedId(input.model);
	return input as unknown as ConversationMessageError;
}

function jsonValueLimited(value: unknown, depth: number, seen: Set<object>): void {
	if (depth > CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH) throw new StudioConversationError("JSON too deep");
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new StudioConversationError("Invalid JSON number");
		return;
	}
	if (typeof value !== "object") throw new StudioConversationError("Invalid JSON value");
	if (seen.has(value)) throw new StudioConversationError("Cyclic JSON value");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			for (const item of value) jsonValueLimited(item, depth + 1, seen);
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new StudioConversationError("Invalid JSON object");
		for (const item of Object.values(value as Record<string, unknown>)) jsonValueLimited(item, depth + 1, seen);
	} finally {
		seen.delete(value);
	}
}

function parseJsonValue(value: unknown): JsonValue {
	jsonValueLimited(value, 1, new Set());
	const encoded = JSON.stringify(value);
	if (utf8Bytes(encoded) > CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES) {
		throw new StudioConversationError("JSON value too large");
	}
	return value as JsonValue;
}

export function parseOpaqueConversationCursor(value: unknown): string {
	if (!nonEmptyString(value) || value.length > CONVERSATION_LIMITS.CURSOR_MAX_CHARS) {
		throw new StudioConversationError("Invalid conversation cursor");
	}
	return value;
}

export function parseSessionTranscriptReadLimit(value: unknown): number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN ||
		(value as number) > CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX
	) {
		throw new StudioConversationError("Invalid transcript limit");
	}
	return value as number;
}

function parseRole(value: unknown): ConversationRole {
	if (value !== "user" && value !== "assistant" && value !== "system") {
		throw new StudioConversationError("Invalid conversation role");
	}
	return value;
}

function parseBlock(value: unknown): ConversationContentBlock {
	const input = record(value);
	if (input.type === "text" || input.type === "thinking") {
		exactKeys(input, ["type", "text", "truncated"]);
		boundedUtf8(input.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		if (input.truncated !== undefined && typeof input.truncated !== "boolean") {
			throw new StudioConversationError("Invalid truncated flag");
		}
		return input as unknown as ConversationContentBlock;
	}
	if (input.type === "toolCall") {
		exactKeys(input, ["type", "toolCallId", "toolName", "arguments", "truncated"]);
		boundedId(input.toolCallId);
		boundedUtf8(input.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
		if (!nonEmptyString(input.toolName)) throw new StudioConversationError("Invalid tool name");
		if ("arguments" in input) parseJsonValue(input.arguments);
		if (input.truncated !== undefined && typeof input.truncated !== "boolean") {
			throw new StudioConversationError("Invalid truncated flag");
		}
		return input as unknown as ConversationContentBlock;
	}
	if (input.type === "toolResult") {
		exactKeys(input, ["type", "toolCallId", "toolName", "output", "data", "isError", "truncated"]);
		boundedId(input.toolCallId);
		if (typeof input.isError !== "boolean") throw new StudioConversationError("Invalid tool result");
		if (input.toolName !== undefined) {
			boundedUtf8(input.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
			if (!nonEmptyString(input.toolName)) throw new StudioConversationError("Invalid tool name");
		}
		if (input.output !== undefined) boundedUtf8(input.output, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		if ("data" in input) parseJsonValue(input.data);
		if (input.truncated !== undefined && typeof input.truncated !== "boolean") {
			throw new StudioConversationError("Invalid truncated flag");
		}
		return input as unknown as ConversationContentBlock;
	}
	throw new StudioConversationError("Invalid content block");
}

export function parseConversationItem(value: unknown): ConversationItem {
	const input = record(value);
	boundedId(input.itemId);
	if (input.parentId !== null) boundedId(input.parentId);
	if (!nonEmptyString(input.createdAt)) throw new StudioConversationError("Invalid item timestamp");
	if (input.kind === "message") {
		exactKeys(input, ["kind", "itemId", "parentId", "createdAt", "role", "content"]);
		parseRole(input.role);
		if (!Array.isArray(input.content)) throw new StudioConversationError("Invalid message content");
		for (const block of input.content) parseBlock(block);
		return input as unknown as ConversationItem;
	}
	if (input.kind === "compaction") {
		exactKeys(input, ["kind", "itemId", "parentId", "createdAt", "summary", "shortSummary", "warning"]);
		boundedUtf8(input.summary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
		if (!nonEmptyString(input.summary)) throw new StudioConversationError("Invalid compaction summary");
		if (input.shortSummary !== undefined) {
			boundedUtf8(input.shortSummary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
		}
		if (input.warning !== undefined) boundedUtf8(input.warning, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
		return input as unknown as ConversationItem;
	}
	if (input.kind === "resetBoundary") {
		exactKeys(input, ["kind", "itemId", "parentId", "createdAt"]);
		return input as unknown as ConversationItem;
	}
	throw new StudioConversationError("Invalid conversation item");
}

export function parseConversationTranscriptPage(value: unknown): ConversationTranscriptPage {
	const input = record(value);
	exactKeys(input, [
		"runtimeEpoch",
		"sessionId",
		"branchLeafId",
		"items",
		"olderCursor",
		"headCursor",
		"hasMoreBefore",
	]);
	if (!Number.isSafeInteger(input.runtimeEpoch) || (input.runtimeEpoch as number) <= 0) {
		throw new StudioConversationError("Invalid runtime epoch");
	}
	if (!nonEmptyString(input.sessionId)) throw new StudioConversationError("Invalid session id");
	if (input.branchLeafId !== null) boundedId(input.branchLeafId);
	if (!Array.isArray(input.items) || input.items.length > CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX) {
		throw new StudioConversationError("Invalid transcript items");
	}
	for (const item of input.items) parseConversationItem(item);
	parseOpaqueConversationCursor(input.headCursor);
	if (typeof input.hasMoreBefore !== "boolean") throw new StudioConversationError("Invalid hasMoreBefore");
	if (input.olderCursor !== undefined) parseOpaqueConversationCursor(input.olderCursor);
	if (utf8Bytes(JSON.stringify(input)) > CONVERSATION_LIMITS.PAGE_MAX_BYTES) {
		throw new StudioConversationError("Transcript page too large");
	}
	return input as unknown as ConversationTranscriptPage;
}

export function parseConversationRuntimeEvent(value: unknown): ConversationRuntimeEvent {
	const input = record(value);
	if (!nonEmptyString(input.kind) || !nonEmptyString(input.sessionId)) {
		throw new StudioConversationError("Invalid conversation event");
	}
	switch (input.kind) {
		case "conversation.message.started":
			exactKeys(input, ["kind", "sessionId", "turnId", "messageId", "role", "createdAt"]);
			boundedId(input.turnId);
			boundedId(input.messageId);
			parseRole(input.role);
			if (!nonEmptyString(input.createdAt)) throw new StudioConversationError("Invalid message timestamp");
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.message.delta":
			exactKeys(input, ["kind", "sessionId", "turnId", "messageId", "blockId", "blockType", "delta"]);
			boundedId(input.turnId);
			boundedId(input.messageId);
			boundedId(input.blockId);
			if (input.blockType !== "text" && input.blockType !== "thinking") {
				throw new StudioConversationError("Invalid delta block type");
			}
			boundedUtf8(input.delta, CONVERSATION_LIMITS.DELTA_MAX_BYTES);
			if (!nonEmptyString(input.delta)) throw new StudioConversationError("Invalid delta");
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.message.completed": {
			exactKeys(input, ["kind", "sessionId", "turnId", "messageId", "item", "error"]);
			const messageId = boundedId(input.messageId);
			boundedId(input.turnId);
			const item = parseConversationItem(input.item);
			if (item.kind !== "message" || item.itemId !== messageId) {
				throw new StudioConversationError("Completed message id mismatch");
			}
			if (input.error !== undefined) parseMessageError(input.error);
			return input as unknown as ConversationRuntimeEvent;
		}
		case "conversation.tool.started":
			exactKeys(input, [
				"kind",
				"sessionId",
				"turnId",
				"messageId",
				"toolCallId",
				"toolName",
				"arguments",
				"startedAt",
			]);
			boundedId(input.turnId);
			boundedId(input.messageId);
			boundedId(input.toolCallId);
			boundedUtf8(input.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
			if (!nonEmptyString(input.toolName) || !nonEmptyString(input.startedAt)) {
				throw new StudioConversationError("Invalid tool start");
			}
			if ("arguments" in input) parseJsonValue(input.arguments);
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.tool.updated":
			exactKeys(input, ["kind", "sessionId", "turnId", "toolCallId", "updateMode", "output", "truncated"]);
			boundedId(input.turnId);
			boundedId(input.toolCallId);
			if (input.updateMode !== "append" && input.updateMode !== "replace") {
				throw new StudioConversationError("Invalid tool update mode");
			}
			if (input.output !== undefined) boundedUtf8(input.output, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
			if (input.truncated !== undefined && typeof input.truncated !== "boolean") {
				throw new StudioConversationError("Invalid truncated flag");
			}
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.tool.completed": {
			exactKeys(input, ["kind", "sessionId", "turnId", "toolCallId", "result", "completedAt"]);
			const toolCallId = boundedId(input.toolCallId);
			boundedId(input.turnId);
			if (!nonEmptyString(input.completedAt)) throw new StudioConversationError("Invalid tool completion time");
			const result = parseBlock(input.result);
			if (result.type !== "toolResult" || result.toolCallId !== toolCallId) {
				throw new StudioConversationError("Tool result id mismatch");
			}
			return input as unknown as ConversationRuntimeEvent;
		}
		case "conversation.turn.completed":
		case "conversation.turn.aborted":
			exactKeys(input, ["kind", "sessionId", "turnId"]);
			boundedId(input.turnId);
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.compaction.started":
			exactKeys(input, ["kind", "sessionId", "action"]);
			if (!nonEmptyString(input.action)) throw new StudioConversationError("Invalid compaction action");
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.compaction.completed":
			exactKeys(input, ["kind", "sessionId", "item", "aborted"]);
			if (typeof input.aborted !== "boolean") throw new StudioConversationError("Invalid compaction aborted flag");
			if (input.item !== undefined) {
				const item = parseConversationItem(input.item);
				if (item.kind !== "compaction") throw new StudioConversationError("Invalid compaction item");
			}
			return input as unknown as ConversationRuntimeEvent;
		case "conversation.notice":
			exactKeys(input, ["kind", "sessionId", "level", "message", "source"]);
			if (input.level !== "info" && input.level !== "warning" && input.level !== "error") {
				throw new StudioConversationError("Invalid notice level");
			}
			boundedUtf8(input.message, CONVERSATION_LIMITS.NOTICE_MESSAGE_MAX_CHARS);
			if (!nonEmptyString(input.message)) throw new StudioConversationError("Invalid notice");
			if (input.source !== undefined && !nonEmptyString(input.source)) {
				throw new StudioConversationError("Invalid notice source");
			}
			return input as unknown as ConversationRuntimeEvent;
		default:
			throw new StudioConversationError("Unsupported conversation event");
	}
}
