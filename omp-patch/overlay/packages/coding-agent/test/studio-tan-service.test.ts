import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MAX_TAN_WORK_LENGTH,
	type StudioTanAdoptInput,
	type StudioTanAdoptPort,
	type StudioTanCreateAgentOptions,
	type StudioTanCreateAgentPort,
	type StudioTanDeliverInput,
	type StudioTanDeliveryPort,
	StudioTanError,
	type StudioTanForkInput,
	type StudioTanForkPort,
	type StudioTanJobManagerPort,
	type StudioTanJobRunContext,
	type StudioTanParentContext,
	type StudioTanPorts,
	StudioTanService,
} from "@oh-my-pi/pi-coding-agent/studio/services/tan-service";

function fakeSession(overrides: Record<string, unknown> = {}): AgentSession {
	const session = {
		systemPrompt: ["clone system"],
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["bash", "edit"],
		setTodoPhases: () => {},
		agent: { appendMessage: () => {} },
		subscribe: () => () => {},
		async prompt() {
			return true;
		},
		async waitForIdle() {},
		getLastAssistantMessage: () => undefined,
		async abort() {},
		async dispose() {},
		...overrides,
	};
	return session as unknown as AgentSession;
}

function fakeCloneManager(overrides: Record<string, unknown> = {}): SessionManager {
	const manager = {
		appendCustomEntry: () => "entry-1",
		...overrides,
	};
	return manager as unknown as SessionManager;
}

function parentContext(overrides: Partial<StudioTanParentContext> = {}): StudioTanParentContext {
	return {
		sessionId: "parent-session-id",
		promptCacheKey: "parent-cache-key",
		ownerId: "Main",
		isStreaming: false,
		model: { id: "test-model" } as Model,
		modelRegistry: {} as ModelRegistry,
		authStorage: {} as AuthStorage,
		systemPrompt: ["parent system prompt"],
		toolNames: ["bash", "edit"],
		thinkingLevel: "auto",
		settings: { get: () => undefined, getStorage: () => null } as unknown as Settings,
		enableLsp: true,
		parentFile: "C:/sessions/parent.jsonl",
		cwd: "C:/work",
		sessionDir: "C:/sessions",
		artifactsDir: "C:/artifacts",
		parentLocalSessionId: "parent-local",
		...overrides,
	};
}

function assistant(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
}

function fixture(overrides: Partial<StudioTanPorts> = {}) {
	const calls: string[] = [];
	const statuses: string[] = [];
	const createArgs: StudioTanCreateAgentOptions[] = [];
	const adoptArgs: StudioTanAdoptInput[] = [];
	const registerArgs: Array<{ type: "task"; label: string; options: { ownerId: string; agentId: string } }> = [];
	const deliverInputs: StudioTanDeliverInput[] = [];
	const forkInputs: StudioTanForkInput[] = [];
	let run: ((ctx: StudioTanJobRunContext) => Promise<string>) | undefined;

	const track = <In extends unknown[], Out>(name: string, impl: (...args: In) => Out): ((...args: In) => Out) => {
		return (...args: In): Out => {
			calls.push(name);
			return impl(...args);
		};
	};

	const defaultFork: StudioTanForkPort = async input => {
		forkInputs.push(input);
		return fakeCloneManager();
	};
	const defaultCreate: StudioTanCreateAgentPort = async options => {
		createArgs.push(options);
		return { session: fakeSession(), sessionFile: "C:/sessions/Tan-1.jsonl" };
	};
	const defaultAdopt: StudioTanAdoptPort = input => {
		adoptArgs.push(input);
		return true;
	};
	const defaultRegister: StudioTanJobManagerPort["register"] = (type, label, jobRun, options) => {
		run = jobRun;
		registerArgs.push({ type, label, options });
		return "job-1";
	};
	const defaultDeliver: StudioTanDeliveryPort = async input => {
		deliverInputs.push(input);
	};

	const registry = {
		setStatus: track("setStatus", (_id: string, status: string) => {
			statuses.push(status);
			return true;
		}),
		detachSession: track("detachSession", () => true),
	} as unknown as AgentRegistry;

	const ports: StudioTanPorts = {
		parent: overrides.parent ?? parentContext(),
		fork: track("fork", overrides.fork ?? defaultFork),
		createAgent: track("createAgent", overrides.createAgent ?? defaultCreate),
		adopt: track("adopt", overrides.adopt ?? defaultAdopt),
		jobManager: {
			register: track("register", overrides.jobManager?.register ?? defaultRegister),
		},
		registry,
		deliver: track("deliver", overrides.deliver ?? defaultDeliver),
		cleanup: {
			cancelJob: track("cancelJob", overrides.cleanup?.cancelJob ?? (async () => {})),
			unregisterAgent: track("unregisterAgent", overrides.cleanup?.unregisterAgent ?? (async () => {})),
			disposeSession: track("disposeSession", overrides.cleanup?.disposeSession ?? (async () => {})),
			removeCloneFiles: track("removeCloneFiles", overrides.cleanup?.removeCloneFiles ?? (async () => {})),
		},
	};
	const service = new StudioTanService(ports);
	return {
		service,
		registry,
		calls: () => [...calls],
		statuses: () => [...statuses],
		createArgs: () => createArgs,
		adoptArgs: () => adoptArgs,
		registerArgs: () => registerArgs,
		deliverInputs: () => deliverInputs,
		forkInputs: () => forkInputs,
		runJob: (ctx?: Partial<StudioTanJobRunContext>) =>
			run?.({
				jobId: "job-1",
				signal: new AbortController().signal,
				reportProgress: async () => {},
				markRunning: () => {},
				...ctx,
			}),
	};
}

describe("WP-042 StudioTanService", () => {
	test("starts a TAN: fork, create, adopt, register, deliver — in order, once each", async () => {
		const f = fixture();
		const result = await f.service.start("Do the thing");
		expect(result.status).toBe("running");
		expect(result.jobId).toBe("job-1");
		expect(result.agentId).toMatch(/^Tan-/);
		expect(f.calls()).toEqual(["fork", "createAgent", "adopt", "register", "deliver"]);
		expect(f.forkInputs()).toHaveLength(1);
		expect(f.createArgs()).toHaveLength(1);
		expect(f.adoptArgs()).toHaveLength(1);
		expect(f.registerArgs()).toHaveLength(1);
		expect(f.deliverInputs()).toHaveLength(1);
	});

	test("forwards isolation flags, lineage, and the provider cache key", async () => {
		const f = fixture();
		const result = await f.service.start("Do the thing");
		const options = f.createArgs()[0];
		expect(options.disableExtensionDiscovery).toBe(true);
		expect(options.agentDisplayName).toBe("tan");
		expect(options.hasUI).toBe(false);
		expect(options.enableMCP).toBe(false);
		expect(options.parentAgentId).toBe("Main");
		expect(options.parentTaskPrefix).toBe(options.agentId);
		expect(options.agentId).toBe(result.agentId);
		expect(options.providerSessionId).toMatch(/^parent-session-id:tan:/);
		expect(options.providerPromptCacheKey).toBe("parent-cache-key");
		expect(options.cwd).toBe("C:/work");
		expect(options.settings).toBeDefined();
		expect(options.sessionManager).toBeDefined();
		expect(options.agentRegistry).toBe(f.registry);
		expect(options.localProtocolOptions?.getSessionId?.()).toBe("parent-local");
		expect(options.localProtocolOptions?.getArtifactsDir?.()).toBe("C:/artifacts");
		const forkInput = f.forkInputs()[0];
		expect(forkInput.parentFile).toBe("C:/sessions/parent.jsonl");
		expect(forkInput.sessionDir).toBe("C:/sessions");
		const cloneFile = forkInput.cloneFile.replaceAll("\\", "/");
		expect(cloneFile.startsWith("C:/sessions/Tan-")).toBe(true);
		expect(cloneFile.endsWith(".jsonl")).toBe(true);
		expect(f.adoptArgs()[0]).toMatchObject({
			agentId: options.agentId,
			displayName: "tan",
			parentId: "Main",
		});
		expect(f.registerArgs()[0]).toMatchObject({
			type: "task",
			label: "/tan Do the thing",
			options: { ownerId: "Main", agentId: options.agentId },
		});
		expect(f.deliverInputs()[0]).toEqual({ jobId: "job-1", work: "Do the thing" });
	});

	test("trims the work before dispatch", async () => {
		const f = fixture();
		await f.service.start("   spaced   ");
		expect(f.deliverInputs()[0]).toEqual({ jobId: "job-1", work: "spaced" });
	});

	test("rejects empty and oversized work with INVALID_ARGUMENT", async () => {
		await expect(fixture().service.start("   ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(fixture().service.start("x".repeat(MAX_TAN_WORK_LENGTH + 1))).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});

	test("rejects when the parent has no persisted session or no model", async () => {
		await expect(
			fixture({ parent: parentContext({ parentFile: undefined }) }).service.start("work"),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await expect(
			fixture({ parent: parentContext({ model: undefined }) }).service.start("work"),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	});

	test("rejects while the parent session is streaming", async () => {
		await expect(
			fixture({ parent: parentContext({ isStreaming: true }) }).service.start("work"),
		).rejects.toMatchObject({ code: "BUSY_STREAMING" });
	});

	test("rejects a concurrent start while one is being prepared", async () => {
		const gate = Promise.withResolvers<SessionManager>();
		const f = fixture({
			fork: async () => {
				await gate.promise;
				return fakeCloneManager();
			},
		});
		const first = f.service.start("first");
		await expect(f.service.start("second")).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		gate.resolve(fakeCloneManager());
		await expect(first).resolves.toMatchObject({ status: "running" });
		expect(f.calls()).toEqual(["fork", "createAgent", "adopt", "register", "deliver"]);
	});

	test("rolls back fork files when forking fails", async () => {
		const f = fixture({
			fork: async () => {
				throw new Error("fork boom");
			},
		});
		await expect(f.service.start("work")).rejects.toBeInstanceOf(StudioTanError);
		expect(f.calls()).toEqual(["fork", "removeCloneFiles"]);
		await expect(f.service.start("work")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
	});

	test("rolls back fork files when agent creation fails", async () => {
		const f = fixture({
			createAgent: async () => {
				throw new Error("create boom");
			},
		});
		await expect(f.service.start("work")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(f.calls()).toEqual(["fork", "createAgent", "removeCloneFiles"]);
	});

	test("rolls back agent, session, and fork files when adoption fails", async () => {
		const f = fixture({ adopt: () => false });
		await expect(f.service.start("work")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(f.calls()).toEqual([
			"fork",
			"createAgent",
			"adopt",
			"unregisterAgent",
			"disposeSession",
			"removeCloneFiles",
		]);
	});

	test("rolls back agent, session, and fork files when job registration fails", async () => {
		const f = fixture({
			jobManager: {
				register: () => {
					throw new Error("register boom");
				},
			},
		});
		await expect(f.service.start("work")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(f.calls()).toEqual([
			"fork",
			"createAgent",
			"adopt",
			"register",
			"unregisterAgent",
			"disposeSession",
			"removeCloneFiles",
		]);
	});

	test("cancels the job and rolls back everything when delivery fails", async () => {
		const f = fixture({
			deliver: async () => {
				throw new Error("deliver boom");
			},
		});
		await expect(f.service.start("work")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(f.calls()).toEqual([
			"fork",
			"createAgent",
			"adopt",
			"register",
			"deliver",
			"cancelJob",
			"unregisterAgent",
			"disposeSession",
			"removeCloneFiles",
		]);
		expect(f.service.get("job-1")).toBeUndefined();
	});

	test("releases the preparing gate after a failed start", async () => {
		let failNext = true;
		const f = fixture({
			createAgent: async () => {
				if (failNext) {
					failNext = false;
					throw new Error("boom");
				}
				return { session: fakeSession(), sessionFile: null };
			},
		});
		await expect(f.service.start("first")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		await expect(f.service.start("second")).resolves.toMatchObject({ status: "running" });
		expect(f.calls()).toEqual([
			"fork",
			"createAgent",
			"removeCloneFiles",
			"fork",
			"createAgent",
			"adopt",
			"register",
			"deliver",
		]);
	});

	test("runs the clone headlessly, clears inherited todos, parks, and completes", async () => {
		const messages: unknown[] = [];
		const todos: unknown[][] = [];
		const entries: unknown[] = [];
		const prompts: string[] = [];
		const session = fakeSession({
			agent: {
				appendMessage: (message: unknown) => {
					messages.push(message);
				},
			},
			subscribe: (listener: (event: { type: string; result?: unknown; aborted?: boolean }) => void) => {
				listener({ type: "auto_compaction_end", result: {}, aborted: false });
				return () => {};
			},
			getLastAssistantMessage: () => assistant("the answer"),
			async prompt(text: string) {
				prompts.push(text);
				return true;
			},
			setTodoPhases: (phases: unknown[]) => {
				todos.push(phases);
			},
		});
		const cloneManager = fakeCloneManager({
			appendCustomEntry: (type: string, data: unknown) => {
				entries.push({ type, data });
				return "entry-1";
			},
		});
		const f = fixture({
			fork: async () => cloneManager,
			createAgent: async () => ({ session, sessionFile: null }),
		});
		const result = await f.service.start("Run the numbers");
		expect(await f.runJob()).toBe("the answer");
		expect(prompts).toEqual(["Run the numbers"]);
		expect(todos).toEqual([[]]);
		expect(entries).toEqual([{ type: "user_todo_edit", data: { phases: [] } }]);
		expect(messages).toHaveLength(2);
		expect((messages[0] as { role: string }).role).toBe("developer");
		expect(f.statuses()).toEqual(["parked"]);
		expect(f.calls()).toEqual(["fork", "createAgent", "adopt", "register", "deliver", "setStatus", "detachSession"]);
		expect(f.service.get(result.jobId)?.status).toBe("completed");
		expect(f.service.list()).toHaveLength(1);
	});

	test("marks a failed run as failed and parks the transcript", async () => {
		const session = fakeSession({
			async prompt() {
				throw new Error("provider boom");
			},
		});
		const f = fixture({
			createAgent: async () => ({ session, sessionFile: null }),
		});
		const result = await f.service.start("work");
		await expect(f.runJob()).rejects.toThrow("provider boom");
		expect(f.service.get(result.jobId)?.status).toBe("failed");
		expect(f.statuses()).toEqual(["parked"]);
	});

	test("leaves an aborted tombstone and marks a cancelled run as cancelled", async () => {
		const aborts: number[] = [];
		const session = fakeSession({
			async abort() {
				aborts.push(1);
			},
		});
		const f = fixture({
			createAgent: async () => ({ session, sessionFile: null }),
		});
		await f.service.start("work");
		const controller = new AbortController();
		controller.abort();
		await expect(f.runJob({ signal: controller.signal })).rejects.toThrow("Aborted before execution");
		expect(f.service.get("job-1")?.status).toBe("cancelled");
		expect(f.statuses()).toEqual(["aborted"]);
		expect(aborts).toHaveLength(0);
		expect(f.calls().slice(-1)).toEqual(["setStatus"]);
	});

	test("never exposes session paths or provider-facing ids", async () => {
		const f = fixture();
		const result = await f.service.start("secret work");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("C:/sessions");
		expect(serialized).not.toContain(".jsonl");
		expect(serialized).not.toContain("parent-session-id");
		expect(serialized).not.toContain("parent-cache-key");
		expect(JSON.stringify(f.service.get(result.jobId))).not.toContain("C:/sessions");
		expect(JSON.stringify(f.service.list())).not.toContain(".jsonl");
		expect(JSON.stringify(f.service.list())).not.toContain("parent-session-id");
	});
});
