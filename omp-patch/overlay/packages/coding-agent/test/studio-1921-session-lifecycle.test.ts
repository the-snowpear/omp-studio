import { expect, test, spyOn } from "bun:test";
import { AgentRegistry, type AgentRef } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioAgentModelService } from "../src/studio/services/agent-model-service";
import { inspectStudioJob } from "../src/studio/services/job-inspect";
import { sessionWaitingForApproval } from "../src/studio/services/pending-approvals";

test("approval wait survives disconnect and settles when a repaired parent tool result arrives", async () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("tool_approval_requested", {
		toolCallId: "nested",
		parentToolCallId: "eval",
		toolName: "bash",
	});
	expect(sessionWaitingForApproval(manager)).toBe(true);
	const read = spyOn(manager, "getBranch");
	expect(sessionWaitingForApproval(manager)).toBe(true);
	expect(read).not.toHaveBeenCalled();
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "eval",
		toolName: "eval",
		content: [{ type: "text", text: "Interrupted" }],
		isError: true,
		timestamp: Date.now(),
	});
	expect(sessionWaitingForApproval(manager)).toBe(false);
	read.mockRestore();
	await manager.close();
});

test("inspecting one background stream reads only that native stream and preserves the stream menu", async () => {
	const reads: string[] = [];
	const session = {
		sessionId: "s",
		inspectAsyncJob: () => ({
			pids: [],
			output: "own output",
			streams: [
				{
					id: "pipe:1",
					kind: "pipe",
					producer: "build",
					consumer: "tee",
					bytes: 40,
					open: true,
					modified: 1,
					tail: () => {
						reads.push("pipe");
						return "pipe output";
					},
				},
				{
					id: "file:2",
					kind: "file",
					producer: "tee",
					consumer: "/build.log",
					bytes: 50,
					open: true,
					modified: 2,
					tail: () => {
						reads.push("file");
						return "redirected output";
					},
				},
			],
		}),
	} as unknown as AgentSession;
	const own = await inspectStudioJob(session, "job");
	expect(own.output).toBe("own output");
	expect(reads).toEqual([]);
	const file = await inspectStudioJob(session, "job", "file:2");
	expect(file.output).toBe("redirected output");
	expect(file.selectedStreamId).toBe("file:2");
	expect(file.streams).toHaveLength(2);
	expect(reads).toEqual(["file"]);
});

test("a running worker receives model and effort changes on its native session handle", async () => {
	const calls: unknown[] = [];
	const main = {
		sessionId: "parent",
		sessionManager: { getSessionId: () => "parent" },
		getAvailableModels: () => [],
	} as unknown as AgentSession;
	const child = {
		sessionManager: { getSessionId: () => "child" },
		isStreaming: true,
		applyAgentModelChange: async (change: unknown) => {
			calls.push(change);
			return { model: "provider/model", effort: "high" };
		},
	};
	const refs = [
		{ id: "Main", session: main },
		{ id: "Child", kind: "sub", parentId: "Main", session: child },
	] as unknown as AgentRef[];
	const registry = AgentRegistry.global();
	const list = spyOn(registry, "list").mockReturnValue(refs);
	const get = spyOn(registry, "get").mockImplementation(id => refs.find(row => row.id === id));
	try {
		const service = new StudioAgentModelService(main);
		expect(
			(
				await service.execute({
					kind: "agent.model.set",
					sessionId: "parent",
					agentId: "Child",
					model: "provider/model",
				})
			).controllable,
		).toBe(true);
		await service.execute({ kind: "agent.effort.set", sessionId: "parent", agentId: "Child", effort: "high" });
		expect(calls).toEqual([{ kind: "studio", patterns: ["provider/model"] }, { effort: "high" }]);
		expect(child.isStreaming).toBe(true);
	} finally {
		get.mockRestore();
		list.mockRestore();
	}
});
