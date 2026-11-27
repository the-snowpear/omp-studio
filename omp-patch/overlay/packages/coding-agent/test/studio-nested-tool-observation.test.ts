import { expect, test } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import {
	ExtensionToolWrapper,
	observeNestedToolCalls,
	type NestedToolObservation,
} from "../src/extensibility/extensions/wrapper";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

test("nested completion observes the extension's final replacement result and error status", async () => {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_result", () => ({
				content: [{ type: "text", text: "safe replacement" }],
				details: { repaired: true },
				isError: false,
			}));
		},
		process.cwd(),
		new EventBus(),
		runtime,
		"nested-result-rewrite",
	);
	const auth = await AuthStorage.create(":memory:");
	const manager = SessionManager.inMemory();
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		process.cwd(),
		manager,
		new ModelRegistry(auth),
		undefined,
		Settings.isolated({ "tools.approvalMode": "yolo" }),
	);
	const events: NestedToolObservation[] = [];
	const stop = observeNestedToolCalls(event => {
		if (event.sessionId === manager.getSessionId()) events.push(event);
	});
	const tool: AgentTool = {
		name: "boom",
		label: "Boom",
		description: "Throws before extension recovery",
		approval: "read",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("private original failure");
		},
	};
	try {
		const result = await new ExtensionToolWrapper(tool, runner).execute("nested", {}, undefined, undefined, {
			parentToolCallId: "parent",
		} as AgentToolContext);
		expect(events.map(event => event.phase)).toEqual(["start", "end"]);
		expect(events[1]).toMatchObject({ parentToolCallId: "parent", toolCallId: "nested", isError: false, result });
		expect(JSON.stringify(events)).not.toContain("private original failure");
		expect(result.content).toEqual([{ type: "text", text: "safe replacement" }]);
	} finally {
		stop();
		await manager.close();
		auth.close();
	}
});

test("a nested failure emits one final failed observation and preserves the thrown error", async () => {
	const runtime = new ExtensionRuntime();
	const auth = await AuthStorage.create(":memory:");
	const manager = SessionManager.inMemory();
	const runner = new ExtensionRunner(
		[],
		runtime,
		process.cwd(),
		manager,
		new ModelRegistry(auth),
		undefined,
		Settings.isolated({ "tools.approvalMode": "yolo" }),
	);
	const events: NestedToolObservation[] = [];
	const stop = observeNestedToolCalls(event => {
		if (event.sessionId === manager.getSessionId()) events.push(event);
	});
	const failure = new Error("execution failed");
	const tool: AgentTool = {
		name: "boom",
		label: "Boom",
		description: "Throws",
		approval: "read",
		parameters: Type.Object({}),
		execute: async () => {
			throw failure;
		},
	};
	try {
		await expect(
			new ExtensionToolWrapper(tool, runner).execute("nested", {}, undefined, undefined, {
				parentToolCallId: "parent",
			} as AgentToolContext),
		).rejects.toBe(failure);
		expect(events.map(event => event.phase)).toEqual(["start", "end"]);
		expect(events[1]).toMatchObject({
			isError: true,
			result: { content: [{ type: "text", text: "execution failed" }] },
		});
	} finally {
		stop();
		await manager.close();
		auth.close();
	}
});

test("worker-homed nested calls cross the existing session event channel once with the final result", async () => {
	const events: AgentSessionEvent[] = [];
	const local: NestedToolObservation[] = [];
	const stop = observeNestedToolCalls(event => local.push(event));
	const done = Promise.withResolvers<void>();
	const worker = new Worker(new URL("./studio-fixtures/nested-tool-worker.ts", import.meta.url));
	worker.onmessage = message => {
		const data = message.data as { kind: string; event?: AgentSessionEvent };
		if (data.kind === "event" && data.event) events.push(data.event);
		if (data.kind === "complete") done.resolve();
	};
	worker.onerror = error => done.reject(new Error(error.message));
	try {
		await done.promise;
		expect(events.filter(event => event.type === "tool_execution_start")).toEqual([
			expect.objectContaining({
				type: "tool_execution_start",
				toolCallId: "child-call",
				parentToolCallId: "parent-call",
			}),
		]);
		expect(events.filter(event => event.type === "tool_execution_end")).toEqual([
			expect.objectContaining({
				toolCallId: "child-call",
				isError: false,
				result: expect.objectContaining({ content: [{ type: "text", text: "worker replacement" }] }),
			}),
		]);
		expect(local).toEqual([]);
	} finally {
		stop();
		worker.terminate();
	}
}, 30000);
