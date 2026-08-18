import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	reconstructSessionBranch,
	type StudioAgentConversationError,
	StudioAgentConversationService,
} from "@oh-my-pi/pi-coding-agent/studio/services/agent-conversation-service";
import { TempDir } from "@oh-my-pi/pi-utils";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("StudioAgentConversationService", () => {
	test("reads a live child session through the shared ConversationItem projection", async () => {
		using tempDir = TempDir.createSync("@omp-studio-agent-convo-live-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage(userMessage("audit the lockfile"));
		const registry = new AgentRegistry();
		registry.register({
			id: "agent-019fcb01",
			displayName: "deps",
			kind: "sub",
			session: { sessionManager: manager } as AgentSession,
			sessionFile: manager.getSessionFile() ?? null,
		});
		const service = new StudioAgentConversationService({
			registry,
			runtimeEpoch: () => 3,
		});
		const page = await service.read({ agentId: "agent-019fcb01" });
		expect(page.sessionId).toBe(manager.getSessionId());
		expect(page.runtimeEpoch).toBe(3);
		expect(page.items.some(item => item.kind === "message")).toBe(true);
	});

	test("reads a parked sessionFile without starting an AgentSession", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "agent-019fc9d2",
			displayName: "docs",
			kind: "sub",
			session: null,
			sessionFile: "parked.jsonl",
			status: "parked",
		});
		const entries: FileEntry[] = [
			{ type: "session", id: "child-sess", timestamp: "2026-08-17T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-17T00:00:01.000Z",
				message: { role: "user", content: "extract notes", timestamp: Date.now() },
			},
		];
		const service = new StudioAgentConversationService({
			registry,
			runtimeEpoch: () => 3,
			loadEntries: async () => entries,
		});
		const page = await service.read({ agentId: "agent-019fc9d2" });
		expect(page.sessionId).toBe("child-sess");
		expect(page.items).toHaveLength(1);
	});

	test("corrupt or empty files are unavailable", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "agent-corrupt",
			displayName: "corrupt",
			kind: "sub",
			session: null,
			sessionFile: "broken.jsonl",
			status: "parked",
		});
		const failing = new StudioAgentConversationService({
			registry,
			runtimeEpoch: () => 3,
			loadEntries: async () => {
				throw new Error("truncated jsonl");
			},
		});
		await expect(failing.read({ agentId: "agent-corrupt" })).rejects.toMatchObject({
			code: "TRANSCRIPT_UNAVAILABLE",
		});
		const empty = new StudioAgentConversationService({
			registry,
			runtimeEpoch: () => 3,
			loadEntries: async () => [],
		});
		await expect(empty.read({ agentId: "agent-corrupt" })).rejects.toMatchObject({
			code: "TRANSCRIPT_UNAVAILABLE",
		});
	});

	test("unknown agents and missing files fail closed", async () => {
		const registry = new AgentRegistry();
		const service = new StudioAgentConversationService({
			registry,
			runtimeEpoch: () => 3,
		});
		await expect(service.read({ agentId: "missing" })).rejects.toMatchObject({
			name: "StudioAgentConversationError",
			code: "AGENT_NOT_FOUND",
		} satisfies Partial<StudioAgentConversationError>);
		registry.register({
			id: "agent-empty",
			displayName: "empty",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});
		await expect(service.read({ agentId: "agent-empty" })).rejects.toMatchObject({
			code: "TRANSCRIPT_UNAVAILABLE",
		});
	});

	test("replacing the AgentRef during an async file read is stale", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "agent-019fcb17",
			displayName: "preview",
			kind: "sub",
			session: null,
			sessionFile: "first.jsonl",
			status: "parked",
		});
		let release!: () => void;
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		const service = new StudioAgentConversationService({
			registry,
			runtimeEpoch: () => 3,
			loadEntries: async () => {
				await blocked;
				return [{ type: "session", id: "old-sess", timestamp: "2026-08-17T00:00:00.000Z", cwd: "/tmp" }];
			},
		});
		const pending = service.read({ agentId: "agent-019fcb17" });
		registry.unregister("agent-019fcb17");
		registry.register({
			id: "agent-019fcb17",
			displayName: "preview",
			kind: "sub",
			session: null,
			sessionFile: "second.jsonl",
			status: "parked",
		});
		release();
		await expect(pending).rejects.toMatchObject({ code: "CURSOR_STALE" });
	});

	test("reconstructSessionBranch walks parentId from the last entry", () => {
		const branch = reconstructSessionBranch([
			{ type: "session", id: "sess", timestamp: "2026-08-17T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-08-17T00:00:01.000Z",
				message: { role: "user", content: "a", timestamp: 1 },
			},
			{
				type: "message",
				id: "side",
				parentId: "root",
				timestamp: "2026-08-17T00:00:02.000Z",
				message: { role: "user", content: "b", timestamp: 2 },
			},
			{
				type: "message",
				id: "leaf",
				parentId: "root",
				timestamp: "2026-08-17T00:00:03.000Z",
				message: { role: "user", content: "c", timestamp: 3 },
			},
		]);
		expect(branch?.sessionId).toBe("sess");
		expect(branch?.branchLeafId).toBe("leaf");
		expect(branch?.branch.map(entry => entry.id)).toEqual(["root", "leaf"]);
	});

	test("reconstructSessionBranch prefers a trailing active_leaf pointer", () => {
		const branch = reconstructSessionBranch([
			{ type: "session", id: "sess", timestamp: "2026-08-17T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-08-17T00:00:01.000Z",
				message: { role: "user", content: "a", timestamp: 1 },
			},
			{
				type: "message",
				id: "side",
				parentId: "root",
				timestamp: "2026-08-17T00:00:02.000Z",
				message: { role: "user", content: "b", timestamp: 2 },
			},
			{
				type: "message",
				id: "leaf",
				parentId: "root",
				timestamp: "2026-08-17T00:00:03.000Z",
				message: { role: "user", content: "c", timestamp: 3 },
			},
			{
				type: "active_leaf",
				id: "ptr",
				parentId: null,
				timestamp: "2026-08-17T00:00:04.000Z",
				targetId: "side",
			} as never,
		]);
		expect(branch?.branchLeafId).toBe("side");
		expect(branch?.branch.map(entry => entry.id)).toEqual(["root", "side"]);
	});
});
