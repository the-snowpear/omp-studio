import { describe, expect, test } from "bun:test";
import { StudioBridgeDispatcher } from "@oh-my-pi/pi-coding-agent/studio/bridge-dispatcher";
import type {
	StudioEventEnvelope,
	StudioReceipt,
	StudioRequest,
} from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioInteractionGateway } from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";
import { StudioLiveService } from "@oh-my-pi/pi-coding-agent/studio/services/live-service";
import { StudioLoopService } from "@oh-my-pi/pi-coding-agent/studio/services/loop-service";
import { StudioPauseService } from "@oh-my-pi/pi-coding-agent/studio/services/pause-service";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

class FakeSession {
	isStreaming = false;
	isCompacting = false;
	queuedMessageCount = 0;
	sessionFile: string | undefined = "C:/sessions/current.jsonl";
	followUpCalls = 0;
	steerCalls = 0;
	resetCalls = 0;
	retryCalls = 0;
	abortCalls = 0;
	promptCalls = 0;
	promptError: Error | undefined;
	retryResult = true;
	newSessionCalls = 0;
	waitForIdleCalls = 0;

	getAgentId(): string {
		return "Main";
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls += 1;
	}

	getPlanModeState(): undefined {
		return undefined;
	}

	getGoalModeState(): undefined {
		return undefined;
	}

	getVibeModeState(): undefined {
		return undefined;
	}

	async followUp(): Promise<void> {
		this.followUpCalls += 1;
		this.queuedMessageCount += 1;
	}

	async steer(): Promise<void> {
		this.steerCalls += 1;
		this.queuedMessageCount += 1;
	}

	async prompt(): Promise<void> {
		this.promptCalls += 1;
		if (this.promptError !== undefined) throw this.promptError;
	}

	async resetSessionContext(): Promise<{ droppedCount: number }> {
		this.resetCalls += 1;
		this.queuedMessageCount = 0;
		return { droppedCount: 5 };
	}

	async retry(): Promise<boolean> {
		this.retryCalls += 1;
		if (this.retryResult) this.isStreaming = true;
		return this.retryResult;
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
		this.isStreaming = false;
	}

	async newSession(options?: { drop?: boolean }): Promise<boolean> {
		if (options?.drop !== true) throw new Error("Expected destructive session transition");
		this.newSessionCalls += 1;
		return true;
	}
}

function fakeLoopService(): StudioLoopService {
	return new StudioLoopService({
		action: () => "prompt",
		isBlocked: () => false,
		isVibeActive: () => false,
		submitPrompt: () => {},
		compact: () => {},
		reset: () => {},
		nowMs: Date.now,
		setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
	});
}

function fixture() {
	const session = new FakeSession();
	const serviceCalls: string[] = [];
	let shutdownRequests = 0;
	const modes = {
		state: () => ({}),
		onChange: () => () => {},
		dispose: () => {},
		enterPlan: async () => {
			serviceCalls.push("mode.plan.enter");
			return { plan: { status: "active" } };
		},
		exitPlan: async () => ({}),
		openPlanReview: async () => ({}),
		respondPlanReview: async () => ({}),
		enterVibe: async () => ({}),
		exitVibe: async () => ({ killed: 0, state: {} }),
		createGoal: async () => ({}),
		replaceGoal: async () => ({}),
		setGoalBudget: async () => ({}),
		pauseGoal: async () => ({}),
		resumeGoal: async () => ({}),
		dropGoal: async () => ({}),
		startGuidedGoal: async () => ({ started: true }),
		applyPending: async () => {
			serviceCalls.push("mode.applyPending");
		},
	};
	const models = {
		state: () => undefined,
		// The projector reads the Task subagent pill and subscribes to switches:
		// a partial `models` fake would throw while building any snapshot.
		taskState: () => undefined,
		onChange: () => () => {},
		applyPending: async () => {
			serviceCalls.push("session.model.applyPending");
		},
	};
	const permissions = {
		state: () => "yolo" as const,
		applyPending: async () => {
			serviceCalls.push("permissions.applyPending");
		},
	};
	const runtime = {
		runtimeId: "runtime-control-test",
		runtimeEpoch: 7,
		sessionId: "session-control-test",
		session,
		waitForShutdown: () => new Promise<void>(() => {}),
		requestShutdown: () => {
			shutdownRequests += 1;
		},
		services: {
			live: new StudioLiveService(),
			pause: new StudioPauseService(),
			loop: fakeLoopService(),
			modes,
			models,
			permissions,
			tree: {
				getTree: () => {
					serviceCalls.push("session.tree.get");
					return { leafId: null, roots: [] };
				},
				navigate: async (commandId: string) => {
					serviceCalls.push(`session.tree.navigate:${commandId}`);
					return {};
				},
				branch: async (commandId: string) => {
					serviceCalls.push(`session.tree.branch:${commandId}`);
					return { cancelled: false, sessionId: "branched-session", editorText: "hello" };
				},
			},
			fork: {
				fork: async () => {
					serviceCalls.push("session.fork");
					return { forked: true, sessionId: "session-control-test" };
				},
			},
			commands: {
				manifest: () => {
					serviceCalls.push("operator.manifest.get");
					return {
						generatedAt: "1970-01-01T00:00:00.000Z",
						upstreamCommit: "test-upstream",
						hash: "sha256:test-commands",
						commands: [],
						unclassifiedBuiltins: [],
					};
				},
				manifestHash: () => "sha256:test-commands",
				invoke: async (commandId: string, args: unknown) => {
					serviceCalls.push(`operator.invoke:${commandId}`);
					return { commandId, args };
				},
			},
			btw: {
				onChange: () => () => {},
				ask: (question: string) => {
					serviceCalls.push("btw.ask");
					return { ephemeralId: "ephemeral-test", branchToken: "branch-test", status: "running", question };
				},
				abort: (ephemeralId: string) => {
					serviceCalls.push("btw.abort");
					return { aborted: true, ephemeralId };
				},
				branchCurrent: async (branchToken: string) => {
					serviceCalls.push("btw.branch");
					return { branched: true, branchToken };
				},
			},
			interaction: new StudioInteractionGateway(),
			tan: {
				start: async (work: string) => {
					serviceCalls.push("tan.start");
					return { jobId: "job-tan", agentId: "agent-tan", status: "running", work };
				},
			},
			omfg: {
				generate: async (complaint: string) => {
					serviceCalls.push("omfg.generate");
					return { candidateId: "candidate-1", complaint };
				},
				amend: async (candidateId: string, feedback: string) => {
					serviceCalls.push("omfg.amend");
					return { candidateId, feedback };
				},
				commit: async (candidateId: string, scope: string, overwrite: boolean) => {
					serviceCalls.push("omfg.commit");
					return { committed: true, candidateId, scope, overwrite };
				},
			},
			agents: {
				onChange: () => () => {},
				list: () => [],
				get: (agentId: string) => ({ agentId }),
				spawn: async (operation: { definition: string }) => ({
					agentId: `agent-${operation.definition}`,
					status: "starting",
				}),
				send: async (operation: { agentId: string }) => ({ delivered: true, agentId: operation.agentId }),
				kill: async (operation: { agentId: string }) => ({ killed: true, agentId: operation.agentId }),
				revive: async (operation: { agentId: string }) => ({ revived: true, agentId: operation.agentId }),
				release: async (operation: { agentId: string }) => ({ released: true, agentId: operation.agentId }),
				readTranscript: async (operation: { agentId: string }) => ({
					agentId: operation.agentId,
					cursor: "cursor-test",
					messages: [],
					eof: true,
				}),
			},
			jobs: {
				list: () => [],
				get: (jobId: string) => ({ jobId }),
				cancel: async (operation: { jobId: string }) => ({ cancelled: true, jobId: operation.jobId }),
			},
		},
	} as unknown as StudioHostRuntime;
	const projector = new StudioStateProjector(runtime);
	const frames: Array<{
		frameId: string;
		body: StudioReceipt | StudioEventEnvelope | ReturnType<StudioStateProjector["response"]>;
	}> = [];
	const events: Array<{ eventSeq: number; stateVersion: number; snapshot: Record<string, unknown> }> = [];
	const allEvents: StudioEventEnvelope[] = [];
	projector.onEvent(event => {
		allEvents.push(event);
		if (event.event.kind !== "state.changed") return;
		events.push({
			eventSeq: event.eventSeq,
			stateVersion: event.stateVersion,
			snapshot: event.event.snapshot as unknown as Record<string, unknown>,
		});
	});
	const dispatcher = new StudioBridgeDispatcher(runtime, projector, (frameId, body) => {
		frames.push({ frameId, body });
	});
	const request = (
		requestId: string,
		operation: StudioRequest["operation"],
		extra: Partial<StudioRequest> = {},
	): StudioRequest => ({
		type: "studio.request",
		requestId,
		runtimeEpoch: 7,
		operation,
		...extra,
	});
	return {
		session,
		projector,
		frames,
		events,
		allEvents,
		dispatcher,
		request,
		serviceCalls,
		shutdownRequests: () => shutdownRequests,
	};
}

describe("WP-021/022/023/024/025 Studio Bridge dispatcher", () => {
	test("queue.enqueue produces accepted+completed receipts, commits truthful state, and replays idempotently", async () => {
		const { session, projector, frames, events, dispatcher, request } = fixture();
		await dispatcher.dispatch(
			request("enqueue-one", { kind: "queue.enqueue", text: "run the checks" }, { idempotencyKey: "enqueue-key" }),
		);
		expect(session.followUpCalls).toBe(1);
		expect(projector.stateVersion).toBe(1);
		expect(frames.map(frame => (frame.body as StudioReceipt).status)).toEqual(["accepted", "completed"]);
		expect((frames[1]!.body as StudioReceipt).result).toEqual({ queued: true, pendingMessages: 1 });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ eventSeq: 1, stateVersion: 1 });
		expect(events[0]!.snapshot).toMatchObject({ isStreaming: false, pendingMessages: 1 });

		await dispatcher.dispatch(
			request(
				"enqueue-replay",
				{ kind: "queue.enqueue", text: "run the checks" },
				{ idempotencyKey: "enqueue-key" },
			),
		);
		expect(session.followUpCalls).toBe(1);
		expect(frames.at(-1)!.body).toMatchObject({ status: "completed", requestId: "enqueue-replay" });
		expect(projector.stateVersion).toBe(1);
	});

	test("session.clearContext while streaming fails with BUSY_STREAMING without mutating", async () => {
		const { session, projector, frames, dispatcher, request } = fixture();
		session.isStreaming = true;
		await dispatcher.dispatch(request("clear-busy", { kind: "session.clearContext" }));
		expect(session.resetCalls).toBe(0);
		expect(projector.stateVersion).toBe(0);
		expect(frames.map(frame => (frame.body as StudioReceipt).status)).toEqual(["accepted", "failed"]);
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({ code: "BUSY_STREAMING" });
	});

	test("mode.plan.exit while streaming completes so the next user turn can leave Plan", async () => {
		const { session, frames, dispatcher, request } = fixture();
		session.isStreaming = true;
		await dispatcher.dispatch(request("plan-exit-busy", { kind: "mode.plan.exit", discardDraft: true }));
		expect(frames.map(frame => (frame.body as StudioReceipt).status)).toEqual(["accepted", "completed"]);
	});

	test("core.steer applies deferred model, mode, and approval preferences before queuing", async () => {
		const { session, serviceCalls, dispatcher, request } = fixture();
		session.isStreaming = true;
		await dispatcher.dispatch(request("steer-one", { kind: "core.steer", text: "use plan instead" }));
		expect(serviceCalls).toEqual(["session.model.applyPending", "mode.applyPending", "permissions.applyPending"]);
		expect(session.steerCalls).toBe(1);
	});

	test("turn.retry with nothing to retry completes with an explicit result and no state bump", async () => {
		const { session, projector, frames, events, dispatcher, request } = fixture();
		session.retryResult = false;
		await dispatcher.dispatch(request("retry-none", { kind: "turn.retry" }));
		expect(session.retryCalls).toBe(1);
		expect(frames.at(-1)!.body as StudioReceipt).toMatchObject({
			status: "completed",
			result: { retried: false, reason: "nothing_to_retry" },
		});
		expect(projector.stateVersion).toBe(0);
		expect(events).toHaveLength(0);
	});

	test("turn.retry with a failed tail commits the started retry state", async () => {
		const { session, projector, events, dispatcher, request } = fixture();
		session.retryResult = true;
		await dispatcher.dispatch(request("retry-one", { kind: "turn.retry" }));
		expect(session.retryCalls).toBe(1);
		expect(projector.stateVersion).toBe(1);
		expect(events).toHaveLength(1);
	});

	test("session.drop waits for a destructive interaction and executes only after explicit approval", async () => {
		const { session, projector, frames, allEvents, dispatcher, request } = fixture();
		const drop = request("drop-one", { kind: "session.drop" }, { idempotencyKey: "drop-key" });
		const pendingDrop = dispatcher.dispatch(drop);
		await Promise.resolve();
		const interactionEvent = allEvents.find(event => event.event.kind === "interaction.required");
		expect(interactionEvent?.event).toMatchObject({
			kind: "interaction.required",
			owner: "gui",
			request: { kind: "confirm", destructive: true, title: "Drop session" },
		});
		if (interactionEvent?.event.kind !== "interaction.required") throw new Error("Missing interaction event");
		expect(session.newSessionCalls).toBe(0);
		await dispatcher.dispatch(
			request("drop-response", {
				kind: "interaction.respond",
				interactionId: interactionEvent.event.request.interactionId,
				commandId: interactionEvent.event.request.commandId,
				decision: "submit",
				value: true,
			}),
		);
		await pendingDrop;
		expect(session.newSessionCalls).toBe(1);
		expect(projector.snapshot().pendingInteraction).toBeUndefined();

		await dispatcher.dispatch(drop);
		expect(frames.at(-1)!.frameId).toBe("receipt-replay:drop-one");
		expect(projector.response("snapshot").terminalReceipts).toHaveLength(1);
	});

	test("unknown operations fail closed with COMMAND_UNKNOWN", async () => {
		const { frames, dispatcher, request } = fixture();
		await dispatcher.dispatch(
			request("unknown-one", { kind: "operator.unknown" } as unknown as StudioRequest["operation"], {
				idempotencyKey: "unknown-key",
			}),
		);
		expect(frames.map(frame => (frame.body as StudioReceipt).status)).toEqual(["rejected"]);
		expect((frames[0]!.body as StudioReceipt).error).toMatchObject({ code: "COMMAND_UNKNOWN" });

		await dispatcher.dispatch(
			request("unknown-conflict", { kind: "session.drop" }, { idempotencyKey: "unknown-key" }),
		);
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({
			code: "INVALID_ARGUMENT",
			details: { reason: "IDEMPOTENCY_CONFLICT" },
		});

		await dispatcher.dispatch(
			request("unknown-replay", { kind: "operator.unknown" } as unknown as StudioRequest["operation"], {
				idempotencyKey: "unknown-key",
			}),
		);
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({ code: "COMMAND_UNKNOWN" });
	});

	test("stale runtime epochs are rejected by the arbiter", async () => {
		const { frames, dispatcher, request } = fixture();
		await dispatcher.dispatch({ ...request("stale-one", { kind: "queue.enqueue", text: "x" }), runtimeEpoch: 6 });
		expect(frames.map(frame => (frame.body as StudioReceipt).status)).toEqual(["rejected"]);
		expect((frames[0]!.body as StudioReceipt).error).toMatchObject({ code: "RUNTIME_EPOCH_STALE" });
	});

	test("loop enable, pause, disable, and replay share one projected state", async () => {
		const { session, projector, frames, dispatcher, request } = fixture();
		await dispatcher.dispatch(
			request(
				"loop-enable",
				{ kind: "loop.enable", prompt: "repeat this", limit: { turns: 3 } },
				{
					idempotencyKey: "loop-key",
				},
			),
		);
		expect(session.promptCalls).toBe(1);
		expect(projector.snapshot().loop).toEqual({ status: "running", prompt: "repeat this" });
		expect(projector.stateVersion).toBe(1);

		await dispatcher.dispatch(
			request(
				"loop-replay",
				{ kind: "loop.enable", prompt: "repeat this", limit: { turns: 3 } },
				{
					idempotencyKey: "loop-key",
				},
			),
		);
		expect(session.promptCalls).toBe(1);
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");

		await dispatcher.dispatch(request("loop-pause", { kind: "loop.pause" }));
		expect(projector.snapshot().loop).toEqual({ status: "paused" });
		await dispatcher.dispatch(request("loop-disable", { kind: "loop.disable" }));
		expect(projector.snapshot().loop).toBeUndefined();
		expect(projector.stateVersion).toBe(3);
	});

	test("loop enable rolls back when its initial prompt fails", async () => {
		const { session, projector, frames, dispatcher, request } = fixture();
		session.promptError = new Error("prompt failed");
		await dispatcher.dispatch(request("loop-prompt-failed", { kind: "loop.enable", prompt: "repeat this" }));
		expect(projector.snapshot().loop).toBeUndefined();
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("failed");
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({ code: "INTERNAL_ERROR" });
	});

	test("loop token limits fail closed without changing projected state", async () => {
		const { projector, frames, dispatcher, request } = fixture();
		await dispatcher.dispatch(request("loop-token-limit", { kind: "loop.enable", limit: { tokens: 100 } }));
		expect(projector.snapshot().loop).toBeUndefined();
		expect(projector.stateVersion).toBe(0);
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({ code: "INVALID_ARGUMENT" });
	});

	test("M3 mode, tree, and fork operations route through Runtime-owned services", async () => {
		const { dispatcher, frames, request, serviceCalls } = fixture();
		await dispatcher.dispatch(request("plan-enter", { kind: "mode.plan.enter" }));
		await dispatcher.dispatch(request("tree-get", { kind: "session.tree.get" }));
		await dispatcher.dispatch(request("session-fork", { kind: "session.fork" }));
		expect(serviceCalls).toEqual(["mode.plan.enter", "session.tree.get", "session.fork"]);
		expect(frames.filter(frame => (frame.body as StudioReceipt).status === "completed")).toHaveLength(3);
		expect((frames.at(-1)!.body as StudioReceipt).result).toEqual({
			forked: true,
			sessionId: "session-control-test",
		});
	});

	test("tree navigation receives the arbiter command id used by remote interactions", async () => {
		const { dispatcher, frames, request, serviceCalls } = fixture();
		await dispatcher.dispatch(request("tree-navigate", { kind: "session.tree.navigate", targetId: "entry-1" }));
		const accepted = frames.find(frame => (frame.body as StudioReceipt).status === "accepted")?.body as StudioReceipt;
		expect(serviceCalls).toContain(`session.tree.navigate:${accepted.commandId}`);
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
	});

	test("tree branch receives the arbiter command id and returns the new session fill-back", async () => {
		const { dispatcher, frames, request, serviceCalls } = fixture();
		await dispatcher.dispatch(request("tree-branch", { kind: "session.tree.branch", targetId: "entry-1" }));
		const accepted = frames.find(frame => (frame.body as StudioReceipt).status === "accepted")?.body as StudioReceipt;
		expect(serviceCalls).toContain(`session.tree.branch:${accepted.commandId}`);
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
		expect((frames.at(-1)!.body as StudioReceipt).result).toEqual({
			cancelled: false,
			sessionId: "branched-session",
			editorText: "hello",
		});
	});

	test("operator manifest and invocation route through the Runtime command service", async () => {
		const { dispatcher, frames, request, serviceCalls } = fixture();
		await dispatcher.dispatch(request("manifest-get", { kind: "operator.manifest.get" }));
		await dispatcher.dispatch(
			request("operator-invoke", { kind: "operator.invoke", commandId: "builtin.force", arguments: "tool prompt" }),
		);
		expect(serviceCalls).toEqual(["operator.manifest.get", "operator.invoke:builtin.force"]);
		expect(frames.filter(frame => (frame.body as StudioReceipt).status === "completed")).toHaveLength(2);
		expect((frames[1]!.body as StudioReceipt).result).toMatchObject({
			hash: "sha256:test-commands",
			unclassifiedBuiltins: [],
		});
		expect((frames.at(-1)!.body as StudioReceipt).result).toEqual({
			commandId: "builtin.force",
			args: "tool prompt",
		});
	});

	test("context-rewriting commands push refreshed telemetry without a conversation turn", async () => {
		const { session, dispatcher, frames, allEvents, request } = fixture();
		let usedTokens = 20;
		Object.assign(session, {
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}),
			getContextBreakdown: () => ({
				contextWindow: 100,
				anchored: false,
				usedTokens,
				systemPromptTokens: 0,
				systemContextTokens: 0,
				systemToolsTokens: 0,
				skillsTokens: 0,
				messagesTokens: usedTokens,
			}),
		});
		const telemetryEvents = () =>
			allEvents
				.filter(event => event.event.kind === "session.telemetry.changed")
				.map(event =>
					event.event.kind === "session.telemetry.changed" ? event.event.telemetry.context?.percent : undefined,
				);

		// Manual compact finishes without AgentSessionEvents, so the dispatcher
		// must refresh the projector's cached telemetry itself.
		await dispatcher.dispatch(request("compact-one", { kind: "operator.invoke", commandId: "builtin.compact" }));
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
		expect(telemetryEvents()).toEqual([20]);

		// /clear rewrites the context in place too.
		usedTokens = 0;
		await dispatcher.dispatch(request("clear-one", { kind: "session.clearContext" }));
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
		expect(telemetryEvents()).toEqual([20, 0]);

		// Ordinary operator commands must not spam extra telemetry pushes.
		await dispatcher.dispatch(request("force-one", { kind: "operator.invoke", commandId: "builtin.force" }));
		expect((frames.at(-1)!.body as StudioReceipt).status).toBe("completed");
		expect(telemetryEvents()).toEqual([20, 0]);
	});

	test("BTW operations route through the Runtime-owned side-channel service", async () => {
		const { dispatcher, frames, request, serviceCalls } = fixture();
		await dispatcher.dispatch(request("btw-ask", { kind: "btw.ask", question: "why?" }));
		await dispatcher.dispatch(request("btw-abort", { kind: "btw.abort", ephemeralId: "ephemeral-test" }));
		await dispatcher.dispatch(request("btw-branch", { kind: "btw.branch", branchToken: "branch-test" }));
		expect(serviceCalls).toEqual(["btw.ask", "btw.abort", "btw.branch"]);
		expect(frames.filter(frame => (frame.body as StudioReceipt).status === "completed")).toHaveLength(3);
	});

	test("TAN and OMFG operations route through Runtime-owned composite services", async () => {
		const { dispatcher, frames, request, serviceCalls } = fixture();
		await dispatcher.dispatch(request("tan-start", { kind: "tan.start", work: "review tests" }));
		await dispatcher.dispatch(request("omfg-generate", { kind: "omfg.generate", complaint: "avoid this" }));
		await dispatcher.dispatch(
			request("omfg-amend", { kind: "omfg.amend", candidateId: "candidate-1", feedback: "narrow it" }),
		);
		await dispatcher.dispatch(
			request("omfg-commit", {
				kind: "omfg.commit",
				candidateId: "candidate-1",
				scope: "project",
				overwrite: false,
			}),
		);
		expect(serviceCalls).toEqual(["tan.start", "omfg.generate", "omfg.amend", "omfg.commit"]);
		expect(frames.filter(frame => (frame.body as StudioReceipt).status === "completed")).toHaveLength(4);
	});

	test("Agent Hub and Job operations route with Runtime caller identity", async () => {
		const { dispatcher, frames, request } = fixture();
		await dispatcher.dispatch(request("agent-list", { kind: "agent.list", includePersisted: true }));
		await dispatcher.dispatch(request("agent-get", { kind: "agent.get", agentId: "Child-1" }));
		await dispatcher.dispatch(
			request("agent-spawn", { kind: "agent.spawn", definition: "researcher", assignment: "audit", async: true }),
		);
		await dispatcher.dispatch(
			request("agent-send", {
				kind: "agent.send",
				agentId: "Child-1",
				expectedGeneration: 1,
				text: "continue",
				mode: "followUp",
			}),
		);
		await dispatcher.dispatch(request("agent-transcript", { kind: "agent.transcript.read", agentId: "Child-1" }));
		await dispatcher.dispatch(request("agent-subscribe", { kind: "agent.subscribe", level: "events" }));
		await dispatcher.dispatch(request("job-list", { kind: "job.list", includeRecent: true }));
		await dispatcher.dispatch(request("job-get", { kind: "job.get", jobId: "job-1" }));
		await dispatcher.dispatch(request("job-cancel", { kind: "job.cancel", jobId: "job-1", expectedGeneration: 1 }));
		await dispatcher.dispatch(request("job-subscribe", { kind: "job.subscribe" }));

		const completed = frames.filter(frame => (frame.body as StudioReceipt).status === "completed");
		expect(completed).toHaveLength(10);
		expect((completed[2]!.body as StudioReceipt).result).toEqual({
			agentId: "agent-researcher",
			status: "starting",
		});
		expect((completed[8]!.body as StudioReceipt).result).toEqual({ cancelled: true, jobId: "job-1" });
	});

	test("Live control fails start closed without media and keeps stop idempotent", async () => {
		const { dispatcher, frames, request } = fixture();
		await dispatcher.dispatch(request("live-start", { kind: "live.start", deviceId: "microphone-1" }));
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({
			code: "CAPABILITY_UNAVAILABLE",
			details: { reason: "MEDIA_SIDEBAND_UNAVAILABLE" },
		});
		await dispatcher.dispatch(request("live-stop", { kind: "live.stop" }));
		expect((frames.at(-1)!.body as StudioReceipt).result).toEqual({ stopped: false });
	});

	test("runtime.shutdown quiesces, drains, emits shutdownComplete, and blocks later commands", async () => {
		const { dispatcher, frames, request, allEvents, session, shutdownRequests } = fixture();
		await dispatcher.dispatch(request("runtime-shutdown", { kind: "runtime.shutdown", drain: true }));
		await Promise.resolve();

		expect(session.waitForIdleCalls).toBe(1);
		expect((frames.at(-1)!.body as StudioReceipt).result).toEqual({ drained: true });
		expect(allEvents.map(event => event.event.kind)).toEqual(["runtime.quiescing", "runtime.shutdownComplete"]);
		expect(shutdownRequests()).toBe(1);

		await dispatcher.dispatch(request("after-shutdown", { kind: "queue.enqueue", text: "too late" }));
		expect((frames.at(-1)!.body as StudioReceipt).error).toMatchObject({ code: "COMMAND_BLOCKED" });
	});
});
