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
import {
	publicToolCallId,
	sanitizeJsonValue,
	sanitizePublicText,
	sanitizeToolArguments,
	utf8ByteLength,
} from "./conversation-sanitizer";
import { isHarnessInjectedUserMessage, publicConversationRole } from "./conversation-visibility";

export const CONVERSATION_LIVE_COALESCE_INTERVAL_MS = 16;
export const CONVERSATION_LIVE_COALESCE_CHAR_THRESHOLD = 64;
/**
 * Unsent tool-output characters that force a flush ahead of the coalesce timer.
 * Larger than the text-delta threshold on purpose: tool output is the bulk
 * producer (build logs, test runs), so the buffer earns its keep by batching,
 * while this bound still keeps one event well under `TEXT_BLOCK_MAX_BYTES`.
 */
export const CONVERSATION_LIVE_TOOL_FLUSH_CHARS = 4 * 1024;
export const CONVERSATION_LIVE_STATE_LIMIT = 256;

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
	toolFlushCharThreshold?: number;
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

/** Buffered tool output: the full text lives in `#toolOutput`, so a pending
 *  entry only records which tool is dirty and whether it hit its cap. */
type PendingToolOutput = {
	turnId: string;
	truncated: boolean;
};

type SentToolOutput = {
	text: string;
	truncated: boolean;
};

type OpenMessage = {
	messageId: string;
	turnId: string;
	role: ConversationRole;
	createdAt: string;
	parentId: string | null;
	blocks: Map<string, { blockType: "text" | "thinking"; text: string; bytes: number; truncated: boolean }>;
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
		const texts: string[] = [];
		let omittedBinary = false;
		for (const block of record.content) {
			if (
				block !== null &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				texts.push((block as { text: string }).text);
			} else if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "image") {
				omittedBinary = true;
			}
		}
		const binary = omittedBinary ? { truncated: true as const } : truncated;
		return { text: texts.join("\n"), isError, ...extra, ...binary };
	}
	if (typeof record.output === "string") return { text: record.output, isError, ...extra, ...truncated };
	if (typeof record.message === "string") return { text: record.message, isError, ...extra, ...truncated };
	return { text: "", isError, ...extra, ...truncated };
}

/**
 * Projects `AgentSession.subscribe()` events into contract live events.
 * Does not wrap StudioEventEnvelope; StateProjector owns eventSeq/stateVersion.
 *
 * Flow control is deliberately synchronous: a parsed event is handed straight to
 * the listeners, so a slow carrier back-pressures the Runtime instead of letting
 * an unbounded queue grow (and instead of a queue that would have to choose
 * which events to drop). The only batching is the coalesce buffer — per text
 * block in `#pending`, per tool in `#toolPending` — which is lossless: the
 * accumulated text lives in `#openMessages` / `#toolOutput` and a flush emits
 * exactly what the client has not been told yet.
 */
export class ConversationLiveProjector {
	readonly #options: ConversationLiveProjectorOptions;
	readonly #clock: ConversationLiveClock;
	readonly #listeners = new Set<LiveListener>();
	readonly #pending = new Map<string, PendingDelta>();
	readonly #toolPending = new Map<string, PendingToolOutput>();
	readonly #openMessages = new Map<string, OpenMessage>();
	readonly #completedMessageIds = new Set<string>();
	readonly #completedToolIds = new Set<string>();
	readonly #toolOutput = new Map<string, string>();
	/** Full tool state the client has actually been sent. `append` is decided
	 *  against this, never against `#toolOutput`, so a coalesced run of partials
	 *  can never assume a prefix the client never received. */
	readonly #toolSent = new Map<string, SentToolOutput>();
	readonly #toolOwners = new Map<string, string>();
	#sessionId: string;
	#runtimeEpoch: number;
	#generation = 0;
	#turnSeq = 0;
	#turnId: string | undefined;
	#continuationPending = false;
	#turnAborted = false;
	#turnCompleted = false;
	#lastItemId: string | null = null;
	#lastAssistantId: string | undefined;
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
		this.#flushPending();
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#clearCoalesceTimer();
		this.#pending.clear();
		this.#toolPending.clear();
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
				this.#onAgentEnd(event);
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
			case "auto_retry_end":
				this.#emitNotice(
					event.success ? "info" : "warning",
					event.success ? "Retry recovered" : "Retry cancelled",
					"retry-end",
				);
				return;
			case "unexpected_stop_retry":
				this.#emitNotice(
					"warning",
					`Assistant stop recovered automatically (${event.attempt}/${event.maxAttempts})`,
					"unexpected-stop",
				);
				return;
			case "notice":
				this.#emitNotice(event.level, event.message, event.source);
				return;
			default:
				return;
		}
	}

	#onAgentStart(): void {
		if (this.#continuationPending && this.#turnId !== undefined) {
			// Unexpected-stop recovery starts another AgentSession run, but it is
			// still the same logical Studio turn. Keep its identity and only allow
			// the next assistant message to open under that existing turn.
			this.#continuationPending = false;
			this.#openAssistantId = undefined;
			return;
		}
		this.#clearTerminalTurnState();
		this.#turnSeq += 1;
		this.#turnId = `turn-${this.#turnSeq}`;
		this.#turnAborted = false;
		this.#turnCompleted = false;
		this.#lastAssistantId = undefined;
		this.#openAssistantId = undefined;
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		this.#flushPending();
		const turnId = this.#ensureTurnId();
		if (event.isTerminal === false) {
			// The Runtime has already scheduled another continuation. Keep the
			// logical turn open instead of exposing a false completed event.
			this.#continuationPending = true;
			this.#openAssistantId = undefined;
			return;
		}
		this.#continuationPending = false;
		if (this.#turnAborted) {
			this.#emitParsed({ kind: "conversation.turn.aborted", sessionId: this.#sessionId, turnId });
		} else if (!this.#turnCompleted) {
			this.#emitParsed({ kind: "conversation.turn.completed", sessionId: this.#sessionId, turnId });
		}
		this.#turnCompleted = true;
		this.#openAssistantId = undefined;
		this.#clearTerminalTurnState();
	}

	#onMessageStart(message: AgentMessage): void {
		if (isHarnessInjectedUserMessage(message)) return;
		const role = publicConversationRole(message.role);
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
		this.#rememberBoundedMap(this.#openMessages, messageId, open);
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
			this.#emitToolStarted({
				messageId: open.messageId,
				turnId: open.turnId,
				toolCallId: stream.toolCall.id,
				toolName: stream.toolCall.name,
				args: stream.toolCall.arguments,
			});
		}
	}

	#onMessageEnd(message: AgentMessage): void {
		if (isHarnessInjectedUserMessage(message)) return;
		const role = publicConversationRole(message.role);
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
		const turnId = this.#ensureTurnId();
		const publicId = publicToolCallId(event.toolCallId, "").id;
		const messageId =
			(publicId.length > 0 ? this.#toolOwners.get(publicId) : undefined) ??
			this.#openAssistantId ??
			this.#lastAssistantId;
		if (messageId === undefined) {
			this.#diagnostic("dropped tool start with no owning assistant message");
			return;
		}
		if (
			!this.#emitToolStarted({
				messageId,
				turnId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			})
		) {
			return;
		}
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
		const toolCallId = publicToolCallId(event.toolCallId, "").id;
		if (toolCallId.length === 0 || this.#completedToolIds.has(toolCallId)) return;
		const extracted = toolText(event.partialResult);
		const sanitized = sanitizePublicText(extracted.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		const truncated = sanitized.truncated || extracted.truncated === true;
		if (sanitized.text.length === 0 && !truncated) return;
		const previous = this.#toolOutput.get(toolCallId);
		const pending = this.#toolPending.get(toolCallId);
		const sent = this.#toolSent.get(toolCallId);
		if (previous === sanitized.text && (!truncated || pending?.truncated === true || sent?.truncated === true)) return;
		this.#rememberBoundedMap(this.#toolOutput, toolCallId, sanitized.text);
		// Buffer rather than emit. A streaming tool (build log, test run) produces
		// far more updates than a frame can show, and a partial result that is not
		// a prefix extension of the last one has to ship the whole retained text —
		// up to TEXT_BLOCK_MAX_BYTES — on every single update. Buffering is
		// lossless because the full text stays in `#toolOutput`; the flush sends
		// whatever the client is still missing.
		this.#rememberBoundedMap(this.#toolPending, toolCallId, {
			turnId: pending?.turnId ?? this.#ensureTurnId(),
			truncated: truncated || pending?.truncated === true,
		});
		const sentText = sent?.text ?? "";
		const unsent = sanitized.text.startsWith(sentText) ? sanitized.text.length - sentText.length : sanitized.text.length;
		const threshold = this.#options.toolFlushCharThreshold ?? CONVERSATION_LIVE_TOOL_FLUSH_CHARS;
		if (unsent >= threshold) this.#flushPendingTool(toolCallId);
		else this.#scheduleCoalesce();
	}

	#onToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		this.#flushPending();
		const toolCallId = publicToolCallId(event.toolCallId, "").id;
		if (toolCallId.length === 0) {
			this.#diagnostic("dropped tool end with empty toolCallId");
			return;
		}
		if (this.#completedToolIds.has(toolCallId)) return;
		this.#rememberCompletedTool(toolCallId);
		const extracted = toolText(event.result);
		const isError = event.isError === true || extracted.isError || event.result instanceof Error;
		const sanitized = sanitizePublicText(extracted.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
		const toolName = sanitizePublicText(event.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS).text;
		const result: Extract<ConversationContentBlock, { type: "toolResult" }> = {
			type: "toolResult",
			toolCallId,
			isError,
		};
		if (toolName.length > 0) result.toolName = toolName;
		if (sanitized.text.length > 0) result.output = sanitized.text;
		if (sanitized.truncated) result.truncated = true;
		if (extracted.data !== undefined) result.data = extracted.data;
		if (extracted.truncated === true) result.truncated = true;
		this.#toolOutput.delete(toolCallId);
		this.#toolSent.delete(toolCallId);
		this.#toolPending.delete(toolCallId);
		this.#toolOwners.delete(toolCallId);
		this.#emitParsed({
			kind: "conversation.tool.completed",
			sessionId: this.#sessionId,
			turnId: this.#ensureTurnId(),
			toolCallId,
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
		this.#flushPending();
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
		const existing = open.blocks.get(blockId) ?? { blockType, text: "", bytes: 0, truncated: false };
		if (existing.truncated) return;
		const remaining = CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES - existing.bytes;
		const accepted = sanitizePublicText(delta, remaining, "");
		existing.text += accepted.text;
		existing.bytes += utf8ByteLength(accepted.text);
		existing.truncated = accepted.truncated;
		open.blocks.set(blockId, existing);
		if (accepted.text.length === 0) return;
		const pendingKey = `${open.messageId}:${blockId}`;
		const pending = this.#pending.get(pendingKey);
		if (pending !== undefined) pending.delta += accepted.text;
		else {
			this.#pending.set(pendingKey, {
				sessionId: this.#sessionId,
				turnId: open.turnId,
				messageId: open.messageId,
				blockId,
				blockType,
				delta: accepted.text,
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
				open.blocks.set(blockId, {
					blockType: "text",
					text: sanitized.text,
					bytes: utf8ByteLength(sanitized.text),
					truncated: sanitized.truncated,
				});
			}
			return;
		}
		if (!isAssistant(message) || !Array.isArray(message.content)) return;
		message.content.forEach((block, index) => {
			if (block.type === "text") {
				const blockId = this.#blockId(open.messageId, index, "text");
				const sanitized = sanitizePublicText(block.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				open.blocks.set(blockId, {
					blockType: "text",
					text: sanitized.text,
					bytes: utf8ByteLength(sanitized.text),
					truncated: sanitized.truncated,
				});
				return;
			}
			if (block.type === "thinking") {
				const blockId = this.#blockId(open.messageId, index, "thinking");
				const sanitized = sanitizePublicText(block.thinking, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
				open.blocks.set(blockId, {
					blockType: "thinking",
					text: sanitized.text,
					bytes: utf8ByteLength(sanitized.text),
					truncated: sanitized.truncated,
				});
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
			if (block.truncated || sanitized.truncated) item.truncated = true;
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
				const recorded = open.toolCalls.get(publicToolCallId(block.id, "").id);
				if (recorded !== undefined) content.push(recorded);
			}
		}
		return content;
	}

	#recordToolCall(open: OpenMessage, toolCall: ToolCall): void {
		const publicId = publicToolCallId(toolCall.id, "");
		if (publicId.id.length === 0) return;
		const args = sanitizeToolArguments(toolCall.arguments);
		const toolName = sanitizePublicText(toolCall.name, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS).text;
		if (toolName.length === 0) return;
		const block: Extract<ConversationContentBlock, { type: "toolCall" }> = {
			type: "toolCall",
			toolCallId: publicId.id,
			toolName,
		};
		if (args.arguments !== undefined) block.arguments = args.arguments;
		if (args.truncated || publicId.truncated) block.truncated = true;
		open.toolCalls.set(publicId.id, block);
		this.#rememberBoundedMap(this.#toolOwners, publicId.id, open.messageId);
		if (open.role === "assistant") this.#lastAssistantId = open.messageId;
	}

	#emitToolStarted(input: {
		messageId: string;
		turnId: string;
		toolCallId: string;
		toolName: string;
		args: unknown;
	}): boolean {
		this.#flushPending();
		const publicId = publicToolCallId(input.toolCallId, "");
		if (publicId.id.length === 0) {
			this.#diagnostic("dropped tool start with empty toolCallId");
			return false;
		}
		this.#completedToolIds.delete(publicId.id);
		const toolName = sanitizePublicText(input.toolName, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS).text;
		if (toolName.length === 0) {
			this.#diagnostic("dropped tool start with empty tool name");
			return false;
		}
		const args = sanitizeToolArguments(input.args);
		const started: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.started" }> = {
			kind: "conversation.tool.started",
			sessionId: this.#sessionId,
			turnId: input.turnId,
			messageId: input.messageId,
			toolCallId: publicId.id,
			toolName,
			startedAt: this.#clock.nowIso(),
		};
		if (args.arguments !== undefined) started.arguments = args.arguments;
		this.#rememberBoundedMap(this.#toolOwners, publicId.id, input.messageId);
		this.#lastAssistantId = input.messageId;
		this.#emitParsed(started);
		return true;
	}

	#completeMessage(open: OpenMessage, message?: AgentMessage, error?: ConversationMessageError): void {
		this.#flushPending();
		if (open.completed || this.#completedMessageIds.has(open.messageId)) return;
		open.completed = true;
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
		if (open.role === "assistant") this.#lastAssistantId = open.messageId;
		open.blocks.clear();
		open.toolCalls.clear();
		this.#rememberCompletedMessage(open);
		this.#emitParsed({
			kind: "conversation.message.completed",
			sessionId: this.#sessionId,
			turnId: open.turnId,
			messageId: open.messageId,
			item,
			...(error === undefined ? {} : { error }),
		});
	}

	#rememberCompletedMessage(open: OpenMessage): void {
		this.#completedMessageIds.delete(open.messageId);
		this.#completedMessageIds.add(open.messageId);
		while (this.#completedMessageIds.size > CONVERSATION_LIVE_STATE_LIMIT) {
			const oldest = this.#completedMessageIds.values().next().value as string | undefined;
			if (oldest === undefined) break;
			this.#completedMessageIds.delete(oldest);
			const stale = this.#openMessages.get(oldest);
			if (stale?.completed) this.#openMessages.delete(oldest);
		}
	}

	#rememberCompletedTool(toolCallId: string): void {
		this.#completedToolIds.delete(toolCallId);
		this.#completedToolIds.add(toolCallId);
		while (this.#completedToolIds.size > CONVERSATION_LIVE_STATE_LIMIT) {
			const oldest = this.#completedToolIds.values().next().value as string | undefined;
			if (oldest === undefined) break;
			this.#completedToolIds.delete(oldest);
		}
	}

	#rememberBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
		map.delete(key);
		map.set(key, value);
		while (map.size > CONVERSATION_LIVE_STATE_LIMIT) {
			const oldest = map.keys().next().value as K | undefined;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}

	#clearTerminalTurnState(): void {
		this.#clearCoalesceTimer();
		if (this.#turnId !== undefined) {
			for (const [messageId, message] of this.#openMessages) {
				if (message.turnId === this.#turnId && !message.completed) this.#openMessages.delete(messageId);
			}
		}
		this.#pending.clear();
		this.#toolPending.clear();
		this.#toolOutput.clear();
		this.#toolSent.clear();
		this.#toolOwners.clear();
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
			this.#flushPending();
		}, delay);
	}

	#clearCoalesceTimer(): void {
		if (this.#coalesceTimer === undefined) return;
		this.#clock.clearTimer(this.#coalesceTimer);
		this.#coalesceTimer = undefined;
	}

	/** Everything buffered, in wire order: text deltas first, then tool output. */
	#flushPending(): void {
		this.#flushPendingDeltas();
		this.#flushPendingTools();
	}

	#flushPendingDeltas(): void {
		this.#clearCoalesceTimer();
		for (const key of [...this.#pending.keys()]) this.#flushPendingKey(key);
	}

	#flushPendingTools(): void {
		for (const toolCallId of [...this.#toolPending.keys()]) this.#flushPendingTool(toolCallId);
	}

	/**
	 * Emit the part of one tool's retained output the client has not been sent.
	 *
	 * `append` is decided against `#toolSent` (what was emitted), not against the
	 * previous host-side snapshot, so a coalesced run of partials — or one that
	 * rewrote its text — always resolves to a payload the client can apply.
	 */
	#flushPendingTool(toolCallId: string): void {
		const pending = this.#toolPending.get(toolCallId);
		if (pending === undefined) return;
		this.#toolPending.delete(toolCallId);
		if (this.#completedToolIds.has(toolCallId) || this.#turnAborted) return;
		const full = this.#toolOutput.get(toolCallId) ?? "";
		const sent = this.#toolSent.get(toolCallId);
		const textChanged = sent === undefined || full !== sent.text;
		const append = textChanged && sent !== undefined && full.startsWith(sent.text) && full.length > sent.text.length;
		const output = !textChanged ? "" : append ? full.slice(sent.text.length) : full;
		const truncatedChanged = pending.truncated && sent?.truncated !== true;
		if (output.length === 0 && !truncatedChanged) return;
		const updated: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.updated" }> = {
			kind: "conversation.tool.updated",
			sessionId: this.#sessionId,
			turnId: pending.turnId,
			toolCallId,
			updateMode: append ? "append" : "replace",
		};
		if (output.length > 0) updated.output = output;
		if (truncatedChanged) updated.truncated = true;
		this.#rememberBoundedMap(this.#toolSent, toolCallId, {
			text: full,
			truncated: sent?.truncated === true || pending.truncated,
		});
		this.#emitParsed(updated);
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
		this.#deliver(parsed);
	}

	#deliver(event: ConversationRuntimeEvent): void {
		if (this.#disposed) return;
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

	#clearLiveState(): void {
		this.#clearCoalesceTimer();
		this.#pending.clear();
		this.#toolPending.clear();
		this.#openMessages.clear();
		this.#completedMessageIds.clear();
		this.#completedToolIds.clear();
		this.#toolOutput.clear();
		this.#toolSent.clear();
		this.#toolOwners.clear();
		this.#turnId = undefined;
		this.#continuationPending = false;
		this.#turnAborted = false;
		this.#turnCompleted = false;
		this.#lastItemId = null;
		this.#lastAssistantId = undefined;
		this.#openAssistantId = undefined;
		this.#releaseOpenCompaction();
	}

	#diagnostic(message: string): void {
		this.#options.onDiagnostic?.(message);
		logger.warn("Conversation live projector", { message });
	}
}
