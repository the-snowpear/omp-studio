import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StudioBridgeDispatcher } from "@oh-my-pi/pi-coding-agent/studio/bridge-dispatcher";
import type {
	StudioEventEnvelope,
	StudioReceipt,
	StudioRequest,
	StudioSnapshotResponse,
} from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { parseConversationTranscriptPage } from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";
import { StudioInteractionGateway } from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";
import { StudioLiveService } from "@oh-my-pi/pi-coding-agent/studio/services/live-service";
import { StudioLoopService } from "@oh-my-pi/pi-coding-agent/studio/services/loop-service";
import { StudioPauseService } from "@oh-my-pi/pi-coding-agent/studio/services/pause-service";
import { StudioSessionTranscriptService } from "@oh-my-pi/pi-coding-agent/studio/services/session-transcript-service";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";
import { TempDir } from "@oh-my-pi/pi-utils";

class FakeSession {
	isStreaming = false;
	isCompacting = false;
	queuedMessageCount = 0;
	followUpCalls = 0;

	getAgentId(): string {
		return "Main";
	}

	async followUp(): Promise<void> {
		this.followUpCalls += 1;
		this.queuedMessageCount += 1;
	}
}

function transcriptFixture(
	manager: SessionManager,
	agentConversation?: { read: (args: { agentId: string; cursor?: string; limit?: number }) => Promise<unknown> },
) {
	const session = new FakeSession();
	const transcript = new StudioSessionTranscriptService(() => ({
		runtimeEpoch: 7,
		sessionId: manager.getSessionId(),
		sessionManager: manager,
	}));
	const runtime = {
		runtimeId: "runtime-transcript-dispatch",
		runtimeEpoch: 7,
		sessionId: manager.getSessionId(),
		session,
		sessionManager: manager,
		services: {
			live: new StudioLiveService(),
			pause: new StudioPauseService(),
			loop: new StudioLoopService({
				action: () => "prompt",
				isBlocked: () => false,
				isVibeActive: () => false,
				submitPrompt: () => {},
				compact: () => {},
				reset: () => {},
				nowMs: Date.now,
				setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
				clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
			}),
			modes: { state: () => ({}), onChange: () => () => {} },
			tree: { getTree: () => ({ leafId: null, roots: [] }), navigate: async () => ({}) },
			fork: { fork: async () => ({ forked: true, sessionId: manager.getSessionId() }) },
			commands: {
				manifest: () => ({ hash: "sha256:test-commands", commands: [] }),
				manifestHash: () => "sha256:test-commands",
			},
			btw: { onChange: () => () => {} },
			interaction: new StudioInteractionGateway(),
			tan: { start: async () => ({}) },
			omfg: { generate: async () => ({}) },
			agents: { onChange: () => () => {}, list: () => [] },
			jobs: { list: () => [] },
			transcript,
			...(agentConversation === undefined ? {} : { agentConversation }),
		},
	} as unknown as StudioHostRuntime;
	const projector = new StudioStateProjector(runtime);
	const frames: Array<{
		frameId: string;
		body: StudioReceipt | StudioEventEnvelope | ReturnType<StudioStateProjector["response"]>;
	}> = [];
	const dispatcher = new StudioBridgeDispatcher(runtime, projector, (frameId, body) => {
		frames.push({ frameId, body });
	});
	const request = (requestId: string, operation: StudioRequest["operation"]): StudioRequest => ({
		type: "studio.request",
		requestId,
		runtimeEpoch: 7,
		operation,
	});
	return { session, projector, frames, dispatcher, request, transcript };
}

describe("session.transcript.read dispatcher", () => {
	test("reads the active branch without a lease, pending command, or remembered receipt", async () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-dispatch-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const { projector, frames, dispatcher, request, session } = transcriptFixture(manager);
		session.isStreaming = true;
		session.isCompacting = true;
		const beforeVersion = projector.stateVersion;
		const beforeReceipts = projector.response("before").terminalReceipts.length;

		await dispatcher.dispatch(request("read-one", { kind: "session.transcript.read", limit: 10 }));
		expect(frames).toHaveLength(1);
		expect(frames[0]!.frameId.startsWith("receipt-accepted:")).toBe(false);
		const receipt = frames[0]!.body as StudioReceipt;
		expect(receipt.status).toBe("completed");
		const page = parseConversationTranscriptPage(receipt.result);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ kind: "message", role: "user" });
		expect(projector.stateVersion).toBe(beforeVersion);
		expect(projector.response("after").terminalReceipts).toHaveLength(beforeReceipts);
		expect(projector.snapshot().activeCommandIds).toEqual([]);

		await dispatcher.dispatch(request("read-one", { kind: "session.transcript.read", limit: 10 }));
		expect(frames).toHaveLength(2);
		expect((frames[1]!.body as StudioReceipt).status).toBe("completed");
		expect(frames[1]!.frameId.startsWith("receipt-replay:")).toBe(false);

		session.isStreaming = false;
		session.isCompacting = false;
		await dispatcher.dispatch(request("enqueue-after-read", { kind: "queue.enqueue", text: "next" }));
		expect(session.followUpCalls).toBe(1);
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
	});

	test("snapshot messagesCursor is the service head cursor and rejects a stale epoch", async () => {
		using tempDir = TempDir.createSync("@omp-studio-transcript-snapshot-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const { projector, frames, dispatcher, request, transcript } = transcriptFixture(manager);
		const snapshot = projector.response("snap") as StudioSnapshotResponse;
		expect(snapshot.messagesCursor).toBe(transcript.headCursor());
		await dispatcher.dispatch({
			type: "studio.request",
			requestId: "stale-read",
			runtimeEpoch: 6,
			operation: { kind: "session.transcript.read" },
		});
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({ code: "RUNTIME_EPOCH_STALE" });
		await dispatcher.dispatch(request("missing-session-not-used", { kind: "session.transcript.read" }));
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
	});
});

describe("agent.conversation.read dispatcher", () => {
	test("reads concurrently without a lease, pending command, or remembered receipt", async () => {
		using tempDir = TempDir.createSync("@omp-studio-agent-convo-dispatch-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const childPage = {
			runtimeEpoch: 7,
			sessionId: "child-sess",
			branchLeafId: "leaf-1",
			items: [
				{
					kind: "message" as const,
					itemId: "child-1",
					parentId: null,
					createdAt: "2026-08-17T00:00:00.000Z",
					role: "user" as const,
					content: [{ type: "text" as const, text: "hello" }],
				},
			],
			headCursor: "head",
			hasMoreBefore: false,
		};
		const { projector, frames, dispatcher, request } = transcriptFixture(manager, {
			read: async () => childPage,
		});
		const beforeVersion = projector.stateVersion;
		const beforeReceipts = projector.response("before").terminalReceipts.length;
		await dispatcher.dispatch(
			request("child-read", { kind: "agent.conversation.read", agentId: "agent-019fcb01", limit: 10 }),
		);
		expect(frames).toHaveLength(1);
		expect(frames[0]!.frameId.startsWith("receipt-accepted:")).toBe(false);
		const receipt = frames[0]!.body as StudioReceipt;
		expect(receipt.status).toBe("completed");
		expect(receipt.result).toMatchObject({ sessionId: "child-sess" });
		expect(projector.stateVersion).toBe(beforeVersion);
		expect(projector.response("after").terminalReceipts).toHaveLength(beforeReceipts);
		expect(projector.snapshot().activeCommandIds).toEqual([]);
		await dispatcher.dispatch(
			request("child-read", { kind: "agent.conversation.read", agentId: "agent-019fcb01", limit: 10 }),
		);
		expect(frames).toHaveLength(2);
		expect((frames[1]!.body as StudioReceipt).status).toBe("completed");
		expect(frames[1]!.frameId.startsWith("receipt-replay:")).toBe(false);
	});

	test("maps missing agents to COMMAND_BLOCKED without accepting a command", async () => {
		using tempDir = TempDir.createSync("@omp-studio-agent-convo-missing-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const { StudioAgentConversationError } =
			await import("@oh-my-pi/pi-coding-agent/studio/services/agent-conversation-service");
		const { projector, frames, dispatcher, request } = transcriptFixture(manager, {
			read: async () => {
				throw new StudioAgentConversationError("AGENT_NOT_FOUND", "missing");
			},
		});
		const beforeVersion = projector.stateVersion;
		await dispatcher.dispatch(request("missing", { kind: "agent.conversation.read", agentId: "missing" }));
		const receipt = frames.at(-1)!.body as StudioReceipt;
		expect(receipt.status).not.toBe("accepted");
		expect(receipt.error).toMatchObject({
			code: "COMMAND_BLOCKED",
			details: { reason: "AGENT_NOT_FOUND" },
		});
		expect(projector.stateVersion).toBe(beforeVersion);
	});
});
