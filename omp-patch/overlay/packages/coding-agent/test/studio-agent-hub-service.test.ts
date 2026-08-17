import { describe, expect, test } from "bun:test";
import type { AgentRef, AgentStatus, RegistryEvent } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	StudioAgentHubError,
	StudioAgentHubService,
	type StudioAgentLifecyclePort,
	type StudioAgentRegistryPort,
	type StudioAgentSpawnerPort,
	type StudioAgentSpawnRequest,
	type StudioAgentTelemetryPort,
	type StudioAgentUsage,
	type StudioConfirmationGate,
	type StudioIrcBusPort,
	type StudioLiveAgentPort,
	type StudioMessage,
	type StudioTranscriptReaderPort,
} from "@oh-my-pi/pi-coding-agent/studio/services/agent-hub-service";

const SECRET_SESSION = "C:\\secret\\sessions\\agent-1.jsonl";
const SECRET_WORKTREE = "D:\\secret\\worktrees\\child-1";

function makeLiveAgent(streaming = false): StudioLiveAgentPort & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		isStreaming: streaming,
		async prompt(text) {
			calls.push(`prompt:${text}`);
			return true;
		},
		async steer(text) {
			calls.push(`steer:${text}`);
		},
		async followUp(text) {
			calls.push(`followUp:${text}`);
		},
		async abort(options) {
			calls.push(`abort:${options?.reason ?? "none"}`);
		},
	};
}

function makeRef(id: string, overrides: Partial<AgentRef> = {}): AgentRef {
	return {
		id,
		displayName: id,
		kind: "sub",
		status: "running",
		session: null,
		sessionFile: null,
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_001,
		...overrides,
	} as unknown as AgentRef;
}

function makeRegistry() {
	const refs = new Map<string, AgentRef>();
	const listeners = new Set<(event: RegistryEvent) => void>();
	const registry: StudioAgentRegistryPort = {
		get: id => refs.get(id),
		list: () => [...refs.values()],
		onChange: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const emit = (event: RegistryEvent): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		registry,
		refs,
		register(ref: AgentRef): void {
			refs.set(ref.id, ref);
			emit({ type: "registered", ref });
		},
		remove(id: string): void {
			const ref = refs.get(id);
			if (!ref) return;
			refs.delete(id);
			emit({ type: "removed", ref });
		},
		setStatus(id: string, status: AgentStatus): void {
			const ref = refs.get(id);
			if (!ref) return;
			ref.status = status;
			emit({ type: "status_changed", ref });
		},
		attachSession(id: string, session: unknown): void {
			const ref = refs.get(id);
			if (!ref) return;
			ref.session = session as AgentSession;
		},
	};
}

function makeLifecycle(registry: ReturnType<typeof makeRegistry>, options: { failEnsureLive?: boolean } = {}) {
	const calls: string[] = [];
	const lifecycle: StudioAgentLifecyclePort = {
		async ensureLive(id) {
			calls.push(`ensureLive:${id}`);
			if (options.failEnsureLive) throw new Error(`${SECRET_SESSION}: revival failed`);
			const ref = registry.refs.get(id);
			if (ref?.status !== "parked") throw new Error(`${SECRET_SESSION}: unknown agent`);
			const live = makeLiveAgent();
			ref.session = live as unknown as AgentSession;
			ref.status = "idle";
			return ref.session;
		},
		async release(id, expected, options) {
			calls.push(`release:${id}:${options?.tombstone === true ? "tombstone" : "plain"}`);
			const ref = registry.refs.get(id);
			if (!ref || (expected !== undefined && ref !== expected)) return false;
			if (options?.tombstone === true) {
				ref.session = null;
				ref.status = "aborted";
			} else {
				registry.remove(id);
			}
			return true;
		},
		has(id, expected) {
			const ref = registry.refs.get(id);
			return ref !== undefined && (expected === undefined || ref === expected);
		},
	};
	return { lifecycle, calls: () => calls };
}

function makeIrc() {
	const unread = new Map<string, number>();
	const irc: StudioIrcBusPort = { unreadCount: id => unread.get(id) ?? 0 };
	return { irc, setUnread: (id: string, count: number) => unread.set(id, count) };
}

function makeSpawner() {
	const requests: StudioAgentSpawnRequest[] = [];
	let next: { agentId: string; jobId?: string } | Error = { agentId: "Child-1" };
	const spawner: StudioAgentSpawnerPort = {
		async spawn(request) {
			requests.push(request);
			if (next instanceof Error) throw next;
			return next;
		},
	};
	return {
		spawner,
		requests: () => requests,
		setNext: (value: { agentId: string; jobId?: string } | Error) => {
			next = value;
		},
	};
}

function makeTranscript(messages: StudioMessage[]) {
	const calls: { agentId: string; offset: number; limit: number }[] = [];
	const reader: StudioTranscriptReaderPort = {
		async read(args) {
			calls.push(args);
			const page = messages.slice(args.offset, args.offset + args.limit);
			return { messages: page, eof: args.offset + args.limit >= messages.length };
		},
	};
	return { reader, calls: () => calls };
}

function makeMessages(count: number): StudioMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `m-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		ts: 1_700_000_000_000 + index,
		text: `message ${index}`,
	}));
}

function makeTelemetry(
	live: Record<string, { usage?: StudioAgentUsage; model?: string; summary?: string }> = {},
): StudioAgentTelemetryPort & { notify: (agentId: string) => void } {
	const listeners = new Map<string, Set<() => void>>();
	return {
		liveUsage: agentId => live[agentId]?.usage,
		liveModel: agentId => live[agentId]?.model,
		liveSummary: agentId => live[agentId]?.summary,
		refresh: () => {},
		onChange: (agentId, listener) => {
			let set = listeners.get(agentId);
			if (!set) {
				set = new Set();
				listeners.set(agentId, set);
			}
			set.add(listener);
			const currentSet = set;
			return () => currentSet.delete(listener);
		},
		notify(agentId: string): void {
			for (const listener of listeners.get(agentId) ?? []) listener();
		},
	};
}

function makeHub(
	options: {
		gate?: StudioConfirmationGate;
		activeJobIdsFor?: (agentId: string) => string[];
		messages?: StudioMessage[];
		failEnsureLive?: boolean;
		telemetry?: StudioAgentTelemetryPort;
	} = {},
) {
	const registry = makeRegistry();
	const lifecycle = makeLifecycle(registry, { failEnsureLive: options.failEnsureLive });
	const irc = makeIrc();
	const spawner = makeSpawner();
	const transcript = makeTranscript(options.messages ?? []);
	const service = new StudioAgentHubService(
		registry.registry,
		lifecycle.lifecycle,
		irc.irc,
		spawner.spawner,
		transcript.reader,
		{
			confirmationGate: options.gate,
			activeJobIdsFor: options.activeJobIdsFor,
			...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
		},
	);
	return { service, registry, lifecycle, irc, spawner, transcript };
}

const acceptingGate: StudioConfirmationGate = () => true;
const denyingGate: StudioConfirmationGate = () => false;

describe("WP-050/051/053 StudioAgentHubService", () => {
	test("list/get return bounded path-free DTOs", async () => {
		const { service, registry, irc } = makeHub({
			activeJobIdsFor: id => (id === "Worker" ? ["job-1"] : []),
		});
		registry.register(makeRef("Main", { kind: "main", status: "running" }));
		registry.register(
			makeRef("Worker", {
				status: "running",
				parentId: "Main",
				activity: "running tests",
				session: makeLiveAgent() as unknown as AgentSession,
			}),
		);
		registry.register(makeRef("Parked-1", { status: "parked", parentId: "Main", sessionFile: SECRET_SESSION }));
		irc.setUnread("Worker", 2);

		const roster = service.list();
		expect(roster.map(s => s.agentId).sort()).toEqual(["Main", "Parked-1", "Worker"]);
		expect(JSON.stringify(roster)).not.toContain("secret");
		expect(JSON.stringify(roster)).not.toContain("jsonl");

		const worker = service.get("Worker");
		expect(worker).toMatchObject({
			agentId: "Worker",
			generation: 1,
			parentAgentId: "Main",
			kind: "sub",
			displayName: "Worker",
			status: "running",
			assignment: "running tests",
			hasLiveSession: true,
			hasTranscript: true,
			unreadCount: 2,
			activeJobIds: ["job-1"],
		});
		expect(service.list({ limit: 2 })).toHaveLength(2);
		expect(service.get("Parked-1")).toMatchObject({ status: "parked", hasLiveSession: false, hasTranscript: true });
		expect(() => service.get("")).toThrow(StudioAgentHubError);
		try {
			service.get("");
		} catch (error) {
			expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
		}
		expect(() => service.get("Missing")).toThrow(StudioAgentHubError);
	});

	test("generation CAS: stale mutations fail closed with the latest snapshot", async () => {
		const { service, registry } = makeHub({ gate: acceptingGate });
		const live = makeLiveAgent();
		registry.register(
			makeRef("Child-1", { status: "idle", parentId: "Main", session: live as unknown as AgentSession }),
		);
		expect(service.get("Child-1").generation).toBe(1);
		await service.send({
			agentId: "Child-1",
			expectedGeneration: 1,
			text: "hi",
			mode: "prompt",
			callerAgentId: "Main",
		});
		expect(live.calls).toEqual(["prompt:hi"]);
		await expect(
			service.send({ agentId: "Child-1", expectedGeneration: 9, text: "hi", mode: "prompt", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_GENERATION_CONFLICT", snapshot: { generation: 1 } });
		await expect(
			service.kill({ agentId: "Child-1", expectedGeneration: 9, callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_GENERATION_CONFLICT", snapshot: { generation: 1 } });
		await expect(
			service.revive({ agentId: "Child-1", expectedGeneration: 9, callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_GENERATION_CONFLICT" });
		await expect(
			service.release({ agentId: "Child-1", expectedGeneration: 9, callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_GENERATION_CONFLICT" });
	});

	test("delivery mode selects prompt vs steer vs followUp on the native live port", async () => {
		const { service, registry } = makeHub();
		const idle = makeLiveAgent(false);
		const running = makeLiveAgent(true);
		registry.register(
			makeRef("Idle-1", { status: "idle", parentId: "Main", session: idle as unknown as AgentSession }),
		);
		registry.register(
			makeRef("Busy-1", { status: "running", parentId: "Main", session: running as unknown as AgentSession }),
		);

		const woken = await service.send({
			agentId: "Idle-1",
			expectedGeneration: 1,
			text: "do it",
			mode: "prompt",
			callerAgentId: "Main",
		});
		expect(woken.outcome).toBe("woken");
		const queuedPrompt = await service.send({
			agentId: "Busy-1",
			expectedGeneration: 1,
			text: "do it",
			mode: "prompt",
			callerAgentId: "Main",
		});
		expect(queuedPrompt.outcome).toBe("queued");
		const steered = await service.send({
			agentId: "Busy-1",
			expectedGeneration: 1,
			text: "steer now",
			mode: "steer",
			callerAgentId: "Main",
		});
		expect(steered.outcome).toBe("injected");
		const followUp = await service.send({
			agentId: "Idle-1",
			expectedGeneration: 1,
			text: "later",
			mode: "followUp",
			callerAgentId: "Main",
		});
		expect(followUp.outcome).toBe("queued");
		const idleSteer = await service.send({
			agentId: "Idle-1",
			expectedGeneration: 1,
			text: "aside",
			mode: "steer",
			callerAgentId: "Main",
		});
		expect(idleSteer.outcome).toBe("queued");

		expect(idle.calls).toEqual(["prompt:do it", "followUp:later", "steer:aside"]);
		expect(running.calls).toEqual(["prompt:do it", "steer:steer now"]);
		await expect(
			service.send({ agentId: "Idle-1", expectedGeneration: 1, text: "", mode: "prompt", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});

	test("send to a parked agent revives through the lifecycle port and reports revived", async () => {
		const { service, registry, lifecycle } = makeHub();
		registry.register(makeRef("Parked-1", { status: "parked", parentId: "Main", sessionFile: SECRET_SESSION }));
		const result = await service.send({
			agentId: "Parked-1",
			expectedGeneration: 1,
			text: "wake up",
			mode: "followUp",
			callerAgentId: "Main",
		});
		expect(result.outcome).toBe("revived");
		expect(result.generation).toBe(2);
		expect(result.snapshot).toMatchObject({ status: "idle", generation: 2, hasLiveSession: true });
		expect(lifecycle.calls()).toEqual(["ensureLive:Parked-1"]);
		// The stale generation now conflicts.
		await expect(
			service.send({ agentId: "Parked-1", expectedGeneration: 1, text: "x", mode: "prompt", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_GENERATION_CONFLICT", snapshot: { generation: 2 } });
	});

	test("kill aborts the live session, tombstones at the killed generation, and never re-matches", async () => {
		const { service, registry, lifecycle } = makeHub({ gate: acceptingGate });
		const live = makeLiveAgent(true);
		registry.register(
			makeRef("Worker", {
				status: "running",
				parentId: "Main",
				session: live as unknown as AgentSession,
				sessionFile: SECRET_SESSION,
			}),
		);
		const killed = await service.kill({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" });
		expect(killed).toMatchObject({ killed: true });
		expect(killed.snapshot).toMatchObject({ status: "aborted", generation: 1, hasLiveSession: false });
		expect(live.calls).toEqual(["abort:killed from Studio agent hub"]);
		expect(lifecycle.calls()).toEqual(["release:Worker:tombstone"]);
		// Terminal snapshot semantics: messaging and duplicate kills fail closed.
		await expect(
			service.send({ agentId: "Worker", expectedGeneration: 1, text: "hi", mode: "prompt", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_TERMINAL", snapshot: { status: "aborted", generation: 1 } });
		await expect(
			service.kill({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "AGENT_TERMINAL",
			snapshot: { status: "aborted", generation: 1 },
		});
		// Aborted refs are hidden from the default roster and shown as terminal.
		expect(service.list().map(s => s.agentId)).not.toContain("Worker");
		expect(service.list({ includeTerminal: true }).map(s => s.agentId)).toContain("Worker");
		// Releasing the tombstone removes it entirely.
		const released = await service.release({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" });
		expect(released).toMatchObject({ released: true, gone: true });
		expect(() => service.get("Worker")).toThrow(StudioAgentHubError);
	});

	test("kill and release require a confirmation boundary with destructive metadata", async () => {
		const { service, registry } = makeHub();
		registry.register(makeRef("Worker", { status: "idle", parentId: "Main" }));
		await expect(
			service.kill({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "CONFIRMATION_REQUIRED",
			action: { kind: "kill", agentId: "Worker", generation: 1, risk: "destructive" },
		});
		registry.setStatus("Worker", "parked");
		await expect(
			service.release({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "CONFIRMATION_REQUIRED",
			action: { kind: "release", agentId: "Worker", generation: 1, risk: "destructive" },
		});
		const denied = makeHub({ gate: denyingGate });
		denied.registry.register(makeRef("W2", { status: "parked", parentId: "Main" }));
		await expect(
			denied.service.kill({ agentId: "W2", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "CONFIRMATION_DENIED",
		});
	});

	test("protected and read-only targets cannot be killed, revived, or messaged", async () => {
		const { service, registry } = makeHub({ gate: acceptingGate });
		registry.register(
			makeRef("Main", { kind: "main", status: "running", session: makeLiveAgent() as unknown as AgentSession }),
		);
		registry.register(makeRef("Advisor-1", { kind: "advisor", status: "idle", parentId: "Main" }));
		await expect(
			service.kill({ agentId: "Main", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "PROTECTED_TARGET",
		});
		await expect(
			service.send({
				agentId: "Advisor-1",
				expectedGeneration: 1,
				text: "hi",
				mode: "prompt",
				callerAgentId: "Main",
			}),
		).rejects.toMatchObject({ code: "READ_ONLY_TARGET" });
		await expect(
			service.kill({ agentId: "Advisor-1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "READ_ONLY_TARGET",
		});
		await expect(
			service.revive({ agentId: "Advisor-1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "READ_ONLY_TARGET",
		});
	});

	test("release removes parked agents as a non-kill terminal record; live agents are not releasable", async () => {
		const { service, registry } = makeHub({ gate: acceptingGate });
		registry.register(makeRef("Parked-1", { status: "parked", parentId: "Main", sessionFile: SECRET_SESSION }));
		const released = await service.release({ agentId: "Parked-1", expectedGeneration: 1, callerAgentId: "Main" });
		expect(released).toMatchObject({ released: true, gone: false });
		expect(released.snapshot).toMatchObject({ status: "released", generation: 1, hasTranscript: true });
		expect(service.get("Parked-1")).toMatchObject({ status: "released", generation: 1 });
		expect(service.list().map(s => s.agentId)).not.toContain("Parked-1");
		expect(service.list({ includePersisted: true }).map(s => s.agentId)).toContain("Parked-1");
		expect(service.list({ includeTerminal: true }).map(s => s.agentId)).toContain("Parked-1");
		// Releasing the terminal record removes it completely.
		const again = await service.release({ agentId: "Parked-1", expectedGeneration: 1, callerAgentId: "Main" });
		expect(again).toMatchObject({ released: true, gone: true });
		expect(() => service.get("Parked-1")).toThrow(StudioAgentHubError);

		const { service: second, registry: secondRegistry } = makeHub({ gate: acceptingGate });
		secondRegistry.register(
			makeRef("Live-1", { status: "idle", parentId: "Main", session: makeLiveAgent() as unknown as AgentSession }),
		);
		await expect(
			second.release({ agentId: "Live-1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "NOT_RELEASABLE",
			snapshot: { status: "idle" },
		});
	});

	test("revive only accepts parked agents and never leaks native lifecycle errors", async () => {
		const { service, registry } = makeHub({ gate: acceptingGate });
		registry.register(makeRef("Parked-1", { status: "parked", parentId: "Main", sessionFile: SECRET_SESSION }));
		registry.register(
			makeRef("Idle-1", { status: "idle", parentId: "Main", session: makeLiveAgent() as unknown as AgentSession }),
		);
		const revived = await service.revive({ agentId: "Parked-1", expectedGeneration: 1, callerAgentId: "Main" });
		expect(revived).toMatchObject({ revived: true, generation: 2 });
		expect(revived.snapshot).toMatchObject({ status: "idle", generation: 2, hasLiveSession: true });
		await expect(
			service.revive({ agentId: "Idle-1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			code: "NOT_REVIVABLE",
		});

		const failing = makeHub({ gate: acceptingGate, failEnsureLive: true });
		failing.registry.register(
			makeRef("Failing-1", { status: "parked", parentId: "Main", sessionFile: SECRET_SESSION }),
		);
		await expect(
			failing.service.revive({ agentId: "Failing-1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "LIFECYCLE_ERROR" });
		// The native failure message must never reach the caller.
		await expect(
			failing.service.revive({ agentId: "Failing-1", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({ message: expect.not.stringContaining("secret") });
	});

	test("owner scope: main controls descendants, children cannot control siblings or parents", async () => {
		const { service, registry } = makeHub();
		registry.register(
			makeRef("Main", { kind: "main", status: "idle", session: makeLiveAgent() as unknown as AgentSession }),
		);
		registry.register(
			makeRef("ChildA", { status: "idle", parentId: "Main", session: makeLiveAgent() as unknown as AgentSession }),
		);
		registry.register(
			makeRef("ChildB", { status: "idle", parentId: "Main", session: makeLiveAgent() as unknown as AgentSession }),
		);
		registry.register(
			makeRef("GrandchildA", {
				status: "idle",
				parentId: "ChildA",
				session: makeLiveAgent() as unknown as AgentSession,
			}),
		);
		// Main controls its descendants and itself.
		await expect(
			service.send({ agentId: "ChildB", expectedGeneration: 1, text: "hi", mode: "prompt", callerAgentId: "Main" }),
		).resolves.toMatchObject({ outcome: "woken" });
		await expect(
			service.send({ agentId: "Main", expectedGeneration: 1, text: "self", mode: "prompt", callerAgentId: "Main" }),
		).resolves.toMatchObject({ outcome: "woken" });
		// A child controls its own descendant.
		await expect(
			service.send({
				agentId: "GrandchildA",
				expectedGeneration: 1,
				text: "go",
				mode: "prompt",
				callerAgentId: "ChildA",
			}),
		).resolves.toMatchObject({ outcome: "woken" });
		// A child cannot control its sibling or its parent.
		await expect(
			service.send({
				agentId: "ChildB",
				expectedGeneration: 1,
				text: "hi",
				mode: "prompt",
				callerAgentId: "ChildA",
			}),
		).rejects.toMatchObject({ code: "NOT_OWNER" });
		await expect(
			service.send({ agentId: "Main", expectedGeneration: 1, text: "hi", mode: "prompt", callerAgentId: "ChildA" }),
		).rejects.toMatchObject({ code: "NOT_OWNER" });
	});

	test("spawn delegates to the native spawner port and reports a starting row", async () => {
		const { service, registry, spawner } = makeHub();
		const started = await service.spawn({
			definition: "researcher",
			assignment: "summarize the docs",
			context: "shared context",
			async: true,
			isolation: "patch",
			effort: "hi",
			callerAgentId: "Main",
		});
		expect(started).toEqual({ agentId: "Child-1", jobId: undefined, status: "starting" });
		expect(spawner.requests()).toEqual([
			{
				definition: "researcher",
				assignment: "summarize the docs",
				context: "shared context",
				async: true,
				isolation: "patch",
				effort: "hi",
				callerAgentId: "Main",
			},
		]);
		expect(service.get("Child-1")).toMatchObject({ status: "starting", kind: "sub", parentAgentId: "Main" });
		// Mutations on a starting agent fail closed.
		await expect(
			service.send({ agentId: "Child-1", expectedGeneration: 1, text: "hi", mode: "prompt", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_STARTING" });
		// Once the native registry reports the ref, the real snapshot takes over.
		registry.register(
			makeRef("Child-1", {
				status: "running",
				parentId: "Main",
				session: makeLiveAgent() as unknown as AgentSession,
			}),
		);
		expect(service.get("Child-1")).toMatchObject({ status: "running", generation: 1 });
		expect(service.list().map(s => s.agentId)).toContain("Child-1");
	});

	test("spawn validation and failure stay generic and path-free", async () => {
		const { service, spawner } = makeHub();
		await expect(service.spawn({ definition: "", assignment: "x", callerAgentId: "Main" })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
		await expect(
			service.spawn({ definition: "d", assignment: "x", isolation: "sandbox", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		spawner.setNext(new Error(`${SECRET_WORKTREE}: policy rejected`));
		await expect(
			service.spawn({ definition: "researcher", assignment: "summarize", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "SPAWN_FAILED", message: expect.not.stringContaining("secret") });
	});

	test("transcript reads use opaque bounded cursors and reject tampering and stale generations", async () => {
		const { service, registry } = makeHub({ messages: makeMessages(5) });
		registry.register(makeRef("Worker", { status: "idle", parentId: "Main", sessionFile: SECRET_SESSION }));
		const first = await service.readTranscript({ agentId: "Worker", limit: 2 });
		expect(first).toMatchObject({ generation: 1, eof: false });
		expect(first.messages.map(m => m.id)).toEqual(["m-0", "m-1"]);
		expect(first.nextCursor).toBeDefined();
		expect(typeof first.cursor).toBe("string");
		expect(first.cursor.includes("m-0")).toBeFalse();
		expect(JSON.stringify(first)).not.toContain("secret");

		const second = await service.readTranscript({ agentId: "Worker", cursor: first.nextCursor, limit: 2 });
		expect(second.messages.map(m => m.id)).toEqual(["m-2", "m-3"]);
		const third = await service.readTranscript({ agentId: "Worker", cursor: second.nextCursor, limit: 2 });
		expect(third.messages.map(m => m.id)).toEqual(["m-4"]);
		expect(third.eof).toBe(true);
		expect(third.nextCursor).toBeUndefined();

		// Malformed and tampered cursors fail closed.
		await expect(service.readTranscript({ agentId: "Worker", cursor: "not-a-cursor" })).rejects.toMatchObject({
			code: "INVALID_CURSOR",
		});
		const tampered = `${first.cursor.slice(0, -1)}${first.cursor.endsWith("A") ? "B" : "A"}`;
		await expect(service.readTranscript({ agentId: "Worker", cursor: tampered })).rejects.toMatchObject({
			code: "INVALID_CURSOR",
		});
		// Stale generation cursors are rejected after a revive.
		registry.setStatus("Worker", "parked");
		registry.attachSession("Worker", null);
		await service.revive({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" });
		await expect(service.readTranscript({ agentId: "Worker", cursor: first.cursor })).rejects.toMatchObject({
			code: "STALE_CURSOR",
		});
		expect((await service.readTranscript({ agentId: "Worker", cursor: undefined, limit: 100 })).generation).toBe(2);
	});

	test("transcript output is bounded and unavailable agents fail closed", async () => {
		const big = makeMessages(3);
		big[1] = { ...big[1], text: "x".repeat(200_000) };
		const { registry, transcript } = makeHub({ messages: big });
		registry.register(makeRef("Worker", { status: "idle", parentId: "Main", sessionFile: SECRET_SESSION }));
		const service2 = new StudioAgentHubService(
			registry.registry,
			makeLifecycle(registry).lifecycle,
			{ unreadCount: () => 0 },
			makeSpawner().spawner,
			transcript.reader,
			{ transcriptMessageLimit: 10 },
		);
		const page = await service2.readTranscript({ agentId: "Worker", limit: 500 });
		expect(page.messages).toHaveLength(3);
		expect(page.messages[1].text).toHaveLength(10);
		expect(transcript.calls().at(-1)).toMatchObject({ limit: 100 });

		const { service: other, registry: otherRegistry } = makeHub();
		otherRegistry.register(makeRef("NoTranscript", { status: "idle", parentId: "Main" }));
		await expect(other.readTranscript({ agentId: "NoTranscript" })).rejects.toMatchObject({
			code: "TRANSCRIPT_UNAVAILABLE",
		});
		await expect(other.readTranscript({ agentId: "Missing" })).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
	});

	test("re-registration after removal is a new native generation; old ids never re-match", async () => {
		const { service, registry } = makeHub();
		registry.register(
			makeRef("Child-1", { status: "idle", parentId: "Main", session: makeLiveAgent() as unknown as AgentSession }),
		);
		expect(service.get("Child-1").generation).toBe(1);
		registry.remove("Child-1");
		registry.register(
			makeRef("Child-1", { status: "idle", parentId: "Main", session: makeLiveAgent() as unknown as AgentSession }),
		);
		expect(service.get("Child-1").generation).toBe(2);
		await expect(
			service.send({ agentId: "Child-1", expectedGeneration: 1, text: "hi", mode: "prompt", callerAgentId: "Main" }),
		).rejects.toMatchObject({ code: "AGENT_GENERATION_CONFLICT", snapshot: { generation: 2 } });
	});

	test("onChange emits bounded snapshots on registry events", async () => {
		const { service, registry } = makeHub();
		const seen: string[] = [];
		const unsubscribe = service.onChange(snapshot =>
			seen.push(`${snapshot.agentId}:${snapshot.status}:${snapshot.generation}`),
		);
		registry.register(makeRef("Child-1", { status: "idle", parentId: "Main" }));
		registry.setStatus("Child-1", "parked");
		unsubscribe();
		registry.setStatus("Child-1", "idle");
		expect(seen).toEqual(["Child-1:idle:1", "Child-1:parked:1"]);
	});

	test("path-leak regression: snapshots and errors never carry native filesystem text", async () => {
		const { service, registry } = makeHub({ gate: acceptingGate, failEnsureLive: true });
		registry.register(
			makeRef("Worker", {
				status: "running",
				parentId: "Main",
				session: makeLiveAgent() as unknown as AgentSession,
				sessionFile: SECRET_SESSION,
			}),
		);
		const serialized = JSON.stringify(service.list({ includeTerminal: true }));
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("jsonl");
		expect(serialized).not.toContain("worktree");
		expect(serialized).not.toContain("C:\\");
		await service.kill({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" });
		expect(JSON.stringify(service.get("Worker"))).not.toContain("secret");
		registry.register(makeRef("P2", { status: "parked", parentId: "Main", sessionFile: SECRET_SESSION }));
		await expect(
			service.revive({ agentId: "P2", expectedGeneration: 1, callerAgentId: "Main" }),
		).rejects.toMatchObject({
			message: expect.not.stringContaining("secret"),
		});
	});

	test("history telemetry passes through to parked refs without live sessions", () => {
		const { service, registry } = makeHub();
		registry.register(
			makeRef("Parked-1", {
				status: "parked",
				parentId: "Main",
				sessionFile: SECRET_SESSION,
				history: {
					modelRole: "@smol",
					resolvedModel: "gemini-3.6-flash",
					resolvedModelIsFallback: false,
					metrics: {
						tokens: 12_600,
						requests: 9,
						tools: 14,
						cost: 0.51,
						durationMs: 167_000,
						durationKind: "active",
						contextTokens: 31_200,
						contextWindow: 128_000,
					},
					readOnly: false,
					outputPath: "agent-parked.md",
					patchPath: "agent-parked.patch",
					branchName: "omp/agent-parked",
				},
			}),
		);
		expect(service.get("Parked-1")).toMatchObject({
			usage: { tokens: 12_600, requests: 9, tools: 14, cost: 0.51 },
			modelRole: "@smol",
			resolvedModel: "gemini-3.6-flash",
			readOnly: false,
			outputPath: "agent-parked.md",
			patchPath: "agent-parked.patch",
			branchName: "omp/agent-parked",
		});
		expect(service.get("Parked-1").modelIsFallback).toBeUndefined();
	});

	test("live telemetry wins over persisted history and fills summary only without activity", () => {
		const telemetry = makeTelemetry({
			Worker: {
				usage: { tokens: 100, requests: 2, tools: 3, cost: 0.02, durationMs: 5_000, durationKind: "active" },
				model: "gpt-5-mini",
				summary: "latest assistant gist",
			},
		});
		const { service, registry } = makeHub({ telemetry });
		registry.register(
			makeRef("Worker", {
				status: "idle",
				parentId: "Main",
				session: makeLiveAgent() as unknown as AgentSession,
				history: {
					resolvedModel: "stale-model",
					resolvedModelIsFallback: true,
					metrics: { tokens: 1, requests: 1, tools: 1, cost: 0.01, durationMs: 1_000 },
				},
			}),
		);
		registry.register(
			makeRef("Busy", {
				status: "running",
				parentId: "Main",
				session: makeLiveAgent() as unknown as AgentSession,
				activity: "running Grep",
			}),
		);
		const worker = service.get("Worker");
		expect(worker.usage).toMatchObject({ tokens: 100, requests: 2, tools: 3, cost: 0.02 });
		expect(worker.resolvedModel).toBe("gpt-5-mini");
		// Live model is authoritative; the persisted fallback marker must not leak.
		expect(worker.modelIsFallback).toBeUndefined();
		expect(worker.summary).toBe("latest assistant gist");
		// Running agents keep the activity gist and never read a summary.
		expect(service.get("Busy").summary).toBeUndefined();
		expect(service.get("Busy").assignment).toBe("running Grep");
	});

	test("telemetry change events debounce into roster emissions", async () => {
		const telemetry = makeTelemetry({
			Worker: { usage: { tokens: 10, requests: 1, tools: 1, cost: 0.01, durationMs: 1_000 } },
		});
		const { service, registry } = makeHub({ telemetry });
		const seen: string[] = [];
		const unsubscribe = service.onChange(snapshot =>
			seen.push(`${snapshot.agentId}:${snapshot.usage?.tokens ?? -1}`),
		);
		registry.register(
			makeRef("Worker", {
				status: "running",
				parentId: "Main",
				session: makeLiveAgent() as unknown as AgentSession,
			}),
		);
		seen.length = 0;
		telemetry.notify("Worker");
		telemetry.notify("Worker");
		telemetry.notify("Worker");
		expect(seen).toEqual([]);
		await new Promise(resolve => setTimeout(resolve, 400));
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe("Worker:10");
		unsubscribe();
		service.dispose();
	});

	test("kill keeps history usage and artifacts on the terminal record", async () => {
		const { service, registry } = makeHub({ gate: acceptingGate });
		registry.register(
			makeRef("Worker", {
				status: "running",
				parentId: "Main",
				session: makeLiveAgent() as unknown as AgentSession,
				history: {
					modelRole: "@worker",
					resolvedModel: "gpt-5-mini",
					resolvedModelIsFallback: true,
					metrics: { tokens: 3_300, requests: 2, tools: 2, cost: 0.14, durationMs: 38_000 },
					outputPath: "agent-worker.md",
				},
			}),
		);
		await service.kill({ agentId: "Worker", expectedGeneration: 1, callerAgentId: "Main" });
		expect(service.get("Worker")).toMatchObject({
			status: "aborted",
			usage: { tokens: 3_300, cost: 0.14 },
			modelRole: "@worker",
			resolvedModel: "gpt-5-mini",
			modelIsFallback: true,
			outputPath: "agent-worker.md",
		});
	});
});
