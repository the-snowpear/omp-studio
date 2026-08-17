import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import {
	CONVERSATION_LIMITS,
	type ConversationContentBlock,
	type ConversationMessageError,
	type ConversationMessageItem,
	type ConversationRole,
	type ConversationRuntimeEvent,
	parseConversationRuntimeEvent,
} from "../conversation-protocol";
import { sanitizeJsonValue, sanitizePublicText, sanitizeToolArguments, utf8ByteLength } from "./conversation-sanitizer";

export const CONVERSATION_LIVE_COALESCE_INTERVAL_MS = 16;
export const CONVERSATION_LIVE_COALESCE_CHAR_THRESHOLD = 64;
export const CONVERSATION_LIVE_QUEUE_LIMIT = 128;

export interface ConversationLiveClock {
	nowMs(): number;
	nowIso(): string;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
}

export interface ConversationLiveBindTarget {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface ConversationLiveProjectorOptions {
	sessionId: string;
	runtimeEpoch: number;
	reserveMessageId: (input: { role: ConversationRole; createdAt: string }) => string;
	/** Non-message entries (compaction). Must not consume the message-id FIFO. */
	allocateEntryId?: () => string;
	reserveCompactionId?: () => string;
	releaseCompactionId?: (id: string) => void;
	lookupPersistedCompactionId?: (input: { summary: string }) => string | undefined;
	clock?: ConversationLiveClock;
	coalesceIntervalMs?: number;
	coalesceCharThreshold?: number;
	queueLimit?: number;
	onDiagnostic?: (message: string) => void;
}

type LiveListener = (event: ConversationRuntimeEvent) => void;

type PendingDelta = {
	sessionId: string;
	turnId: string;
	messageId: string;
	blockId: string;
	blockType: "text" | "thinking";
	delta: string;
};

type OpenMessage = {
	messageId: string;
	turnId: string;
	role: ConversationRole;
	createdAt: string;
	parentId: string | null;
	blocks: Map<string, { blockType: "text" | "thinking"; text: string }>;
	toolCalls: Map<string, Extract<ConversationContentBlock, { type: "toolCall" }>>;
	completed: boolean;
};

function defaultClock(): ConversationLiveClock {
	return {
		nowMs: () => Date.now(),
		nowIso: () => new Date().toISOString(),
		setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimer: timer => {
			clearTimeout(timer as never);
		},
	};
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function publicRole(role: string): ConversationRole | undefined {
	if (role === "user" || role === "assistant" || role === "system") return role;
	return undefined;
}

/**
 * `http-inspector` appends `raw-http-request=<absolute path>` to provider errors
 * so the raw body can be inspected on the Runtime host. That line is a local
 * debugging pointer and `shortenHomePath` only rewrites a *leading* home prefix,
 * so drop it rather than ship an absolute path to the operator surface.
 */
function withoutRawHttpPointer(message: string): string {
	return message
		.split("\n")
		.filter(line => !line.startsWith("raw-http-request"))
		.join("\n")
		.trim();
}

function boundedLabel(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value.length > CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS ? undefined : value;
}

/**
 * A provider-error turn carries no content, so without this the operator sees a
 * turn that simply produced nothing. Mirrors what the TUI shows for the same
 * `stopReason`.
 */
function messageErrorOf(message: AgentMessage): ConversationMessageError | undefined {
	if (!isAssistant(message) || message.stopReason !== "error") return undefined;
	const text = withoutRawHttpPointer(message.errorMessage ?? "");
	const sanitized = sanitizePublicText(
		text.length > 0 ? text : "Provider request failed",
		CONVERSATION_LIMITS.NOTICE_MESSAGE_MAX_CHARS,
	);
	const error: ConversationMessageError = { message: sanitized.text };
	if (typeof message.errorStatus === "number" && Number.isSafeInteger(message.errorStatus)) {
		error.status = message.errorStatus;
	}
	const provider = boundedLabel(message.provider);
	if (provider !== undefined) error.provider = provider;
	const model = boundedLabel(message.model);
	if (model !== undefined) error.model = model;
	return error;
}

function createdAtOf(message: AgentMessage, fallbackIso: string): string {
	if ("timestamp" in message && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
		return new Date(message.timestamp).toISOString();
	}
	return fallbackIso;
}

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

function isControlEvent(kind: ConversationRuntimeEvent["kind"]): boolean {
	return kind !== "conversation.message.delta" && kind !== "conversation.tool.updated";
}

function toolText(result: unknown): {
	text: string;
	isError: boolean;
	data?: import("../conversation-protocol").JsonValue;
	truncated?: boolean;
} {
	if (result instanceof Error) return { text: result.message, isError: true };
	if (result === null || result === undefined) return { text: "", isError: false };
	if (typeof result === "string") return { text: result, isError: false };
	if (typeof result !== "object") return { text: String(result), isError: false };
	const record = result as Record<string, unknown>;
	const isError = record.isError === true;
	const details = record.details === undefined ? undefined : sanitizeJsonValue(record.details);
	const extra = details?.value === undefined ? {} : { data: details.value };
	const truncated = details?.truncated === true ? { truncated: true } : {};
	if (Array.isArray(record.content)) {
		const text = record.content
			.filter((block): block is { type: "text"; text: string } => {
				return (
					block !== null &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				);
			})
			.map(block => block.text)
			.join("");
		return { text, isError, ...extra, ...truncated };
	}
	if (typeof record.output === "string") return { text: record.output, isError, ...extra, ...truncated };
	if (typeof record.message === "string") return { text: record.message, isError, ...extra, ...truncated };
	return { text: "", isError, ...extra, ...truncated };
}

function sameDeltaIdentity(
	left: Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }>,
	right: Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }>,
): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.turnId === right.turnId &&
		left.messageId === right.messageId &&
		left.blockId === right.blockId &&
		left.blockType === right.blockType
	);
}

/**
 * Projects `AgentSession.subscribe()` events into contract live events.
 * Does not wrap StudioEventEnvelope; StateProjector owns eventSeq/stateVersion.
 */
export class ConversationLiveProjector {
	readonly #options: ConversationLiveProjectorOptions;
	readonly #clock: ConversationLiveClock;
	readonly #listeners = new Set<LiveListener>();
	readonly #queue: ConversationRuntimeEvent[] = [];
	readonly #pending = new Map<string, PendingDelta>();
	readonly #openMessages = new Map<string, OpenMessage>();
	readonly #completedMessageIds = new Set<string>();
	readonly #completedToolIds = new Set<string>();
	readonly #toolOutput = new Map<string, string>();
	#sessionId: string;
	#runtimeEpoch: number;
	#generation = 0;
	#turnSeq = 0;
	#turnId: string | undefined;
	#turnAborted = false;
	#turnCompleted = false;
	#lastItemId: string | null = null;
	#openAssistantId: string | undefined;
	#openCompactionId: string | undefined;
	#unsubscribe: (() => void) | undefined;
	#coalesceTimer: unknown;
	#disposed = false;

	constructor(options: ConversationLiveProjectorOptions) {
		this.#options = options;
		this.#clock = options.clock ?? defaultClock();
		this.#sessionId = options.sessionId;
		this.#runtimeEpoch = options.runtimeEpoch;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	get runtimeEpoch(): number {
		return this.#runtimeEpoch;
	}

	onEvent(listener: LiveListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	bind(target: ConversationLiveBindTarget): void {
		this.#unsubscribe?.();
		this.#unsubscribe = target.subscribe(event => this.project(event));
	}

	rebind(target: ConversationLiveBindTarget | undefined, identity: { sessionId: string; runtimeEpoch: number }): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#clearLiveState();
		this.#sessionId = identity.sessionId;
		this.#runtimeEpoch = identity.runtimeEpoch;
		this.#generation += 1;
		if (target !== undefined) this.bind(target);
	}

	flush(): void {
		this.#flushPendingDeltas();
		this.#drain();
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#clearCoalesceTimer();
		this.#pending.clear();
		this.#queue.length = 0;
		this.#clearLiveState();
		this.#listeners.clear();
		this.#disposed = true;
	}

	project(event: AgentSessionEvent): void {
		if (this.#disposed) return;
		try {
			this.#project(event);
		} catch (error) {
			this.#diagnostic(error instanceof Error ? error.message : "conversation live projector failed");
		}
	}

	#project(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#onAgentStart();
				return;
			case "agent_end":
				this.#onAgentEnd();
				return;
			case "message_start":
				this.#onMessageStart(event.message);
				return;
			case "message_update":
				this.#onMessageUpdate(event.message, event.assistantMessageEvent);
				return;
			case "message_end":
				this.#onMessageEnd(event.message);
				return;
			case "tool_execution_start":
				this.#onToolStart(event);
				return;
			case "tool_execution_update":
				this.#onToolUpdate(event);
				return;
			case "tool_execution_end":
				this.#onToolEnd(event);
				return;
			case "auto_compaction_start":
				this.#onCompactionStart(event.action);
				return;
			case "auto_compaction_end":
				this.#onCompactionEnd(event);
				return;
			case "auto_retry_start":
				this.#emitNotice("warning", `Retry ${event.attempt}/${event.maxAttempts}`, "retry");
				return;
			case "notice":
				this.#emitNotice(event.level, event.message, event.source);
				return;
			default:
				return;
		}
	}

	#onAgentStart(): void {
		this.#turnSeq += 1;
		this.#turnId = `turn-${this.#turnSeq}`;
		this.#turnAborted = false;
		this.#turnCompleted = false;
		this.#openAssistantId = undefined;
	}

	#onAgentEnd(): void {
		this.#flushPendingDeltas();
		const turnId = this.#ensureTurnId();
		if (this.#turnAborted) {
			this.#emitParsed({ kind: "conversation.turn.aborted", sessionId: this.#sessionId, turnId });
		} else if (!this.#turnCompleted) {
			this.#emitParsed({ kind: "conversation.turn.completed", sessionId: this.#sessionId, turnId });
		}
		this.#turnCompleted = true;
		this.#openAssistantId = undefined;
	}

	#onMessageStart(message: AgentMessage): void {
		if (message.role === "user" && "synthetic" in message && message.synthetic) return;
		if (message.role === "user" && "steering" in message && message.steering) return;
		const role = publicRole(message.role);
		if (role === undefined) {
			this.#diagnostic(`ignored session message role ${message.role}`);
			return;
		}
		if (this.#turnAborted) return;
		const turnId = this.#ensureTurnId();
		const createdAt = createdAtOf(message, this.#clock.nowIso());
		const messageId = this.#options.reserveMessageId({ role, createdAt });
		const open: OpenMessage = {
			messageId,
			turnId,
			role,
			createdAt,
			parentId: this.#lastItemId,
			blocks: new Map(),
			toolCalls: new Map(),
			completed: false,
		};
		this.#openMessages.set(messageId, open);
		if (role === "assistant") this.#openAssistantId = messageId;
		this.#emitParsed({
			kind: "conversation.message.started",
			sessionId: this.#sessionId,
			turnId,
			messageId,
			role,
			createdAt,
		});
	}

	#onMessageUpdate(message: AgentMessage, stream: AssistantMessageEvent): void {
		if (!isAssistant(message)) return;
		if (this.#turnAborted) return;
		const open = this.#openAssistant();
		if (open === undefined || open.completed || this.#completedMessageIds.has(open.messageId)) return;
		if (stream.type === "text_delta" || stream.type === "thinking_delta") {
			const blockType = stream.type === "text_delta" ? "text" : "thinking";
			this.#appendDelta(open, stream.contentIndex, blockType, stream.delta);
			return;
		}
		if (stream.type === "text_start" || stream.type === "thinking_start") {
			const blockType = stream.type === "text_start" ? "text" : "thinking";
			this.#blockId(open.messageId, stream.contentIndex, blockType);
			return;
		}
		if (stream.type === "toolcall_end") {
			this.#recordToolCall(open, stream.toolCall);
		}
	}

	#onMessageEnd(message: AgentMessage): void {
		if (message.role === "user" && "synthetic" in message && message.synthetic) return;
		if (message.role === "user" && "steering" in message && message.steering) return;
		const role = publicRole(message.role);
		if (role === undefined) {
			this.#diagnostic(`ignored session message role ${message.role}`);
			return;
		}
		let open =
			role === "assistant"
				? this.#openAssistant()
				: [...this.#openMessages.values()].find(item => item.role === role && !item.completed);
		if (open === undefined) {
			const alreadyCompleted = [...this.#openMessages.values()].some(
				item => item.role === role && item.completed && item.turnId === this.#turnId,
			);
			if (alreadyCompleted || this.#turnAborted) return;
			this.#onMessageStart(message);
			open =
				role === "assistant"
					? this.#openAssistant()
					: [...this.#openMessages.values()].find(item => item.role === role && !item.completed);
		}
		if (open === undefined) return;
		this.#hydrateFromMessage(open, message);
		this.#completeMessage(open, message, messageErrorOf(message));
		if (isAssistant(message) && message.stopReason === "aborted") this.#turnAborted = true;
		if (role === "assistant") this.#openAssistantId = undefined;
	}

	#onToolStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
		if (this.#turnAborted) return;
		this.#flushPendingDeltas();
		const turnId = this.#ensureTurnId();
		const messageId =
			this.#openAssistantId ??
			this.#lastItemId ??
			this.#options.reserveMessageId({
				role: "assistant",
				createdAt: this.#clock.nowIso(),
			});
		const args = sanitizeToolArguments(event.args);
		const toolName = sanitizePublicText(event.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS).text;
		if (toolName.length === 0) {
			this.#diagnostic("dropped tool start with empty tool name");
			return;
		}
		const started: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.started" }> = {
			kind: "conversation.tool.started",
			sessionId: this.#sessionId,
			turnId,
			messageId,
			toolCallId: event.toolCallId,
			toolName,
			startedAt: this.#clock.nowIso(),
		};
		if (args.arguments !== undefined) started.arguments = args.arguments;
		this.#emitParsed(started);
		const open = this.#openMessages.get(messageId);
		if (open !== undefined) {
			this.#recordToolCall(open, {
				type: "toolCall",
				id: event.toolCallId,
				name: event.toolName,
				arguments: (event.args ?? {}) as Record<string, unknown>,
			});
		}
	}

	#onToolUpdate(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): void {
		if (this.#turnAborted) return;
		if (this.#completedToolIds.has(event.toolCallId)) return;
		this.#flushPendingDeltas();
		const extracted = toolText(event.partialResult);
		const sanitized = sanitizePublicText(extracted.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		const previous = this.#toolOutput.get(event.toolCallId);
		let updateMode: "append" | "replace" = "replace";
		let output = sanitized.text;
		if (previous !== undefined && sanitized.text.startsWith(previous) && sanitized.text.length > previous.length) {
			updateMode = "append";
			output = sanitized.text.slice(previous.length);
		}
		this.#toolOutput.set(event.toolCallId, sanitized.text);
		if (output.length === 0 && !sanitized.truncated) return;
		const updated: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.updated" }> = {
			kind: "conversation.tool.updated",
			sessionId: this.#sessionId,
			turnId: this.#ensureTurnId(),
			toolCallId: event.toolCallId,
			updateMode,
		};
		if (output.length > 0) updated.output = output;
		if (sanitized.truncated) updated.truncated = true;
		this.#emitParsed(updated);
	}

	#onToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		this.#flushPendingDeltas();
		if (this.#completedToolIds.has(event.toolCallId)) return;
		this.#completedToolIds.add(event.toolCallId);
		const extracted = toolText(event.result);
		const isError = event.isError === true || extracted.isError || event.result instanceof Error;
		const sanitized = sanitizePublicText(extracted.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		const toolName = sanitizePublicText(event.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS).text;
		const result: Extract<ConversationContentBlock, { type: "toolResult" }> = {
			type: "toolResult",
			toolCallId: event.toolCallId,
			isError,
		};
		if (toolName.length > 0) result.toolName = toolName;
		if (sanitized.text.length > 0) result.output = sanitized.text;
		if (sanitized.truncated) result.truncated = true;
		if (extracted.data !== undefined) result.data = extracted.data;
		if (extracted.truncated === true) result.truncated = true;
		this.#emitParsed({
			kind: "conversation.tool.completed",
			sessionId: this.#sessionId,
			turnId: this.#ensureTurnId(),
			toolCallId: event.toolCallId,
			result,
			completedAt: this.#clock.nowIso(),
		});
	}

	#onCompactionStart(action: string): void {
		this.#releaseOpenCompaction();
		this.#openCompactionId = this.#reserveCompactionId();
		this.#emitParsed({
			kind: "conversation.compaction.started",
			sessionId: this.#sessionId,
			action,
		});
	}

	#onCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): void {
		this.#flushPendingDeltas();
		const aborted = event.aborted === true;
		const hasPersistedAuthority =
			!aborted && !event.skipped && event.result !== undefined && event.result.summary.length > 0;
		if (!hasPersistedAuthority) {
			this.#releaseOpenCompaction();
			this.#emitParsed({
				kind: "conversation.compaction.completed",
				sessionId: this.#sessionId,
				aborted,
			});
			return;
		}
		const result = event.result;
		if (result === undefined) {
			// Not persisted (safety net); the compiler cannot narrow through
			// the compound hasPersistedAuthority expression above.
			return;
		}
		const summary = sanitizePublicText(result.summary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES);
		const itemId =
			this.#openCompactionId ??
			this.#options.lookupPersistedCompactionId?.({ summary: result.summary }) ??
			this.#reserveCompactionId();
		this.#openCompactionId = undefined;
		const completed: Extract<ConversationRuntimeEvent, { kind: "conversation.compaction.completed" }> = {
			kind: "conversation.compaction.completed",
			sessionId: this.#sessionId,
			aborted: false,
			item: {
				kind: "compaction",
				itemId,
				parentId: this.#lastItemId,
				createdAt: this.#clock.nowIso(),
				summary: summary.text.length > 0 ? summary.text : "compacted",
			},
		};
		if (result.shortSummary !== undefined && completed.item !== undefined) {
			completed.item.shortSummary = sanitizePublicText(
				result.shortSummary,
				CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES,
			).text;
		}
		this.#lastItemId = itemId;
		this.#emitParsed(completed);
	}

	#reserveCompactionId(): string {
		return (
			this.#options.reserveCompactionId?.() ??
			this.#options.allocateEntryId?.() ??
			this.#options.reserveMessageId({
				role: "system",
				createdAt: this.#clock.nowIso(),
			})
		);
	}

	#releaseOpenCompaction(): void {
		if (this.#openCompactionId === undefined) return;
		this.#options.releaseCompactionId?.(this.#openCompactionId);
		this.#openCompactionId = undefined;
	}

	#emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		const sanitized = sanitizePublicText(message, CONVERSATION_LIMITS.NOTICE_MESSAGE_MAX_CHARS);
		if (sanitized.text.length === 0) return;
		const notice: Extract<ConversationRuntimeEvent, { kind: "conversation.notice" }> = {
			kind: "conversation.notice",
			sessionId: this.#sessionId,
			level,
			message: sanitized.text,
		};
		if (source !== undefined && source.length > 0) {
			const cleanSource = sanitizePublicText(source, CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS).text;
			if (cleanSource.length > 0) notice.source = cleanSource;
		}
		this.#emitParsed(notice);
	}

	#appendDelta(open: OpenMessage, contentIndex: number, blockType: "text" | "thinking", delta: string): void {
		if (delta.length === 0) return;
		const blockId = this.#blockId(open.messageId, contentIndex, blockType);
		const existing = open.blocks.get(blockId) ?? { blockType, text: "" };
		existing.text += delta;
		open.blocks.set(blockId, existing);
		const pendingKey = `${open.messageId}:${blockId}`;
		const pending = this.#pending.get(pendingKey);
		if (pending !== undefined) pending.delta += delta;
		else {
			this.#pending.set(pendingKey, {
				sessionId: this.#sessionId,
				turnId: open.turnId,
				messageId: open.messageId,
				blockId,
				blockType,
				delta,
			});
		}
		const threshold = this.#options.coalesceCharThreshold ?? CONVERSATION_LIVE_COALESCE_CHAR_THRESHOLD;
		const buffered = this.#pending.get(pendingKey);
		if (buffered !== undefined && buffered.delta.length >= threshold) this.#flushPendingKey(pendingKey);
		else this.#scheduleCoalesce();
	}

	#hydrateFromMessage(open: OpenMessage, message: AgentMessage): void {
		if (message.role === "user") {
			const text = userText(message);
			if (text.length > 0) {
				const blockId = this.#blockId(open.messageId, 0, "text");
				const sanitized = sanitizePublicText(text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				open.blocks.set(blockId, { blockType: "text", text: sanitized.text });
			}
			return;
		}
		if (!isAssistant(message) || !Array.isArray(message.content)) return;
		message.content.forEach((block, index) => {
			if (block.type === "text") {
				const blockId = this.#blockId(open.messageId, index, "text");
				const sanitized = sanitizePublicText(block.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				open.blocks.set(blockId, { blockType: "text", text: sanitized.text });
				return;
			}
			if (block.type === "thinking") {
				const blockId = this.#blockId(open.messageId, index, "thinking");
				const sanitized = sanitizePublicText(block.thinking, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				open.blocks.set(blockId, { blockType: "thinking", text: sanitized.text });
				return;
			}
			if (block.type === "toolCall") this.#recordToolCall(open, block);
		});
	}

	#contentFromLiveBuffers(open: OpenMessage): ConversationContentBlock[] {
		const content: ConversationContentBlock[] = [];
		for (const block of open.blocks.values()) {
			const sanitized = sanitizePublicText(block.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
			if (sanitized.text.length === 0 && !sanitized.truncated) continue;
			const item: ConversationContentBlock = { type: block.blockType, text: sanitized.text };
			if (sanitized.truncated) item.truncated = true;
			content.push(item);
		}
		for (const toolCall of open.toolCalls.values()) content.push(toolCall);
		return content;
	}

	#contentFromMessage(open: OpenMessage, message: AgentMessage): ConversationContentBlock[] {
		if (message.role === "user") {
			const text = userText(message);
			const sanitized = sanitizePublicText(text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
			if (sanitized.text.length === 0 && !sanitized.truncated) return [];
			const block: ConversationContentBlock = { type: "text", text: sanitized.text };
			if (sanitized.truncated) block.truncated = true;
			return [block];
		}
		if (!isAssistant(message) || !Array.isArray(message.content)) return this.#contentFromLiveBuffers(open);
		const content: ConversationContentBlock[] = [];
		for (const block of message.content) {
			if (block.type === "text") {
				const sanitized = sanitizePublicText(block.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				const item: ConversationContentBlock = { type: "text", text: sanitized.text };
				if (sanitized.truncated) item.truncated = true;
				if (item.text.length > 0 || item.truncated) content.push(item);
				continue;
			}
			if (block.type === "thinking") {
				const sanitized = sanitizePublicText(block.thinking, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				const item: ConversationContentBlock = { type: "thinking", text: sanitized.text };
				if (sanitized.truncated) item.truncated = true;
				if (item.text.length > 0 || item.truncated) content.push(item);
				continue;
			}
			if (block.type === "toolCall") {
				this.#recordToolCall(open, block);
				const recorded = open.toolCalls.get(block.id);
				if (recorded !== undefined) content.push(recorded);
			}
		}
		return content;
	}

	#recordToolCall(open: OpenMessage, toolCall: ToolCall): void {
		const args = sanitizeToolArguments(toolCall.arguments);
		const toolName = sanitizePublicText(toolCall.name, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS).text;
		if (toolName.length === 0) return;
		const block: Extract<ConversationContentBlock, { type: "toolCall" }> = {
			type: "toolCall",
			toolCallId: toolCall.id,
			toolName,
		};
		if (args.arguments !== undefined) block.arguments = args.arguments;
		if (args.truncated) block.truncated = true;
		open.toolCalls.set(toolCall.id, block);
	}

	#completeMessage(open: OpenMessage, message?: AgentMessage, error?: ConversationMessageError): void {
		this.#flushPendingDeltas();
		if (open.completed || this.#completedMessageIds.has(open.messageId)) return;
		open.completed = true;
		this.#completedMessageIds.add(open.messageId);
		const content =
			message !== undefined ? this.#contentFromMessage(open, message) : this.#contentFromLiveBuffers(open);
		const item: ConversationMessageItem = {
			kind: "message",
			itemId: open.messageId,
			parentId: open.parentId,
			createdAt: open.createdAt,
			role: open.role,
			content,
		};
		this.#lastItemId = open.messageId;
		this.#emitParsed({
			kind: "conversation.message.completed",
			sessionId: this.#sessionId,
			turnId: open.turnId,
			messageId: open.messageId,
			item,
			...(error === undefined ? {} : { error }),
		});
	}

	#blockId(messageId: string, contentIndex: number, blockType: "text" | "thinking"): string {
		return `${messageId}:${blockType}:${contentIndex}`;
	}

	#openAssistant(): OpenMessage | undefined {
		if (this.#openAssistantId === undefined) return undefined;
		return this.#openMessages.get(this.#openAssistantId);
	}

	#ensureTurnId(): string {
		if (this.#turnId !== undefined) return this.#turnId;
		this.#onAgentStart();
		return this.#turnId ?? "turn-1";
	}

	#scheduleCoalesce(): void {
		if (this.#coalesceTimer !== undefined) return;
		const delay = this.#options.coalesceIntervalMs ?? CONVERSATION_LIVE_COALESCE_INTERVAL_MS;
		const generation = this.#generation;
		this.#coalesceTimer = this.#clock.setTimer(() => {
			this.#coalesceTimer = undefined;
			if (this.#disposed || generation !== this.#generation) return;
			this.#flushPendingDeltas();
			this.#drain();
		}, delay);
	}

	#clearCoalesceTimer(): void {
		if (this.#coalesceTimer === undefined) return;
		this.#clock.clearTimer(this.#coalesceTimer);
		this.#coalesceTimer = undefined;
	}

	#flushPendingDeltas(): void {
		this.#clearCoalesceTimer();
		for (const key of [...this.#pending.keys()]) this.#flushPendingKey(key);
	}

	#flushPendingKey(key: string): void {
		const pending = this.#pending.get(key);
		if (pending === undefined) return;
		this.#pending.delete(key);
		if (this.#completedMessageIds.has(pending.messageId) || this.#turnAborted) return;
		let remaining = pending.delta;
		const max = CONVERSATION_LIMITS.DELTA_MAX_BYTES;
		while (remaining.length > 0) {
			const chunk = utf8ByteLength(remaining) <= max ? remaining : sanitizePublicText(remaining, max).text;
			if (chunk.length === 0) break;
			this.#emitParsed({
				kind: "conversation.message.delta",
				sessionId: pending.sessionId,
				turnId: pending.turnId,
				messageId: pending.messageId,
				blockId: pending.blockId,
				blockType: pending.blockType,
				delta: chunk,
			});
			if (chunk === remaining) break;
			remaining = remaining.slice(chunk.length);
		}
	}

	#emitParsed(event: ConversationRuntimeEvent): void {
		if (this.#disposed) return;
		if ("runtimeEpoch" in event || "eventSeq" in event || "stateVersion" in event || "occurredAt" in event) {
			this.#diagnostic("refusing inner live event that repeats envelope fields");
			return;
		}
		let parsed: ConversationRuntimeEvent;
		try {
			parsed = parseConversationRuntimeEvent(event);
		} catch (error) {
			this.#diagnostic(error instanceof Error ? error.message : "invalid conversation live event");
			return;
		}
		this.#enqueue(parsed);
		this.#drain();
	}

	#enqueue(event: ConversationRuntimeEvent): void {
		const limit = this.#options.queueLimit ?? CONVERSATION_LIVE_QUEUE_LIMIT;
		if (!isControlEvent(event.kind) && this.#queue.length > 0) {
			const last = this.#queue[this.#queue.length - 1];
			if (
				event.kind === "conversation.message.delta" &&
				last?.kind === "conversation.message.delta" &&
				sameDeltaIdentity(last, event) &&
				utf8ByteLength(last.delta) + utf8ByteLength(event.delta) <= CONVERSATION_LIMITS.DELTA_MAX_BYTES
			) {
				this.#queue[this.#queue.length - 1] = { ...last, delta: last.delta + event.delta };
				return;
			}
			if (
				event.kind === "conversation.tool.updated" &&
				last?.kind === "conversation.tool.updated" &&
				last.toolCallId === event.toolCallId &&
				last.turnId === event.turnId
			) {
				if (event.updateMode === "replace") {
					this.#queue[this.#queue.length - 1] = event;
					return;
				}
				if (last.updateMode === "append" && event.updateMode === "append") {
					this.#queue[this.#queue.length - 1] = {
						...last,
						output: `${last.output ?? ""}${event.output ?? ""}`,
						truncated: last.truncated === true || event.truncated === true ? true : undefined,
					};
					return;
				}
			}
		}
		if (this.#queue.length >= limit) this.#compactQueue();
		if (this.#queue.length >= limit && !isControlEvent(event.kind)) return;
		if (this.#queue.length >= limit && isControlEvent(event.kind)) {
			const dropAt = this.#queue.findIndex(item => !isControlEvent(item.kind));
			if (dropAt >= 0) this.#queue.splice(dropAt, 1);
			else return;
		}
		this.#queue.push(event);
	}

	#compactQueue(): void {
		if (this.#queue.length < 2) return;
		const compacted: ConversationRuntimeEvent[] = [];
		for (const event of this.#queue) {
			const last = compacted[compacted.length - 1];
			if (
				event.kind === "conversation.message.delta" &&
				last?.kind === "conversation.message.delta" &&
				sameDeltaIdentity(last, event) &&
				utf8ByteLength(last.delta) + utf8ByteLength(event.delta) <= CONVERSATION_LIMITS.DELTA_MAX_BYTES
			) {
				compacted[compacted.length - 1] = { ...last, delta: last.delta + event.delta };
			} else compacted.push(event);
		}
		this.#queue.length = 0;
		this.#queue.push(...compacted);
	}

	#drain(): void {
		while (this.#queue.length > 0 && !this.#disposed) {
			const event = this.#queue.shift();
			if (event === undefined) break;
			for (const listener of [...this.#listeners]) {
				try {
					listener(event);
				} catch (error) {
					this.#diagnostic(error instanceof Error ? error.message : "conversation live listener failed");
					logger.warn("Conversation live projector listener threw", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	}

	#clearLiveState(): void {
		this.#clearCoalesceTimer();
		this.#pending.clear();
		this.#queue.length = 0;
		this.#openMessages.clear();
		this.#completedMessageIds.clear();
		this.#completedToolIds.clear();
		this.#toolOutput.clear();
		this.#turnId = undefined;
		this.#turnAborted = false;
		this.#turnCompleted = false;
		this.#lastItemId = null;
		this.#openAssistantId = undefined;
		this.#releaseOpenCompaction();
	}

	#diagnostic(message: string): void {
		this.#options.onDiagnostic?.(message);
		logger.warn("Conversation live projector", { message });
	}
}
