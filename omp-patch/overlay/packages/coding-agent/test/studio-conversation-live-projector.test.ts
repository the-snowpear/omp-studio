import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, UserMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import {
	CONVERSATION_LIMITS,
	type ConversationRuntimeEvent,
	parseConversationRuntimeEvent,
} from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";
import {
	CONVERSATION_LIVE_COALESCE_CHAR_THRESHOLD,
	type ConversationLiveBindTarget,
	ConversationLiveProjector,
} from "@oh-my-pi/pi-coding-agent/studio/services/conversation-live-projector";
import {
	sanitizeJsonValue,
	sanitizeToolArguments,
} from "@oh-my-pi/pi-coding-agent/studio/services/conversation-sanitizer";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const TS = Date.UTC(2026, 7, 15, 0, 0, 0);

class AgentSessionEventDouble implements ConversationLiveBindTarget {
	readonly #listeners: Array<(event: AgentSessionEvent) => void> = [];

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index >= 0) this.#listeners.splice(index, 1);
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	get listenerCount(): number {
		return this.#listeners.length;
	}
}

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: TS,
		...extra,
	};
}

function user(text: string, extra: Partial<UserMessage> = {}): UserMessage {
	return { role: "user", content: text, timestamp: TS, ...extra };
}

function update(
	message: AssistantMessage,
	stream: AssistantMessageEvent,
): Extract<AgentSessionEvent, { type: "message_update" }> {
	return { type: "message_update", message, assistantMessageEvent: stream };
}

function createProjector(sessionId = "session-1", runtimeEpoch = 1) {
	let nextId = 1;
	const events: ConversationRuntimeEvent[] = [];
	const diagnostics: string[] = [];
	const projector = new ConversationLiveProjector({
		sessionId,
		runtimeEpoch,
		reserveMessageId: () => `msg-${nextId++}`,
		coalesceIntervalMs: 60_000,
		coalesceCharThreshold: CONVERSATION_LIVE_COALESCE_CHAR_THRESHOLD,
		onDiagnostic: message => diagnostics.push(message),
	});
	projector.onEvent(event => events.push(event));
	return { projector, events, diagnostics, ids: () => nextId };
}

function kinds(events: ConversationRuntimeEvent[]): string[] {
	return events.map(event => event.kind);
}

function deltas(events: ConversationRuntimeEvent[], blockType?: "text" | "thinking"): string {
	return events
		.filter(
			(event): event is Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }> =>
				event.kind === "conversation.message.delta" && (blockType === undefined || event.blockType === blockType),
		)
		.map(event => event.delta)
		.join("");
}

function wireAll(events: ConversationRuntimeEvent[]): ConversationRuntimeEvent[] {
	return events.map(event => parseConversationRuntimeEvent(JSON.parse(JSON.stringify(event))));
}

describe("conversation sanitizer", () => {
	test("redacts secret keys, drops cycles, and truncates oversized JSON", () => {
		expect(sanitizeToolArguments({ apiKey: "sk-secret", path: "ok" }).arguments).toEqual({
			apiKey: "[redacted]",
			path: "ok",
		});
		expect(sanitizeToolArguments({ providerPayload: { token: "abc" } }).truncated).toBe(true);
		expect(sanitizeJsonValue({ tokens: 12_600, requests: 4, token: "sk-secret" }).value).toEqual({
			tokens: 12_600,
			requests: 4,
			token: "[redacted]",
		});
		const cyclic: Record<string, unknown> = { keep: true };
		cyclic.self = cyclic;
		const cyclicResult = sanitizeJsonValue(cyclic);
		expect(cyclicResult.truncated).toBe(true);
		expect(() => JSON.stringify(cyclicResult.value)).not.toThrow();
		const huge = "a".repeat(CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES + 8);
		const oversized = sanitizeJsonValue(huge);
		expect(oversized.truncated).toBe(true);
		expect(JSON.stringify(oversized.value ?? "").length).toBeLessThanOrEqual(
			CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES,
		);
	});
});

describe("ConversationLiveProjector", () => {
	test("projects assistant start, coalesced deltas, then a completed item with matching messageId", () => {
		const { projector, events } = createProjector();
		const message = assistant([{ type: "text", text: "Hello world" }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project(update(message, { type: "text_start", contentIndex: 0, partial: message }));
		for (const piece of ["Hel", "lo", " ", "wo", "rld"]) {
			projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: piece, partial: message }));
		}
		projector.project({ type: "message_end", message });
		expect(kinds(events)).toContain("conversation.message.started");
		expect(kinds(events)).toContain("conversation.message.delta");
		expect(kinds(events)[kinds(events).length - 1]).toBe("conversation.message.completed");
		expect(deltas(events, "text")).toBe("Hello world");
		const started = events.find(event => event.kind === "conversation.message.started");
		const completed = events.find(event => event.kind === "conversation.message.completed");
		expect(started?.kind === "conversation.message.started" && started.messageId).toBe("msg-1");
		expect(completed?.kind === "conversation.message.completed" && completed.messageId).toBe("msg-1");
		expect(completed?.kind === "conversation.message.completed" && completed.item.itemId).toBe("msg-1");
		expect(completed?.kind === "conversation.message.completed" && completed.item.content).toEqual([
			{ type: "text", text: "Hello world" },
		]);
		expect(wireAll(events).map(event => event.kind as string)).toEqual(kinds(events));
	});

	test("keeps thinking and text on separate blocks", () => {
		const { projector, events } = createProjector();
		const message = assistant([
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "done" },
		]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project(update(message, { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: message }));
		projector.project(update(message, { type: "text_delta", contentIndex: 1, delta: "done", partial: message }));
		projector.project({ type: "message_end", message });
		expect(deltas(events, "thinking")).toBe("plan");
		expect(deltas(events, "text")).toBe("done");
		const completed = events.find(event => event.kind === "conversation.message.completed");
		expect(completed?.kind === "conversation.message.completed" && completed.item.content).toEqual([
			{ type: "thinking", text: "plan" },
			{ type: "text", text: "done" },
		]);
		const thinkingDelta = events.find(
			event => event.kind === "conversation.message.delta" && event.blockType === "thinking",
		);
		const textDelta = events.find(event => event.kind === "conversation.message.delta" && event.blockType === "text");
		expect(thinkingDelta?.kind === "conversation.message.delta" && thinkingDelta.blockId).not.toBe(
			textDelta?.kind === "conversation.message.delta" ? textDelta.blockId : "",
		);
	});

	test("associates two tool calls independently", () => {
		const { projector, events } = createProjector();
		const message = assistant([
			{ type: "toolCall", id: "call-1", name: "Read", arguments: { path: "a.json" } },
			{ type: "toolCall", id: "call-2", name: "Bash", arguments: { command: "ls" } },
		]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "Read",
			args: { path: "a.json" },
		});
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "Read",
			result: { content: [{ type: "text", text: "{}" }], isError: false },
			isError: false,
		});
		projector.project({
			type: "tool_execution_start",
			toolCallId: "call-2",
			toolName: "Bash",
			args: { command: "ls" },
		});
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "Bash",
			result: { content: [{ type: "text", text: "ok" }], isError: false },
			isError: false,
		});
		const started = events.filter(event => event.kind === "conversation.tool.started");
		const completed = events.filter(event => event.kind === "conversation.tool.completed");
		expect(started.map(event => event.kind === "conversation.tool.started" && event.toolCallId)).toEqual([
			"call-1",
			"call-2",
		]);
		expect(completed.map(event => event.kind === "conversation.tool.completed" && event.toolCallId)).toEqual([
			"call-1",
			"call-2",
		]);
		expect(started[0]?.kind === "conversation.tool.started" && started[0].messageId).toBe("msg-1");
		expect(started[1]?.kind === "conversation.tool.started" && started[1].messageId).toBe("msg-1");
	});

	test("uses append when partial output extends the previous snapshot and replace otherwise", () => {
		const { projector, events } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: assistant([]) });
		projector.project({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: {} });
		projector.project({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "Bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "abc" }] },
		});
		projector.project({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "Bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "abcdef" }] },
		});
		projector.project({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "Bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "xyz" }] },
		});
		const updates = events.filter(event => event.kind === "conversation.tool.updated");
		expect(updates).toEqual([
			{
				kind: "conversation.tool.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				toolCallId: "call-1",
				updateMode: "replace",
				output: "abc",
			},
			{
				kind: "conversation.tool.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				toolCallId: "call-1",
				updateMode: "append",
				output: "def",
			},
			{
				kind: "conversation.tool.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				toolCallId: "call-1",
				updateMode: "replace",
				output: "xyz",
			},
		]);
	});

	test("marks tool errors, truncates huge stdout, and survives cyclic or binary arguments", () => {
		const { projector, events, diagnostics } = createProjector();
		const cyclic: Record<string, unknown> = { path: "pkg.json" };
		cyclic.self = cyclic;
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: assistant([]) });
		projector.project({
			type: "tool_execution_start",
			toolCallId: "call-err",
			toolName: "Bash",
			args: cyclic,
		});
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-err",
			toolName: "Bash",
			result: new Error("boom"),
			isError: true,
		});
		projector.project({
			type: "tool_execution_start",
			toolCallId: "call-huge",
			toolName: "Bash",
			args: { data: new Uint8Array([1, 2, 3]) },
		});
		const huge = "x".repeat(CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES + 32);
		projector.project({
			type: "tool_execution_update",
			toolCallId: "call-huge",
			toolName: "Bash",
			args: {},
			partialResult: { content: [{ type: "text", text: huge }] },
		});
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-huge",
			toolName: "Bash",
			result: { content: [{ type: "text", text: huge }], isError: false },
			isError: false,
		});
		const errorDone = events.find(
			event => event.kind === "conversation.tool.completed" && event.toolCallId === "call-err",
		);
		expect(errorDone?.kind === "conversation.tool.completed" && errorDone.result.isError).toBe(true);
		expect(errorDone?.kind === "conversation.tool.completed" && errorDone.result.output).toBe("boom");
		expect(JSON.stringify(errorDone)).not.toMatch(/\s+at\s+/);
		const hugeUpdate = events.find(
			event => event.kind === "conversation.tool.updated" && event.toolCallId === "call-huge",
		);
		expect(hugeUpdate?.kind === "conversation.tool.updated" && hugeUpdate.truncated).toBe(true);
		const hugeDone = events.find(
			event => event.kind === "conversation.tool.completed" && event.toolCallId === "call-huge",
		);
		expect(hugeDone?.kind === "conversation.tool.completed" && hugeDone.result.truncated).toBe(true);
		expect(wireAll(events).length).toBe(events.length);
		expect(diagnostics.length).toBeGreaterThanOrEqual(0);
	});

	test("keeps sanitized tool details on the completed result", () => {
		const { projector, events } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: assistant([]) });
		projector.project({ type: "tool_execution_start", toolCallId: "call-details", toolName: "Read", args: {} });
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-details",
			toolName: "Read",
			result: {
				content: [{ type: "text", text: "body" }],
				isError: false,
				details: { lines: 2, preview: ["a", "b"], token: "redact-me" },
			},
			isError: false,
		});
		const completed = events.find(event => event.kind === "conversation.tool.completed");
		expect(completed?.kind === "conversation.tool.completed" && completed.result.data).toEqual({
			lines: 2,
			preview: ["a", "b"],
			token: "[redacted]",
		});
		expect(JSON.stringify(completed)).not.toContain("redact-me");
	});

	test("flushes remaining deltas before message.completed", () => {
		const { projector, events } = createProjector();
		const message = assistant([{ type: "text", text: "ab" }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: "a", partial: message }));
		projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: "b", partial: message }));
		projector.project({ type: "message_end", message });
		const completedAt = kinds(events).lastIndexOf("conversation.message.completed");
		const lastDeltaAt = kinds(events).lastIndexOf("conversation.message.delta");
		expect(lastDeltaAt).toBeGreaterThanOrEqual(0);
		expect(lastDeltaAt).toBeLessThan(completedAt);
		expect(deltas(events)).toBe("ab");
	});

	test("duplicate completed is idempotent and late deltas after completed are dropped", () => {
		const { projector, events } = createProjector();
		const message = assistant([{ type: "text", text: "Hi" }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: "Hi", partial: message }));
		projector.project({ type: "message_end", message });
		projector.project({ type: "message_end", message });
		projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: "LATE", partial: message }));
		expect(events.filter(event => event.kind === "conversation.message.completed")).toHaveLength(1);
		expect(deltas(events)).toBe("Hi");
	});

	test("terminal agent_end rejects late message, tool, and compaction events until the next agent_start", () => {
		const { projector, events } = createProjector();
		const completed = assistant([{ type: "text", text: "done" }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: completed });
		projector.project({ type: "message_end", message: completed });
		projector.project({ type: "agent_end", messages: [completed] });
		const terminalEvents = [...events];

		const late = assistant([{ type: "text", text: "late" }], { timestamp: TS + 1 });
		projector.project({ type: "message_start", message: late });
		projector.project(update(late, { type: "text_delta", contentIndex: 0, delta: "late", partial: late }));
		projector.project({ type: "message_end", message: late });
		projector.project({ type: "tool_execution_start", toolCallId: "late-tool", toolName: "Read", args: {} });
		projector.project({
			type: "tool_execution_update",
			toolCallId: "late-tool",
			toolName: "Read",
			args: {},
			partialResult: { content: [{ type: "text", text: "late" }] },
		});
		projector.project({
			type: "tool_execution_end",
			toolCallId: "late-tool",
			toolName: "Read",
			result: { content: [{ type: "text", text: "late" }], isError: false },
			isError: false,
		});
		projector.project({ type: "auto_compaction_start", reason: "idle", action: "shake" });
		projector.project({
			type: "auto_compaction_end",
			action: "shake",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		expect(events).toEqual(terminalEvents);

		const next = assistant([{ type: "text", text: "next" }], { timestamp: TS + 2 });
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: next });
		projector.project({ type: "message_end", message: next });
		projector.project({ type: "agent_end", messages: [next] });
		expect(events.filter(event => event.kind === "conversation.turn.completed")).toHaveLength(2);
		expect(
			events.find(
				(event): event is Extract<ConversationRuntimeEvent, { kind: "conversation.message.completed" }> =>
					event.kind === "conversation.message.completed" &&
					event.item.content.some(block => block.type === "text" && block.text === "next"),
			)?.turnId,
		).toBe("turn-2");
	});

	test("abort keeps received content and drops later deltas for that turn", () => {
		const { projector, events } = createProjector();
		const streaming = assistant([{ type: "text", text: "Hel" }], { stopReason: "aborted" });
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: streaming });
		projector.project(update(streaming, { type: "text_delta", contentIndex: 0, delta: "Hel", partial: streaming }));
		projector.project({ type: "message_end", message: streaming });
		projector.project(update(streaming, { type: "text_delta", contentIndex: 0, delta: "lo", partial: streaming }));
		projector.project({ type: "agent_end", messages: [streaming] });
		expect(deltas(events)).toBe("Hel");
		expect(kinds(events)).toContain("conversation.turn.aborted");
		expect(kinds(events)).not.toContain("conversation.turn.completed");
		expect(events.some(event => event.kind === "conversation.message.delta" && event.delta === "lo")).toBe(false);
	});

	test("provider error is carried on the completed message and strips the raw-http-request pointer", () => {
		const { projector, events } = createProjector();
		const message = assistant([], {
			stopReason: "error",
			errorMessage:
				"400 Model is not supported by composite groups\nraw-http-request=/home/u/.omp/logs/http-400-requests/x.json",
			errorStatus: 400,
			provider: "sub2api-go",
			model: "mimo-v2.5",
		});
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project({ type: "message_end", message });
		projector.project({ type: "agent_end", messages: [message] });
		const completed = events.find(event => event.kind === "conversation.message.completed");
		expect(completed).toEqual({
			kind: "conversation.message.completed",
			sessionId: "session-1",
			turnId: expect.any(String),
			messageId: expect.any(String),
			item: {
				kind: "message",
				itemId: expect.any(String),
				parentId: null,
				createdAt: "2026-08-15T00:00:00.000Z",
				role: "assistant",
				content: [],
			},
			error: {
				message: "400 Model is not supported by composite groups",
				status: 400,
				provider: "sub2api-go",
				model: "mimo-v2.5",
			},
		});
		expect(JSON.stringify(events)).not.toContain("raw-http-request");
		expect(JSON.stringify(events)).not.toContain("/home/");
	});

	test("projects compaction start and completed without preserveData", () => {
		const { projector, events } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		projector.project({
			type: "auto_compaction_end",
			action: "context-full",
			result: {
				summary: "kept recent turns",
				shortSummary: "recent",
				firstKeptEntryId: "leaf-1",
				tokensBefore: 9,
				preserveData: { secret: "nope" },
				details: { providerPayload: { token: "abc" } },
			},
			aborted: false,
			willRetry: false,
		});
		const started = events.find(event => event.kind === "conversation.compaction.started");
		const completed = events.find(event => event.kind === "conversation.compaction.completed");
		expect(started).toEqual({
			kind: "conversation.compaction.started",
			sessionId: "session-1",
			action: "context-full",
		});
		expect(completed?.kind === "conversation.compaction.completed" && completed.aborted).toBe(false);
		expect(completed?.kind === "conversation.compaction.completed" && completed.item?.summary).toBe(
			"kept recent turns",
		);
		expect(JSON.stringify(completed)).not.toContain("preserveData");
		expect(JSON.stringify(completed)).not.toContain("providerPayload");
	});

	test("aborted or skipped compaction does not emit an authoritative item", () => {
		const { projector, events } = createProjector();
		projector.project({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		projector.project({
			type: "auto_compaction_end",
			action: "context-full",
			result: {
				summary: "should not become public",
				firstKeptEntryId: "leaf-1",
				tokensBefore: 3,
			},
			aborted: true,
			willRetry: false,
		});
		const aborted = events.find(event => event.kind === "conversation.compaction.completed");
		expect(aborted).toEqual({
			kind: "conversation.compaction.completed",
			sessionId: "session-1",
			aborted: true,
		});

		events.length = 0;
		projector.project({ type: "auto_compaction_start", reason: "idle", action: "shake" });
		projector.project({
			type: "auto_compaction_end",
			action: "shake",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		const skipped = events.find(event => event.kind === "conversation.compaction.completed");
		expect(skipped).toEqual({
			kind: "conversation.compaction.completed",
			sessionId: "session-1",
			aborted: false,
		});
	});

	test("rebind drops the previous session subscription and late native events", () => {
		const { projector, events } = createProjector();
		const first = new AgentSessionEventDouble();
		const second = new AgentSessionEventDouble();
		const message = assistant([{ type: "text", text: "old" }]);
		projector.bind(first);
		first.emit({ type: "agent_start" });
		first.emit({ type: "message_start", message });
		projector.rebind(second, { sessionId: "session-2", runtimeEpoch: 2 });
		first.emit(update(message, { type: "text_delta", contentIndex: 0, delta: "STALE", partial: message }));
		const fresh = assistant([{ type: "text", text: "new" }]);
		second.emit({ type: "agent_start" });
		second.emit({ type: "message_start", message: fresh });
		expect(events.some(event => event.kind === "conversation.message.delta" && event.delta === "STALE")).toBe(false);
		expect(
			events.filter(event => event.kind === "conversation.message.started").map(event => event.sessionId),
		).toEqual(["session-1", "session-2"]);
		expect(first.listenerCount).toBe(0);
		expect(second.listenerCount).toBe(1);
	});

	test("coalesces 10k tiny deltas into a bounded event count without losing text", () => {
		const { projector, events } = createProjector();
		const message = assistant([{ type: "text", text: "x".repeat(10_000) }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		for (let index = 0; index < 10_000; index++) {
			projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: "x", partial: message }));
		}
		projector.project({ type: "message_end", message });
		const deltaEvents = events.filter(event => event.kind === "conversation.message.delta");
		expect(deltaEvents.length).toBeLessThan(10_000 / 8);
		expect(deltaEvents.length).toBeGreaterThan(0);
		expect(deltas(events, "text")).toBe("x".repeat(10_000));
		expect(events.length).toBeLessThan(deltaEvents.length + 8);
	});

	test("caps cumulative live deltas and the active fallback buffer, then marks it truncated", () => {
		const { projector, events } = createProjector();
		const message = assistant([]);
		const oversized = "界".repeat(100_000);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project(update(message, { type: "text_delta", contentIndex: 0, delta: oversized, partial: message }));
		projector.project({ type: "message_end", message: { ...message, content: undefined as never } });
		const completed = events.find(
			(event): event is Extract<ConversationRuntimeEvent, { kind: "conversation.message.completed" }> =>
				event.kind === "conversation.message.completed",
		);
		const block = completed?.item.content.find(item => item.type === "text");
		expect(block?.type).toBe("text");
		if (block?.type !== "text") throw new Error("expected a text block");
		const liveText = deltas(events, "text");
		expect(new TextEncoder().encode(liveText).byteLength).toBeLessThanOrEqual(
			CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES,
		);
		expect(liveText).toBe(block.text);
		expect(new TextEncoder().encode(block.text).byteLength).toBeLessThanOrEqual(
			CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES,
		);
		expect(block.truncated).toBe(true);
	});

	test("omits providerPayload and secret keys from serialized live frames", () => {
		const { projector, events } = createProjector();
		const message = assistant([{ type: "text", text: "ok" }], {
			providerPayload: { type: "openaiResponsesHistory", items: [{ encrypted: "SECRET_TOKEN_VALUE" }] },
		});
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "Read",
			args: { authorization: "Bearer secret", path: "package.json" },
		});
		projector.project({ type: "message_end", message });
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("providerPayload");
		expect(serialized).not.toContain("SECRET_TOKEN_VALUE");
		expect(serialized).not.toContain("Bearer secret");
		expect(serialized).toContain("[redacted]");
		for (const event of events) {
			expect("occurredAt" in event).toBe(false);
			expect("runtimeEpoch" in event).toBe(false);
			expect("eventSeq" in event).toBe(false);
			expect("stateVersion" in event).toBe(false);
		}
	});

	test("a throwing consumer does not stop later live events", () => {
		const { projector, events } = createProjector();
		let sawCompleted = false;
		projector.onEvent(event => {
			if (event.kind === "conversation.message.started") throw new Error("consumer failed");
			if (event.kind === "conversation.message.completed") sawCompleted = true;
		});
		const message = assistant([{ type: "text", text: "ok" }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project({ type: "message_end", message });
		expect(events.some(event => event.kind === "conversation.message.completed")).toBe(true);
		expect(sawCompleted).toBe(true);
	});

	test("retry becomes a safe notice and unknown custom messages are ignored", () => {
		const { projector, events, diagnostics } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 10,
			errorMessage: "provider exploded with apiKey=sk-live",
		});
		projector.project({
			type: "message_start",
			message: { role: "custom", customType: "hook", content: "nope", timestamp: TS } as AgentMessage,
		});
		const notice = events.find(event => event.kind === "conversation.notice");
		expect(notice).toEqual({
			kind: "conversation.notice",
			sessionId: "session-1",
			level: "warning",
			message: "Retry 2/5",
			source: "retry",
		});
		expect(JSON.stringify(events)).not.toContain("sk-live");
		expect(events.some(event => event.kind === "conversation.message.started")).toBe(false);
		expect(diagnostics.some(item => item.includes("custom"))).toBe(true);
	});

	test("developer/synthetic/agent-steer rows stay hidden; user-attributed steers become public rows", () => {
		const { projector, events, diagnostics } = createProjector();
		projector.project({ type: "agent_start" });
		const developer = {
			role: "developer",
			content: [{ type: "text", text: "<system-reminder>todo still open</system-reminder>" }],
			attribution: "agent",
			timestamp: TS,
		} as AgentMessage;
		const synthetic = user("<instruction>MUST read local://plan.md</instruction>", { synthetic: true });
		const agentSteer = user("peer asks the run to pivot", { steering: true, attribution: "agent" });
		const userSteer = user("steer the turn", { steering: true, attribution: "user" });
		const visible = user("hello");
		for (const message of [developer, synthetic, agentSteer, userSteer, visible]) {
			projector.project({ type: "message_start", message });
			projector.project({ type: "message_end", message });
		}
		expect(events.filter(event => event.kind === "conversation.message.started")).toEqual([
			{
				kind: "conversation.message.started",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-1",
				role: "user",
				createdAt: new Date(TS).toISOString(),
			},
			{
				kind: "conversation.message.started",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-2",
				role: "user",
				createdAt: new Date(TS).toISOString(),
			},
		]);
		expect(JSON.stringify(events)).not.toContain("system-reminder");
		expect(JSON.stringify(events)).not.toContain("<instruction>");
		expect(JSON.stringify(events)).not.toContain("peer asks the run to pivot");
		expect(JSON.stringify(events)).toContain("steer the turn");
		expect(diagnostics.some(item => item.includes("developer"))).toBe(true);
	});

	test("auto_retry_end becomes a retry-end notice so the UI can drop Retry N/M", () => {
		const { projector, events } = createProjector();
		projector.project({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "Retry cancelled",
		});
		expect(events).toEqual([
			{
				kind: "conversation.notice",
				sessionId: "session-1",
				level: "warning",
				message: "Retry cancelled",
				source: "retry-end",
			},
		]);
	});

	test("non-terminal agent_end keeps the turn open and unexpected-stop recovery is structured", () => {
		const session = new AgentSessionEventDouble();
		const { projector, events } = createProjector();
		projector.bind(session);
		const first = assistant([{ type: "text", text: "partial" }]);
		const continuation = assistant([{ type: "text", text: "recovered" }], { timestamp: TS + 1 });
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_start", message: first });
		session.emit({ type: "message_end", message: first });
		session.emit({ type: "agent_end", messages: [], isTerminal: false });
		expect(events.some(event => event.kind === "conversation.turn.completed")).toBe(false);
		session.emit({ type: "unexpected_stop_retry", attempt: 1, maxAttempts: 3 });
		const notice = events.find(event => event.kind === "conversation.notice");
		expect(notice).toMatchObject({
			kind: "conversation.notice",
			level: "warning",
			message: "Assistant stop recovered automatically (1/3)",
			source: "unexpected-stop",
		});
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_start", message: continuation });
		session.emit({ type: "message_end", message: continuation });
		session.emit({ type: "agent_end", messages: [] });
		const messageTurnIds = events
			.filter(
				(event): event is Extract<ConversationRuntimeEvent, { kind: "conversation.message.completed" }> =>
					event.kind === "conversation.message.completed",
			)
			.map(event => event.turnId);
		const completedTurn = events.find(event => event.kind === "conversation.turn.completed");
		expect(messageTurnIds).toEqual(["turn-1", "turn-1"]);
		expect(completedTurn?.kind === "conversation.turn.completed" && completedTurn.turnId).toBe("turn-1");
		expect(events.filter(event => event.kind === "conversation.turn.completed")).toHaveLength(1);
	});

	test("AgentSession subscribe double replays a native event fixture into contract events", () => {
		const session = new AgentSessionEventDouble();
		const { projector, events } = createProjector();
		projector.bind(session);
		const userMessage = user("read package.json");
		const assistantMessage = assistant([{ type: "text", text: "It is a workspace." }]);
		const fixture: AgentSessionEvent[] = [
			{ type: "agent_start" },
			{ type: "message_start", message: userMessage },
			{ type: "message_end", message: userMessage },
			{ type: "message_start", message: assistantMessage },
			update(assistantMessage, { type: "text_start", contentIndex: 0, partial: assistantMessage }),
			update(assistantMessage, { type: "text_delta", contentIndex: 0, delta: "It is ", partial: assistantMessage }),
			update(assistantMessage, {
				type: "text_delta",
				contentIndex: 0,
				delta: "a workspace.",
				partial: assistantMessage,
			}),
			{ type: "message_end", message: assistantMessage },
			{ type: "agent_end", messages: [userMessage, assistantMessage] },
		];
		for (const event of fixture) session.emit(event);
		expect(kinds(events)).toEqual([
			"conversation.message.started",
			"conversation.message.completed",
			"conversation.message.started",
			"conversation.message.delta",
			"conversation.message.completed",
			"conversation.turn.completed",
		]);
		expect(deltas(events)).toBe("It is a workspace.");
		const userCompleted = events.find(
			event => event.kind === "conversation.message.completed" && event.item.role === "user",
		);
		const assistantCompleted = events.find(
			event => event.kind === "conversation.message.completed" && event.item.role === "assistant",
		);
		expect(userCompleted?.kind === "conversation.message.completed" && userCompleted.messageId).toBe(
			userCompleted?.kind === "conversation.message.completed" ? userCompleted.item.itemId : "",
		);
		expect(assistantCompleted?.kind === "conversation.message.completed" && assistantCompleted.item.content).toEqual([
			{ type: "text", text: "It is a workspace." },
		]);
		expect(wireAll(events).map(event => event.kind as string)).toEqual(kinds(events));
		projector.dispose();
		session.emit(
			update(assistantMessage, { type: "text_delta", contentIndex: 0, delta: "nope", partial: assistantMessage }),
		);
		expect(events.some(event => event.kind === "conversation.message.delta" && event.delta === "nope")).toBe(false);
	});

	test("does not reserve a message id when a tool starts with no assistant owner", () => {
		const { projector, events, diagnostics, ids } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: {} });
		expect(events.some(event => event.kind === "conversation.tool.started")).toBe(false);
		expect(ids()).toBe(1);
		expect(diagnostics.some(message => message.includes("no owning assistant message"))).toBe(true);
	});

	test("tools after message_end attach to the completed assistant without stealing FIFO", () => {
		const { projector, events, ids } = createProjector();
		const message = assistant([{ type: "toolCall", id: "call-1", name: "Bash", arguments: {} }]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project({ type: "message_end", message });
		expect(ids()).toBe(2);
		projector.project({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: {} });
		const started = events.filter(event => event.kind === "conversation.tool.started");
		expect(started).toHaveLength(1);
		expect(started[0]?.kind === "conversation.tool.started" && started[0].messageId).toBe("msg-1");
		expect(ids()).toBe(2);
	});

	test("toolcall_end emits conversation.tool.started", () => {
		const { projector, events } = createProjector();
		const message = assistant([]);
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message });
		projector.project(
			update(message, {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "a.ts" } },
				partial: message,
			}),
		);
		const started = events.find(event => event.kind === "conversation.tool.started");
		expect(started?.kind === "conversation.tool.started" && started.toolCallId).toBe("call-1");
		expect(started?.kind === "conversation.tool.started" && started.messageId).toBe("msg-1");
		expect(started?.kind === "conversation.tool.started" && started.toolName).toBe("Read");
	});

	test("joins multiple tool result text blocks with newlines", () => {
		const { projector, events } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: assistant([]) });
		projector.project({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: {} });
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "Bash",
			result: {
				content: [
					{ type: "text", text: "stdout" },
					{ type: "text", text: "stderr" },
				],
				isError: false,
			},
			isError: false,
		});
		const completed = events.find(event => event.kind === "conversation.tool.completed");
		expect(completed?.kind === "conversation.tool.completed" && completed.result.output).toBe("stdout\nstderr");
	});

	test("accepts the same toolCallId again after it completed", () => {
		const { projector, events } = createProjector();
		projector.project({ type: "agent_start" });
		projector.project({ type: "message_start", message: assistant([]) });
		projector.project({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: {} });
		projector.project({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "Bash",
			result: { content: [{ type: "text", text: "first" }], isError: false },
			isError: false,
		});
		projector.project({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", args: {} });
		const started = events.filter(event => event.kind === "conversation.tool.started");
		expect(started).toHaveLength(2);
	});
});
