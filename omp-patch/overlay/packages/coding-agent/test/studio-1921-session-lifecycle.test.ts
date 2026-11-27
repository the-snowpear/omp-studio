import { expect, test, spyOn } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { AgentRegistry, type AgentRef } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { inspectAsyncJob } from "../src/session/async-job-views";
import { SessionManager } from "../src/session/session-manager";
import { StudioAgentModelService } from "../src/studio/services/agent-model-service";
import { inputStudioJob, inspectStudioJob, readStudioPtyInputWaits } from "../src/studio/services/job-inspect";
import { sessionWaitingForApproval } from "../src/studio/services/pending-approvals";

test("a descendant PTY wait retains its source and can receive input through the observing session", async () => {
	const manager = new AsyncJobManager({});
	const ready = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const inputs: string[] = [];
	const registry = AgentRegistry.global();
	const list = spyOn(registry, "list").mockReturnValue([
		{ id: "Main" },
		{ id: "Child", parentId: "Main" },
		{ id: "Other" },
	] as AgentRef[]);
	try {
		const jobId = manager.register(
			"bash",
			"Child prompt",
			async ({ reportProgress }) => {
				await reportProgress("Enter name:", {
					pty: {
						sessionId: "child-session",
						toolCallId: "child-pty",
						command: "read name",
						waiting: true,
						notify: true,
						canInput: true,
					},
				});
				ready.resolve();
				await finished.promise;
				return "done";
			},
			{
				ownerId: "Child",
				process: {
					command: "read name",
					cwd: ".",
					pids: () => [],
					input: async data => {
						inputs.push(data);
					},
				},
			},
		);
		await ready.promise;
		const session = {
			sessionId: "parent-session",
			asyncJobManager: manager,
			inspectAsyncJob: (id: string) => inspectAsyncJob(manager, "Main", id),
		} as unknown as AgentSession;
		const waits = readStudioPtyInputWaits(session);
		expect(waits).toEqual([
			{
				sessionId: "parent-session",
				sourceSessionId: "child-session",
				ownerAgentId: "Child",
				jobId,
				jobGeneration: manager.getJob(jobId)!.startTime,
				toolCallId: "child-pty",
				command: "read name",
				waiting: true,
				notify: true,
			},
		]);
		await inputStudioJob(session, waits[0]!.jobId!, waits[0]!.jobGeneration!, "Alice\r");
		expect(inputs).toEqual(["Alice\r"]);
		expect(
			readStudioPtyInputWaits({
				...session,
				inspectAsyncJob: (id: string) => inspectAsyncJob(manager, "Other", id),
			} as AgentSession),
		).toEqual([]);
		finished.resolve();
		await manager.getJob(jobId)!.promise;
		expect(readStudioPtyInputWaits(session)).toEqual([]);
	} finally {
		finished.resolve();
		list.mockRestore();
		await manager.dispose({ timeoutMs: 1000 });
	}
});

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
