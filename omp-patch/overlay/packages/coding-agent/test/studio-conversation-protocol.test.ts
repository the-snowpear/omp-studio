import { describe, expect, test } from "bun:test";
import {
	parseStudioRequest,
	STUDIO_IMPLEMENTED_CAPABILITIES,
	StudioFrameError,
	type StudioSnapshotResponse,
	stableEmptyManifestHash,
	stableImplementedManifestHash,
} from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import {
	CONVERSATION_BRANCH_SUMMARY_MAPPING,
	CONVERSATION_LIMITS,
	CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION,
	parseConversationRuntimeEvent,
	parseConversationTranscriptPage,
	SESSION_TRANSCRIPT_READ_CAPABILITY,
	SESSION_TRANSCRIPT_READ_CONCURRENCY,
	SESSION_TRANSCRIPT_READ_KIND,
	STUDIO_CONVERSATION_DISPATCH_ALLOW_LIST,
	StudioConversationError,
} from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";

const base = { type: "studio.request" as const, requestId: "request-transcript", runtimeEpoch: 1 };

const page = {
	runtimeEpoch: 1,
	sessionId: "session-1",
	branchLeafId: "leaf-1",
	items: [
		{ kind: "resetBoundary", itemId: "reset-1", parentId: null, createdAt: "2026-08-15T00:00:00.000Z" },
		{
			kind: "message",
			itemId: "msg-1",
			parentId: "reset-1",
			createdAt: "2026-08-15T00:00:01.000Z",
			role: "user",
			content: [{ type: "text", text: "hello" }],
		},
		{
			kind: "message",
			itemId: "msg-2",
			parentId: "msg-1",
			createdAt: "2026-08-15T00:00:02.000Z",
			role: "assistant",
			content: [
				{ type: "thinking", text: "plan" },
				{ type: "toolCall", toolCallId: "call-1", toolName: "Read", arguments: { path: "package.json" } },
				{ type: "toolResult", toolCallId: "call-1", output: "{}", isError: false },
				{ type: "text", text: "done" },
			],
		},
		{
			kind: "compaction",
			itemId: "compact-1",
			parentId: "msg-2",
			createdAt: "2026-08-15T00:00:03.000Z",
			summary: "summarized",
		},
	],
	headCursor: "opaque-head",
	olderCursor: "opaque-older",
	hasMoreBefore: true,
};

describe("session transcript contract mirror", () => {
	test("advertises session.history only after the Runtime reader exists", () => {
		expect(SESSION_TRANSCRIPT_READ_KIND).toBe("session.transcript.read");
		expect(SESSION_TRANSCRIPT_READ_CAPABILITY).toBe("session.history");
		expect(SESSION_TRANSCRIPT_READ_CONCURRENCY).toBe("read-concurrent");
		expect(CONVERSATION_BRANCH_SUMMARY_MAPPING).toBe("ignore");
		expect(CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION).toBe(false);
		expect(STUDIO_CONVERSATION_DISPATCH_ALLOW_LIST).toEqual(["session.transcript.read"]);
		expect(STUDIO_IMPLEMENTED_CAPABILITIES.includes("session.history")).toBe(true);
		expect((STUDIO_IMPLEMENTED_CAPABILITIES as readonly string[]).includes("session.transcript.read")).toBe(true);
		expect(CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX).toBe(100);
		expect(CONVERSATION_LIMITS.PAGE_MAX_BYTES).toBeLessThan(1024 * 1024);
		const capabilityHash = stableImplementedManifestHash("capabilities");
		expect(capabilityHash.startsWith("sha256:")).toBe(true);
		expect(capabilityHash).not.toBe(stableEmptyManifestHash("capabilities"));
	});

	test("parses agent.conversation.read and rejects illegal cursor, limit, and extra keys", () => {
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "agent.conversation.read", agentId: "agent-1", cursor: "opaque", limit: 50 },
			}).operation.kind,
		).toBe("agent.conversation.read");
		for (const operation of [
			{ kind: "agent.conversation.read", agentId: "" },
			{ kind: "agent.conversation.read", agentId: "agent-1", cursor: "" },
			{ kind: "agent.conversation.read", agentId: "agent-1", limit: 0 },
			{ kind: "agent.conversation.read", agentId: "agent-1", limit: 101 },
			{ kind: "agent.conversation.read", agentId: "agent-1", extra: true },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});

	test("parses session.transcript.read and rejects illegal cursor, limit, and extra keys", () => {
		expect(parseStudioRequest({ ...base, operation: { kind: "session.transcript.read" } }).operation.kind).toBe(
			"session.transcript.read",
		);
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "session.transcript.read", cursor: "opaque", limit: 50 },
			}).operation.kind,
		).toBe("session.transcript.read");
		for (const operation of [
			{ kind: "session.transcript.read", cursor: "" },
			{ kind: "session.transcript.read", limit: 0 },
			{ kind: "session.transcript.read", limit: 101 },
			{ kind: "session.transcript.read", extra: true },
		]) {
			expect(() => parseStudioRequest({ ...base, operation })).toThrow(StudioFrameError);
		}
	});

	test("parses every public item and block kind", () => {
		const parsed = parseConversationTranscriptPage(page);
		expect(parsed.items.map(item => item.kind)).toEqual(["resetBoundary", "message", "message", "compaction"]);
	});

	test("rejects extra keys, missing fields, branch_summary, and over-limit pages", () => {
		expect(() => parseConversationTranscriptPage({ ...page, extra: true })).toThrow(StudioConversationError);
		expect(() => parseConversationTranscriptPage({ ...page, hasMoreBefore: "yes" })).toThrow(StudioConversationError);
		expect(() =>
			parseConversationTranscriptPage({
				...page,
				items: [{ kind: "branch_summary", itemId: "x", parentId: null, createdAt: "2026-08-15T00:00:00.000Z" }],
			}),
		).toThrow(StudioConversationError);
		const tooMany = Array.from({ length: CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX + 1 }, (_, index) => ({
			kind: "resetBoundary" as const,
			itemId: `reset-${index}`,
			parentId: null,
			createdAt: "2026-08-15T00:00:00.000Z",
		}));
		expect(() => parseConversationTranscriptPage({ ...page, items: tooMany })).toThrow(StudioConversationError);
	});

	test("snapshot messagesCursor is an optional opaque head hint", () => {
		const snapshot: StudioSnapshotResponse = {
			type: "studio.snapshot",
			requestId: "req-snapshot",
			snapshot: {
				runtimeId: "runtime-1",
				runtimeEpoch: 1,
				stateVersion: 0,
				sessionId: "session-1",
				isStreaming: false,
				isCompacting: false,
				activeMode: "normal",
				approvalMode: "yolo",
				pendingMessages: 0,
				activeCommandIds: [],
				agentsRevision: 0,
				jobsRevision: 0,
				agents: [],
				jobs: [],
			},
			commandManifestHash: "sha256:commands",
			capabilityHash: "sha256:capabilities",
			lastEventSeq: 0,
			messagesCursor: "opaque-head",
			terminalReceipts: [],
		};
		expect(snapshot.messagesCursor).toBe("opaque-head");
		expect("items" in snapshot).toBe(false);
	});

	test("parses every live conversation event kind and rejects inner occurredAt and id mismatch", () => {
		const events = [
			{
				kind: "conversation.message.started",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-1",
				role: "assistant",
				createdAt: "2026-08-15T00:00:00.000Z",
			},
			{
				kind: "conversation.message.delta",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-1",
				blockId: "block-1",
				blockType: "text",
				delta: "Hi",
			},
			{
				kind: "conversation.message.completed",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-1",
				item: {
					kind: "message",
					itemId: "msg-1",
					parentId: null,
					createdAt: "2026-08-15T00:00:00.000Z",
					role: "assistant",
					content: [{ type: "text", text: "Hi" }],
				},
			},
			{
				kind: "conversation.tool.started",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-1",
				toolCallId: "call-1",
				toolName: "Read",
				startedAt: "2026-08-15T00:00:01.000Z",
			},
			{
				kind: "conversation.tool.updated",
				sessionId: "session-1",
				turnId: "turn-1",
				toolCallId: "call-1",
				updateMode: "replace",
				output: "out",
			},
			{
				kind: "conversation.tool.completed",
				sessionId: "session-1",
				turnId: "turn-1",
				toolCallId: "call-1",
				result: { type: "toolResult", toolCallId: "call-1", isError: false },
				completedAt: "2026-08-15T00:00:02.000Z",
			},
			{ kind: "conversation.turn.completed", sessionId: "session-1", turnId: "turn-1" },
			{ kind: "conversation.turn.aborted", sessionId: "session-1", turnId: "turn-1" },
			{ kind: "conversation.compaction.started", sessionId: "session-1", action: "auto" },
			{ kind: "conversation.compaction.completed", sessionId: "session-1", aborted: true },
			{ kind: "conversation.notice", sessionId: "session-1", level: "info", message: "ok" },
		];
		for (const event of events) {
			expect(parseConversationRuntimeEvent(event).kind as string).toBe(event.kind as string);
		}
		expect(() =>
			parseConversationRuntimeEvent({
				kind: "conversation.message.started",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "msg-1",
				role: "assistant",
				createdAt: "2026-08-15T00:00:00.000Z",
				occurredAt: "2026-08-15T00:00:00.000Z",
			}),
		).toThrow(StudioConversationError);
		expect(() =>
			parseConversationRuntimeEvent({
				kind: "conversation.message.completed",
				sessionId: "session-1",
				turnId: "turn-1",
				messageId: "live-1",
				item: {
					kind: "message",
					itemId: "persisted-2",
					parentId: null,
					createdAt: "2026-08-15T00:00:00.000Z",
					role: "assistant",
					content: [{ type: "text", text: "Hi" }],
				},
			}),
		).toThrow(StudioConversationError);
	});

	test("completed assistant messages may carry a live-only provider error", () => {
		const event = {
			kind: "conversation.message.completed" as const,
			sessionId: "session-1",
			turnId: "turn-1",
			messageId: "msg-1",
			item: {
				kind: "message" as const,
				itemId: "msg-1",
				parentId: null,
				createdAt: "2026-08-15T00:00:00.000Z",
				role: "assistant" as const,
				content: [],
			},
			error: {
				message: "Model is not supported by composite groups",
				status: 400,
				provider: "sub2api-go",
				model: "mimo-v2.5",
			},
		};
		expect(parseConversationRuntimeEvent(event)).toEqual(event);
		expect(() =>
			parseConversationRuntimeEvent({
				...event,
				error: { message: "" },
			}),
		).toThrow(StudioConversationError);
		expect(() =>
			parseConversationRuntimeEvent({
				...event,
				error: { message: "fail", extra: true },
			}),
		).toThrow(StudioConversationError);
	});
});
