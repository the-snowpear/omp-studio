import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "../../session/session-entries";
import {
	CONVERSATION_BRANCH_SUMMARY_MAPPING,
	CONVERSATION_CURSOR_DIRECTION,
	CONVERSATION_CURSOR_NAMESPACE,
	CONVERSATION_CURSOR_SCHEMA_VERSION,
	CONVERSATION_IGNORED_SESSION_ENTRY_TYPES,
	CONVERSATION_LIMITS,
	type ConversationContentBlock,
	type ConversationItem,
	type ConversationTranscriptPage,
	type JsonValue,
	parseConversationTranscriptPage,
	parseSessionTranscriptReadLimit,
} from "../conversation-protocol";
import {
	publicToolCallId,
	sanitizePublicText,
	sanitizeToolArguments,
	truncateUtf8,
	utf8ByteLength,
} from "./conversation-sanitizer";
import { projectToolMedia } from "./conversation-media";
import { isHarnessInjectedUserMessage, publicConversationRole } from "./conversation-visibility";

export type StudioSessionTranscriptSessionManager = {
	getSessionId(): string;
	getLeafId(): string | null;
	getBranch(fromId?: string): readonly SessionEntry[];
};

export type StudioSessionTranscriptContext = {
	runtimeEpoch: number;
	sessionId: string;
	sessionManager?: StudioSessionTranscriptSessionManager | null;
};

export class StudioSessionTranscriptError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "CURSOR_STALE" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioSessionTranscriptError";
	}
}

type CursorFields = {
	sessionId: string;
	runtimeEpoch: number;
	branchLeafId: string;
	boundary: string;
};

const IGNORED_ENTRY_TYPES = new Set<string>(CONVERSATION_IGNORED_SESSION_ENTRY_TYPES);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function mapContentBlock(block: unknown, fallbackToolCallId: string): ConversationContentBlock | undefined {
	const record = asRecord(block);
	if (record === undefined) return undefined;
	if (record.type === "text" && typeof record.text === "string") {
		const text = sanitizePublicText(record.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		return { type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) };
	}
	if (record.type === "thinking" && typeof record.thinking === "string") {
		const text = sanitizePublicText(record.thinking, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		return { type: "thinking", text: text.text, ...(text.truncated ? { truncated: true } : {}) };
	}
	if (record.type === "toolCall" && typeof record.id === "string" && typeof record.name === "string") {
		const publicId = publicToolCallId(record.id, fallbackToolCallId);
		const toolName = sanitizePublicText(record.name, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
		const mapped: ConversationContentBlock = {
			type: "toolCall",
			toolCallId: publicId.id.length > 0 ? publicId.id : fallbackToolCallId,
			toolName: toolName.text.length > 0 ? toolName.text : "tool",
		};
		let truncated = toolName.truncated || publicId.truncated;
		if ("arguments" in record) {
			const args = sanitizeToolArguments(record.arguments);
			if (args.arguments !== undefined) mapped.arguments = args.arguments;
			truncated ||= args.truncated;
		}
		if (truncated) mapped.truncated = true;
		return mapped;
	}
	if (record.type === "image") {
		return {
			type: "text",
			text: "",
			truncated: true,
		};
	}
	return undefined;
}

function mapToolResultMessage(
	message: Record<string, unknown>,
	fallbackName: string | undefined,
	fallbackToolCallId: string,
): Extract<ConversationContentBlock, { type: "toolResult" }> {
	const rawId = typeof message.toolCallId === "string" ? message.toolCallId : "";
	const publicId = publicToolCallId(rawId, fallbackToolCallId);
	const toolCallId = publicId.id.length > 0 ? publicId.id : fallbackToolCallId;
	const nameSource = typeof message.toolName === "string" ? message.toolName : fallbackName;
	const toolName =
		nameSource === undefined ? undefined : sanitizePublicText(nameSource, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
	const texts: string[] = [];

	let truncated = toolName?.truncated === true || publicId.truncated;
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			const record = asRecord(block);
			if (record === undefined) continue;
			if (record.type === "text" && typeof record.text === "string") texts.push(record.text);
		}
	} else if (typeof message.content === "string") {
		texts.push(message.content);
	}
	const output = sanitizePublicText(texts.join("\n"), CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
	truncated ||= output.truncated;
	const mapped: Extract<ConversationContentBlock, { type: "toolResult" }> = {
		type: "toolResult",
		toolCallId,
		isError: message.isError === true,
	};
	if (toolName !== undefined && toolName.text.length > 0) mapped.toolName = toolName.text;
	if (output.text.length > 0) mapped.output = output.text;
	const media = projectToolMedia(message.content, message.details);
	if (media.data !== undefined) mapped.data = media.data;
	truncated ||= media.truncated;
	if (truncated) mapped.truncated = true;
	return mapped;
}

function mapMessageEntry(entry: SessionEntry & { type: "message" }): ConversationItem | undefined {
	const message = asRecord(entry.message) ?? {};
	const createdAt =
		typeof entry.timestamp === "string" && entry.timestamp.length > 0 ? entry.timestamp : new Date(0).toISOString();
	if (message.role === "toolResult") {
		return undefined;
	}
	if (isHarnessInjectedUserMessage(message)) return undefined;
	const role = publicConversationRole(message.role);
	if (role === undefined) return undefined;
	const content: ConversationContentBlock[] = [];
	if (typeof message.content === "string") {
		const text = sanitizePublicText(message.content, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		content.push({ type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
	} else if (Array.isArray(message.content)) {
		for (const block of message.content) {
			try {
				const mapped = mapContentBlock(block, `tool:${entry.id}:${content.length}`);
				if (mapped !== undefined) content.push(mapped);
			} catch {
				content.push({ type: "text", text: "", truncated: true });
			}
		}
	}
	if (content.length === 0) return undefined;
	return {
		kind: "message",
		itemId: entry.id,
		parentId: entry.parentId,
		createdAt,
		role,
		content,
	};
}

function mapCompactionEntry(entry: SessionEntry & { type: "compaction" }): ConversationItem {
	const summary = sanitizePublicText(entry.summary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
	const item: ConversationItem = {
		kind: "compaction",
		itemId: entry.id,
		parentId: entry.parentId,
		createdAt: entry.timestamp,
		summary: summary.text.length > 0 ? summary.text : " ",
	};
	if (typeof entry.shortSummary === "string") {
		const shortSummary = sanitizePublicText(entry.shortSummary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
		if (shortSummary.text.length > 0) item.shortSummary = shortSummary.text;
	}
	if (typeof entry.warning === "string") {
		const warning = sanitizePublicText(entry.warning, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
		if (warning.text.length > 0) item.warning = warning.text;
	}
	return item;
}

function projectEntry(entry: SessionEntry): ConversationItem | undefined {
	if (IGNORED_ENTRY_TYPES.has(entry.type)) return undefined;
	if (entry.type === "branch_summary" && CONVERSATION_BRANCH_SUMMARY_MAPPING === "ignore") return undefined;
	if (entry.type === "message") return mapMessageEntry(entry);
	if (entry.type === "compaction") return mapCompactionEntry(entry);
	if (entry.type === "reset_boundary") {
		return {
			kind: "resetBoundary",
			itemId: entry.id,
			parentId: entry.parentId,
			createdAt: entry.timestamp,
		};
	}
	return undefined;
}

function unpairedToolCall(
	item: Extract<ConversationItem, { kind: "message" }>,
): Extract<ConversationContentBlock, { type: "toolCall" }> | undefined {
	for (let index = item.content.length - 1; index >= 0; index--) {
		const block = item.content[index];
		if (block?.type !== "toolCall") continue;
		if (item.content.some(entry => entry.type === "toolResult" && entry.toolCallId === block.toolCallId)) continue;
		return block;
	}
	return undefined;
}

function attachToolResult(
	items: ConversationItem[],
	toolOwners: Map<string, number>,
	result: Extract<ConversationContentBlock, { type: "toolResult" }>,
	parentId: string | null,
	rawToolCallId: string,
): { index: number; result: Extract<ConversationContentBlock, { type: "toolResult" }> } | undefined {
	const ownerIndex = toolOwners.get(result.toolCallId);
	if (ownerIndex !== undefined) {
		const owner = items[ownerIndex];
		if (owner !== undefined && owner.kind === "message") return { index: ownerIndex, result };
	}
	if (rawToolCallId.length > 0 || parentId === null) return undefined;
	const parentIndex = items.findIndex(item => item.itemId === parentId);
	const parent = parentIndex < 0 ? undefined : items[parentIndex];
	if (parent === undefined || parent.kind !== "message") return undefined;
	const call = unpairedToolCall(parent);
	if (call === undefined) return undefined;
	return { index: parentIndex, result: { ...result, toolCallId: call.toolCallId } };
}

export function projectConversationBranch(entries: readonly SessionEntry[]): ConversationItem[] {
	const items: ConversationItem[] = [];
	const toolOwners = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = asRecord(entry.message) ?? {};
			if (message.role === "toolResult") {
				const rawId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const mapped = mapToolResultMessage(message, undefined, `tool:${entry.id}`);
				const attached = attachToolResult(items, toolOwners, mapped, entry.parentId, rawId);
				if (attached !== undefined) {
					const owner = items[attached.index];
					if (owner !== undefined && owner.kind === "message") {
						const content = owner.content.some(
							block => block.type === "toolResult" && block.toolCallId === attached.result.toolCallId,
						)
							? owner.content
							: [...owner.content, attached.result];
						items[attached.index] = { ...owner, content };
					}
					continue;
				}
				items.push({
					kind: "message",
					itemId: entry.id,
					parentId: entry.parentId,
					createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString(),
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: mapped.toolCallId, toolName: mapped.toolName ?? "tool" },
						mapped,
					],
				});
				continue;
			}
		}
		try {
			const item = projectEntry(entry);
			if (item === undefined || (item.kind === "message" && item.content.length === 0)) continue;
			const index = items.length;
			items.push(item);
			if (item.kind === "message") {
				for (const block of item.content) {
					if (block.type === "toolCall") toolOwners.set(block.toolCallId, index);
				}
			}
		} catch {
			// A malformed entry is not allowed to create an empty public row.
		}
	}
	return items;
}

const PAGE_PAYLOAD_BYTE_STEPS = [64 * 1024, 16 * 1024, 4 * 1024, 1024, 256] as const;

function compactJson(value: JsonValue, maxBytes: number): JsonValue {
	try {
		if (utf8ByteLength(JSON.stringify(value)) <= maxBytes) return value;
	} catch {
		// Projected JSON should already be serializable; fail closed if it is not.
	}
	return { truncated: true };
}

/** Reduce large payloads while preserving item and tool association shells. */
function shrinkItem(item: ConversationItem, maxPayloadBytes: number): ConversationItem {
	if (item.kind === "message") {
		let changed = false;
		const content = item.content.map(block => {
			if (block.type === "text" || block.type === "thinking") {
				const text = truncateUtf8(block.text, Math.min(maxPayloadBytes, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES));
				if (!text.truncated) return block;
				changed = true;
				return { ...block, text: text.text, truncated: true };
			}
			if (block.type === "toolCall") {
				if (block.arguments === undefined) return block;
				const args = compactJson(block.arguments, maxPayloadBytes);
				if (args === block.arguments) return block;
				changed = true;
				return { ...block, arguments: args, truncated: true };
			}
			const output =
				block.output === undefined
					? undefined
					: truncateUtf8(block.output, Math.min(maxPayloadBytes, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES));
			const data = block.data === undefined ? undefined : compactJson(block.data, maxPayloadBytes);
			if (output?.truncated !== true && data === block.data) return block;
			changed = true;
			return {
				...block,
				...(output === undefined ? {} : { output: output.text }),
				...(data === undefined ? {} : { data }),
				truncated: true,
			};
		});
		if (!changed) return item;
		return {
			...item,
			content,
		};
	}
	if (item.kind === "compaction") {
		const summary = truncateUtf8(item.summary, maxPayloadBytes);
		const shortSummary =
			item.shortSummary === undefined ? undefined : truncateUtf8(item.shortSummary, maxPayloadBytes);
		const warning = item.warning === undefined ? undefined : truncateUtf8(item.warning, maxPayloadBytes);
		if (!summary.truncated && shortSummary?.truncated !== true && warning?.truncated !== true) return item;
		return {
			...item,
			summary: summary.text.length > 0 ? summary.text : " ",
			...(shortSummary === undefined ? {} : { shortSummary: shortSummary.text }),
			...(warning === undefined ? {} : { warning: warning.text }),
		};
	}
	return item;
}

export type ConversationTranscriptSource = {
	runtimeEpoch: number;
	sessionId: string;
	branchLeafId: string;
	branch: readonly SessionEntry[];
};

function encodeConversationCursor(fields: CursorFields, secret: Buffer): string {
	const payload = JSON.stringify({
		ns: CONVERSATION_CURSOR_NAMESPACE,
		v: CONVERSATION_CURSOR_SCHEMA_VERSION,
		sessionId: fields.sessionId,
		runtimeEpoch: fields.runtimeEpoch,
		branchLeafId: fields.branchLeafId,
		boundary: fields.boundary,
		direction: CONVERSATION_CURSOR_DIRECTION,
	});
	const token = `${payload}\n${signConversationCursor(payload, secret)}`;
	const cursor = Buffer.from(token, "utf8").toString("base64url");
	if (cursor.length === 0 || cursor.length > CONVERSATION_LIMITS.CURSOR_MAX_CHARS) {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Transcript cursor exceeds the protocol limit");
	}
	return cursor;
}

function signConversationCursor(payload: string, secret: Buffer): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

function decodeConversationCursor(cursor: string, secret: Buffer): CursorFields {
	if (cursor.length === 0 || cursor.length > CONVERSATION_LIMITS.CURSOR_MAX_CHARS) {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Malformed transcript cursor");
	}
	let decoded: string;
	try {
		decoded = Buffer.from(cursor, "base64url").toString("utf8");
	} catch {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Malformed transcript cursor");
	}
	const separator = decoded.lastIndexOf("\n");
	if (separator <= 0 || separator === decoded.length - 1) {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Malformed transcript cursor");
	}
	const payload = decoded.slice(0, separator);
	const signature = decoded.slice(separator + 1);
	const expected = signConversationCursor(payload, secret);
	const actual = Buffer.from(signature);
	const wanted = Buffer.from(expected);
	if (!(actual.length === wanted.length && actual.length > 0 && timingSafeEqual(actual, wanted))) {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Malformed transcript cursor");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Malformed transcript cursor");
	}
	const record = asRecord(parsed);
	if (
		record === undefined ||
		record.ns !== CONVERSATION_CURSOR_NAMESPACE ||
		record.v !== CONVERSATION_CURSOR_SCHEMA_VERSION ||
		record.direction !== CONVERSATION_CURSOR_DIRECTION ||
		typeof record.sessionId !== "string" ||
		record.sessionId.length === 0 ||
		!Number.isSafeInteger(record.runtimeEpoch) ||
		(record.runtimeEpoch as number) <= 0 ||
		typeof record.branchLeafId !== "string" ||
		typeof record.boundary !== "string"
	) {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Malformed transcript cursor");
	}
	return {
		sessionId: record.sessionId,
		runtimeEpoch: record.runtimeEpoch as number,
		branchLeafId: record.branchLeafId,
		boundary: record.boundary,
	};
}

/** Paginate a projected branch with the same signed cursor rules as the live session reader. */
export function readConversationTranscriptPage(
	source: ConversationTranscriptSource,
	args: { cursor?: string; limit?: number } = {},
	secret: Buffer,
): ConversationTranscriptPage {
	if (source.sessionId.length === 0) {
		throw new StudioSessionTranscriptError("COMMAND_BLOCKED", "Runtime has no active session");
	}
	if (!Number.isSafeInteger(source.runtimeEpoch) || source.runtimeEpoch <= 0) {
		throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Invalid runtime epoch");
	}
	let limit: number = CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT;
	if (args.limit !== undefined) {
		try {
			limit = parseSessionTranscriptReadLimit(args.limit);
		} catch {
			throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Invalid transcript limit");
		}
	}
	const publicItems = projectConversationBranch(source.branch);
	let endExclusive = publicItems.length;
	if (args.cursor !== undefined) {
		const cursor = decodeConversationCursor(args.cursor, secret);
		if (
			cursor.sessionId !== source.sessionId ||
			cursor.runtimeEpoch !== source.runtimeEpoch ||
			cursor.branchLeafId !== source.branchLeafId
		) {
			throw new StudioSessionTranscriptError("CURSOR_STALE", "Transcript cursor does not match the active branch");
		}
		if (cursor.boundary.length === 0) {
			endExclusive = 0;
		} else {
			const index = publicItems.findIndex(item => item.itemId === cursor.boundary);
			if (index < 0) {
				throw new StudioSessionTranscriptError(
					"CURSOR_STALE",
					"Transcript cursor boundary is not on the active branch",
				);
			}
			endExclusive = index;
		}
	}
	const start = Math.max(0, endExclusive - limit);
	let items = publicItems.slice(start, endExclusive);
	let hasMoreBefore = start > 0;
	const headCursor = encodeConversationCursor(
		{
			sessionId: source.sessionId,
			runtimeEpoch: source.runtimeEpoch,
			branchLeafId: source.branchLeafId,
			boundary: publicItems.at(-1)?.itemId ?? "",
		},
		secret,
	);
	const pageFields = (): ConversationTranscriptPage => {
		const olderCursor =
			hasMoreBefore && items[0] !== undefined
				? encodeConversationCursor(
						{
							sessionId: source.sessionId,
							runtimeEpoch: source.runtimeEpoch,
							branchLeafId: source.branchLeafId,
							boundary: items[0].itemId,
						},
						secret,
					)
				: undefined;
		return {
			runtimeEpoch: source.runtimeEpoch,
			sessionId: source.sessionId,
			branchLeafId: source.branchLeafId.length > 0 ? source.branchLeafId : null,
			items,
			headCursor,
			hasMoreBefore,
			...(olderCursor === undefined ? {} : { olderCursor }),
		};
	};
	let page = pageFields();
	if (utf8ByteLength(JSON.stringify(page)) > CONVERSATION_LIMITS.PAGE_MAX_BYTES) {
		for (const maxPayloadBytes of PAGE_PAYLOAD_BYTE_STEPS) {
			items = items.map(item => shrinkItem(item, maxPayloadBytes));
			page = pageFields();
			if (utf8ByteLength(JSON.stringify(page)) <= CONVERSATION_LIMITS.PAGE_MAX_BYTES) break;
		}
	}
	while (utf8ByteLength(JSON.stringify(page)) > CONVERSATION_LIMITS.PAGE_MAX_BYTES && items.length > 1) {
		items = items.slice(1);
		hasMoreBefore = true;
		page = pageFields();
	}
	if (utf8ByteLength(JSON.stringify(page)) > CONVERSATION_LIMITS.PAGE_MAX_BYTES && items.length === 1) {
		items = [shrinkItem(items[0]!, PAGE_PAYLOAD_BYTE_STEPS.at(-1)!)];
		page = pageFields();
	}
	return parseConversationTranscriptPage(page);
}

/** Signed opaque cursor for the active session branch. Independent of agent.transcript.read. */
export class StudioSessionTranscriptService {
	readonly #context: () => StudioSessionTranscriptContext;
	readonly #cursorSecret: Buffer;

	constructor(context: () => StudioSessionTranscriptContext, cursorSecret: Buffer = randomBytes(32)) {
		this.#context = context;
		this.#cursorSecret = cursorSecret;
	}

	headCursor(): string {
		const snapshot = this.#snapshot(false);
		const publicItems = projectConversationBranch(snapshot.branch);
		return encodeConversationCursor(
			{
				sessionId: snapshot.sessionId,
				runtimeEpoch: snapshot.runtimeEpoch,
				branchLeafId: snapshot.branchLeafId,
				boundary: publicItems.at(-1)?.itemId ?? "",
			},
			this.#cursorSecret,
		);
	}

	read(args: { cursor?: string; limit?: number } = {}): ConversationTranscriptPage {
		return readConversationTranscriptPage(this.#snapshot(true), args, this.#cursorSecret);
	}

	#snapshot(requireSession: boolean): {
		runtimeEpoch: number;
		sessionId: string;
		branchLeafId: string;
		branch: readonly SessionEntry[];
	} {
		const context = this.#context();
		const sessionManager = context.sessionManager;
		const sessionId = sessionManager?.getSessionId?.() || context.sessionId;
		if (requireSession && (sessionManager === undefined || sessionManager === null || sessionId.length === 0)) {
			throw new StudioSessionTranscriptError("COMMAND_BLOCKED", "Runtime has no active session");
		}
		if (sessionId.length === 0) {
			throw new StudioSessionTranscriptError("COMMAND_BLOCKED", "Runtime has no active session");
		}
		if (!Number.isSafeInteger(context.runtimeEpoch) || context.runtimeEpoch <= 0) {
			throw new StudioSessionTranscriptError("INVALID_ARGUMENT", "Invalid runtime epoch");
		}
		const branch =
			sessionManager !== undefined && sessionManager !== null && typeof sessionManager.getBranch === "function"
				? sessionManager.getBranch()
				: [];
		const leafId =
			sessionManager !== undefined && sessionManager !== null && typeof sessionManager.getLeafId === "function"
				? (sessionManager.getLeafId() ?? "")
				: "";
		return {
			runtimeEpoch: context.runtimeEpoch,
			sessionId,
			branchLeafId: leafId,
			branch,
		};
	}
}
