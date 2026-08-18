import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	CONVERSATION_LIMITS,
	parseConversationTranscriptPage,
} from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";
import {
	StudioSessionTranscriptError,
	StudioSessionTranscriptService,
	projectConversationBranch,
} from "@oh-my-pi/pi-coding-agent/studio/services/session-transcript-service";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>,
) {
	return {
		role: "assistant" as const,
		content,
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError,
		timestamp: Date.now(),
	};
}

function serviceFor(manager: SessionManager, runtimeEpoch = 3) {
	return new StudioSessionTranscriptService(() => ({
		runtimeEpoch,
		sessionId: manager.getSessionId(),
		sessionManager: manager,
	}));
}

describe("StudioSessionTranscriptService", () => {
	test("empty branch returns no items and a usable head cursor", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-empty-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const service = serviceFor(manager);
		const page = service.read();
		expect(page.items).toEqual([]);
		expect(page.hasMoreBefore).toBe(false);
		expect(page.olderCursor).toBeUndefined();
		expect(page.branchLeafId).toBeNull();
		expect(page.headCursor.length).toBeGreaterThan(0);
		expect(service.read({ cursor: page.headCursor }).items).toEqual([]);
		expect(parseConversationTranscriptPage(page).headCursor).toBe(page.headCursor);
	});

	test("maps user and assistant multi-block messages with stable SessionEntry ids", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-blocks-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const userId = manager.appendMessage(userMessage("hello\nworld"));
		const assistantId = manager.appendMessage(
			assistantMessage([
				{ type: "thinking", thinking: "plan first" },
				{ type: "text", text: "working" },
				{ type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
			]),
		);
		const page = serviceFor(manager).read();
		expect(page.items.map(item => item.itemId)).toEqual([userId, assistantId]);
		expect(page.items[0]).toMatchObject({
			kind: "message",
			itemId: userId,
			role: "user",
			content: [{ type: "text", text: "hello\nworld" }],
		});
		expect(page.items[1]).toMatchObject({
			kind: "message",
			itemId: assistantId,
			parentId: userId,
			role: "assistant",
			content: [
				{ type: "thinking", text: "plan first" },
				{ type: "text", text: "working" },
				{ type: "toolCall", toolCallId: "call-1", toolName: "Read", arguments: { path: "package.json" } },
			],
		});
	});

	test("omits developer and synthetic/steering user harness messages from the public page", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-harness-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const userId = manager.appendMessage(userMessage("hello"));
		manager.appendMessage({
			role: "developer",
			content: [
				{
					type: "text",
					text: "<system-reminder>\nYou stopped with 2 incomplete todo item(s):\n</system-reminder>",
				},
			],
			attribution: "agent",
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "user",
			content: "<instruction>MUST read local://annotation-channel-v2-plan.md</instruction>",
			synthetic: true,
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "user",
			content: "steer the turn",
			steering: true,
			timestamp: Date.now(),
		});
		const assistantId = manager.appendMessage(assistantMessage([{ type: "text", text: "done" }]));
		const page = serviceFor(manager).read();
		expect(page.items.map(item => item.itemId)).toEqual([userId, assistantId]);
		expect(page.items.map(item => (item.kind === "message" ? item.role : item.kind))).toEqual(["user", "assistant"]);
		const serialized = JSON.stringify(page);
		expect(serialized).not.toContain("system-reminder");
		expect(serialized).not.toContain("<instruction>");
		expect(serialized).not.toContain("steer the turn");
	});

	test("maps successful and failed tool results without leaking providerPayload", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-tools-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage(userMessage("read it"));
		manager.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-ok", name: "Read", arguments: { path: "a.ts" } }]),
		);
		manager.appendMessage(toolResult("call-ok", "Read", '{"ok":true}', false));
		manager.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-bad", name: "Bash", arguments: { command: "nope" } }]),
		);
		manager.appendMessage(toolResult("call-bad", "Bash", "exit 1", true));
		manager.appendMessage({
			role: "user",
			content: "secret turn",
			timestamp: Date.now(),
			providerPayload: { type: "openaiResponsesHistory", items: [{ token: "sk-leak" }] },
		});
		const page = serviceFor(manager).read();
		const ok = page.items.find(
			item =>
				item.kind === "message" &&
				item.content.some(block => block.type === "toolResult" && block.toolCallId === "call-ok"),
		);
		const err = page.items.find(
			item =>
				item.kind === "message" &&
				item.content.some(block => block.type === "toolResult" && block.toolCallId === "call-bad"),
		);
		expect(ok).toMatchObject({
			kind: "message",
			content: [
				{ type: "toolCall", toolCallId: "call-ok", toolName: "Read" },
				{ type: "toolResult", toolCallId: "call-ok", toolName: "Read", output: '{"ok":true}', isError: false },
			],
		});
		expect(err).toMatchObject({
			kind: "message",
			content: [
				{ type: "toolCall", toolCallId: "call-bad", toolName: "Bash" },
				{ type: "toolResult", toolCallId: "call-bad", toolName: "Bash", output: "exit 1", isError: true },
			],
		});
		expect(JSON.stringify(page)).not.toContain("providerPayload");
		expect(JSON.stringify(page)).not.toContain("sk-leak");
	});

	test("maps compaction and reset, and ignores branch_summary", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-markers-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const userId = manager.appendMessage(userMessage("before"));
		const compactId = manager.appendCompaction("long summary", "short", userId, 12, { preserve: true }, false, {
			secret: "nope",
		});
		const resetId = manager.appendResetBoundary();
		manager.branchWithSummary(resetId, "abandoned sibling summary");
		const page = serviceFor(manager).read();
		expect(page.items.map(item => item.kind)).toEqual(["message", "compaction", "resetBoundary"]);
		expect(page.items[1]).toMatchObject({
			kind: "compaction",
			itemId: compactId,
			summary: "long summary",
			shortSummary: "short",
		});
		expect(JSON.stringify(page.items[1])).not.toContain("preserve");
		expect(JSON.stringify(page.items[1])).not.toContain("nope");
		expect(page.items[2]).toMatchObject({ kind: "resetBoundary", itemId: resetId });
		expect(JSON.stringify(page)).not.toContain("abandoned sibling summary");
	});

	test("latest and older pages have no duplicates, gaps, or order inversions", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-pages-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const ids = ["one", "two", "three", "four", "five"].map(text => manager.appendMessage(userMessage(text)));
		const service = serviceFor(manager);
		const latest = service.read({ limit: 2 });
		expect(latest.items.map(item => item.itemId)).toEqual(ids.slice(-2));
		expect(latest.hasMoreBefore).toBe(true);
		expect(latest.olderCursor).toBeDefined();
		const middle = service.read({ cursor: latest.olderCursor, limit: 2 });
		expect(middle.items.map(item => item.itemId)).toEqual(ids.slice(1, 3));
		const oldest = service.read({ cursor: middle.olderCursor, limit: 2 });
		expect(oldest.items.map(item => item.itemId)).toEqual(ids.slice(0, 1));
		expect(oldest.hasMoreBefore).toBe(false);
		const seen = [...oldest.items, ...middle.items, ...latest.items].map(item => item.itemId);
		expect(seen).toEqual(ids);
		expect(new Set(seen).size).toBe(ids.length);
	});

	test("sibling branches do not leak into the active transcript", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-sibling-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const rootId = manager.appendMessage(userMessage("root"));
		const siblingId = manager.appendMessage(userMessage("sibling"));
		manager.branch(rootId);
		const keptId = manager.appendMessage(userMessage("kept"));
		const page = serviceFor(manager).read();
		const ids = page.items.map(item => item.itemId);
		expect(ids).toEqual([rootId, keptId]);
		expect(ids).not.toContain(siblingId);
		expect(manager.getEntries().some(entry => entry.id === siblingId)).toBe(true);
	});

	test("old cursors become stale after a branch change and tampering is invalid", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-stale-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const rootId = manager.appendMessage(userMessage("root"));
		manager.appendMessage(userMessage("leaf-a"));
		const service = serviceFor(manager);
		const page = service.read({ limit: 1 });
		const head = page.headCursor;
		manager.branch(rootId);
		manager.appendMessage(userMessage("leaf-b"));
		expect(() => service.read({ cursor: head })).toThrow(StudioSessionTranscriptError);
		try {
			service.read({ cursor: head });
		} catch (error) {
			expect(error).toBeInstanceOf(StudioSessionTranscriptError);
			expect((error as StudioSessionTranscriptError).code).toBe("CURSOR_STALE");
		}
		const flipped = `${head.slice(0, -1)}${head.endsWith("a") ? "b" : "a"}`;
		try {
			service.read({ cursor: flipped });
		} catch (error) {
			expect(error).toBeInstanceOf(StudioSessionTranscriptError);
			expect((error as StudioSessionTranscriptError).code).toBe("INVALID_ARGUMENT");
		}
		expect(() => service.read({ cursor: "not-a-cursor" })).toThrow(StudioSessionTranscriptError);
	});

	test("redacts secret keys and shortens home paths", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-redact-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const homeFile = `${os.homedir()}${os.homedir().includes("\\") ? "\\" : "/"}secret-file.json`;
		manager.appendMessage(
			assistantMessage([
				{
					type: "toolCall",
					id: "call-secret",
					name: "Read",
					arguments: {
						apiKey: "sk-live",
						token: "abc",
						password: "hunter2",
						authorization: "Bearer xyz",
						cookie: "sid=1",
						secret: "hidden",
						path: homeFile,
					},
				},
			]),
		);
		const page = serviceFor(manager).read();
		const serialized = JSON.stringify(page);
		expect(serialized).not.toContain("sk-live");
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("Bearer xyz");
		expect(serialized).toContain("[redacted]");
		expect(serialized).not.toContain(os.homedir());
		expect(serialized).toContain("~");
	});

	test("huge tool results are truncated and stay within the page byte budget", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-huge-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const huge = "x".repeat(CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES + 4096);
		manager.appendMessage(toolResult("call-huge", "Bash", huge, false));
		const page = serviceFor(manager).read();
		const block =
			page.items[0] && page.items[0].kind === "message"
				? page.items[0].content.find(item => item.type === "toolResult")
				: undefined;
		expect(block).toMatchObject({ type: "toolResult", truncated: true });
		expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
			CONVERSATION_LIMITS.PAGE_MAX_BYTES,
		);
		expect(parseConversationTranscriptPage(page).items).toHaveLength(1);
	});

	test("illegal custom entries do not crash the reader", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-custom-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		manager.appendCustomEntry("evil", circular);
		const userId = manager.appendMessage(userMessage("still readable"));
		const page = serviceFor(manager).read();
		expect(page.items.map(item => item.itemId)).toEqual([userId]);
	});

	test("no active session is an explicit error, not a fake empty page", () => {
		const service = new StudioSessionTranscriptService(() => ({
			runtimeEpoch: 1,
			sessionId: "",
			sessionManager: undefined,
		}));
		try {
			service.read();
			throw new Error("expected no-session error");
		} catch (error) {
			expect(error).toBeInstanceOf(StudioSessionTranscriptError);
			expect((error as StudioSessionTranscriptError).code).toBe("COMMAND_BLOCKED");
		}
	});

	test("head cursor comes from the service and only changes after persist", () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-head-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const transcript = serviceFor(manager);
		const runtime = {
			runtimeId: "runtime-transcript",
			runtimeEpoch: 3,
			sessionId: manager.getSessionId(),
			sessionManager: manager,
			session: {
				isStreaming: false,
				isCompacting: false,
				queuedMessageCount: 0,
				getAgentId: () => "Main",
			},
			services: {
				transcript,
				pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
				loop: { state: () => undefined, onChange: () => () => {} },
				live: { state: () => ({ status: "off" }), onChange: () => () => {} },
				modes: { state: () => ({}), onChange: () => () => {} },
				commands: { manifestHash: () => "sha256:commands" },
				agents: { list: () => [], onChange: () => () => {} },
				jobs: { list: () => [] },
			},
		} as unknown as StudioHostRuntime;
		const projector = new StudioStateProjector(runtime);
		const emptyCursor = transcript.headCursor();
		expect(projector.response("snap-empty").messagesCursor).toBe(emptyCursor);
		const beforePersist = projector.response("snap-live").messagesCursor;
		expect(beforePersist).toBe(emptyCursor);
		manager.appendMessage(userMessage("persisted"));
		const afterPersist = transcript.headCursor();
		expect(afterPersist).not.toBe(emptyCursor);
		expect(projector.response("snap-persisted").messagesCursor).toBe(afterPersist);
		projector.dispose();
	});
});

describe("projectConversationBranch", () => {
	test("inserts an orphan toolResult in chronological order", () => {
		const items = projectConversationBranch([
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-15T00:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "orphan",
				parentId: "u1",
				timestamp: "2026-08-15T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "missing",
					toolName: "Bash",
					content: [{ type: "text", text: "out" }],
					isError: false,
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "u2",
				parentId: "orphan",
				timestamp: "2026-08-15T00:00:03.000Z",
				message: { role: "user", content: "later", timestamp: 3 },
			},
		] as never);
		expect(items.map(item => item.itemId)).toEqual(["u1", "orphan", "u2"]);
	});

	test("empty toolCallIds pair onto the parent call and stay unique across assistants", () => {
		const items = projectConversationBranch([
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-08-15T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "", name: "Bash", arguments: {} }],
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: "2026-08-15T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "",
					toolName: "Bash",
					content: [{ type: "text", text: "one" }],
					isError: false,
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "a2",
				parentId: "r1",
				timestamp: "2026-08-15T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "", name: "Read", arguments: {} }],
					timestamp: 3,
				},
			},
		] as never);
		expect(items.map(item => item.itemId)).toEqual(["a1", "a2"]);
		const first = items[0];
		const second = items[1];
		expect(first?.kind).toBe("message");
		expect(second?.kind).toBe("message");
		if (first?.kind !== "message" || second?.kind !== "message") return;
		const firstCall = first.content.find(block => block.type === "toolCall");
		const firstResult = first.content.find(block => block.type === "toolResult");
		const secondCall = second.content.find(block => block.type === "toolCall");
		expect(firstCall?.type === "toolCall" && firstCall.toolCallId !== "tool-call").toBe(true);
		expect(firstResult?.type === "toolResult" && firstResult.output).toBe("one");
		expect(firstCall?.type === "toolCall" && firstResult?.type === "toolResult" && firstCall.toolCallId === firstResult.toolCallId).toBe(true);
		expect(secondCall?.type === "toolCall" && firstCall?.type === "toolCall" && secondCall.toolCallId !== firstCall.toolCallId).toBe(true);
	});

	test("over-long toolCallIds stay unique after bounding", () => {
		const prefix = "x".repeat(CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS);
		const items = projectConversationBranch([
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-08-15T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: `${prefix}a`, name: "Bash", arguments: {} },
						{ type: "toolCall", id: `${prefix}b`, name: "Read", arguments: {} },
					],
					timestamp: 1,
				},
			},
		] as never);
		const message = items[0];
		expect(message?.kind).toBe("message");
		if (message?.kind !== "message") return;
		const ids = message.content.filter(block => block.type === "toolCall").map(block => block.toolCallId);
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
		expect(ids.every(id => id.length <= CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS)).toBe(true);
	});
});
