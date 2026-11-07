import { StudioRuntimeFeatureService } from "../src/studio/services/runtime-feature-service";
import { StudioRuntimeViews } from "../src/studio/services/runtime-view-service";
import { StudioLiveAudioService } from "../src/studio/services/live-audio-service";
import type { RuntimeViewResultMap } from "../src/studio/runtime-views-protocol";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { IrcBus } from "../src/irc/bus";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { AgentStorage } from "../src/session/agent-storage";
import { CostGate } from "../src/session/cost-gate";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { cfgSessionMaxCost } from "../src/session/settings";
import { type ExecutorOptions, runSubprocess } from "../src/task/executor";
import type { AgentDefinition } from "../src/task/types";
import { RemoteAgentSession } from "../src/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../src/thread/subagent-worker";
import { StudioRuntimeCommandArbiter } from "../src/studio/command-arbiter";
import { StudioInteractionGateway, StudioRemoteInteractionPort } from "../src/studio/services/interaction-port";
import { setStudioThreadInteraction } from "../src/studio/services/studio-thread-service";
import { StudioAgentBtwService } from "../src/studio/services/agent-btw-service";
import { StudioAgentModelService } from "../src/studio/services/agent-model-service";
import { StudioAgentConversationService } from "../src/studio/services/agent-conversation-service";
import { ConversationLiveProjector } from "../src/studio/services/conversation-live-projector";
import type { ConversationRuntimeEvent } from "../src/studio/conversation-protocol";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function text(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
		: "";
}

function response(value: string | { name: string; args: object; id: string }): Response {
	const base = { id: "chatcmpl-studio-test", object: "chat.completion.chunk", created: 0, model: "model" };
	const delta =
		typeof value === "string"
			? { role: "assistant", content: value }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: value.id,
							type: "function",
							function: { name: value.name, arguments: JSON.stringify(value.args) },
						},
					],
				};
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: typeof value === "string" ? "stop" : "tool_calls" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}

async function waitFor(check: () => boolean, label: string, details?: () => unknown): Promise<void> {
	const deadline = Date.now() + 60000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}; ${JSON.stringify(details?.())}`);
		await Bun.sleep(10);
	}
}

test("nine concurrent Studio agents reach native workers and retain conversations, approvals, pause, BTW, jobs, cost and cancellation", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-workers-18180-"));
	const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const saved = envKeys.map(key => [key, process.env[key]] as const);
	const agentDirectory = path.join(directory, "agent"),
		cwd = path.join(directory, "work");
	await fs.mkdir(agentDirectory, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	process.env.HOME = directory;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const held = Array.from({ length: 9 }, () => Promise.withResolvers<void>());
	const seen = new Set<number>();
	const turns = new Map<number, number>();
	let extraRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "model" }] });
			const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> };
			const lastUser = text(body.messages.findLast(message => message.role === "user")?.content);
			if (lastUser.includes("SIDE-18180")) return response("The worker side conversation is isolated.");
			const match = /HOLD-18180-(\d)/u.exec(
				body.messages
					.filter(message => message.role === "user")
					.map(message => text(message.content))
					.join("\n"),
			);
			if (!match) {
				extraRequests++;
				return response("side setup done");
			}
			const index = Number(match[1]);
			const turn = (turns.get(index) ?? 0) + 1;
			turns.set(index, turn);
			if (index === 8 && turn > 5)
				return response(
					"Unexpected tool result: " + text(body.messages.findLast(message => message.role === "tool")?.content),
				);
			if (turn === 1) {
				seen.add(index);
				request.signal.addEventListener("abort", () => held[index]!.resolve(), { once: true });
				await held[index]!.promise;
				if (index === 8)
					return response({
						name: "bash",
						id: "studio-shell",
						args: { command: "printf '你好\\n'; printf '\\377\\376\\n'", async: true },
					});
			} else if (
				index === 8 &&
				!body.messages.some(message => message.role === "tool" && text(message.content).includes("Proceed"))
			) {
				return response({
					name: "ask",
					id: "studio-ask",
					args: {
						questions: [
							{
								id: "check",
								question: "Continue the worker check?",
								options: [{ label: "Proceed" }, { label: "Stop" }],
							},
						],
					},
				});
			}
			return response(`done ${index}`);
		},
	});
	const auth = createInMemoryAuthStorage();
	const modelsPath = path.join(agentDirectory, "models.yml");
	await Bun.write(
		modelsPath,
		`providers:\n  studio-test:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: model\n        name: Studio test\n        reasoning: false\n        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	const registry = new ModelRegistry(auth, modelsPath);
	await registry.refresh();
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": true,
		"display.shellVisualization": true,
		"tools.approvalMode": "always-ask",
		"tools.approval": { bash: "prompt" },
		modelRoles: { default: "studio-test/model" },
	});
	const cost = new CostGate(settings, 0, () => {}),
		jobs = new AsyncJobManager({ maxRunningJobs: 16 });
	const root = new AgentSession({
		agent: new Agent({
			initialState: { model: registry.find("studio-test", "model")!, systemPrompt: [], tools: [] },
			convertToLlm,
		}),
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry: registry,
		asyncJobManager: jobs,
		agentId: MAIN_AGENT_ID,
	});
	const agents = AgentRegistry.global();
	agents.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: root });
	const interaction = new StudioRemoteInteractionPort(
		new StudioRuntimeCommandArbiter(
			() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: true, isCompacting: false }),
			[],
		),
		() => {},
		() => {},
	);
	const gateway = new StudioInteractionGateway();
	gateway.bind(interaction);
	setStudioThreadInteraction(gateway);
	const pool = new SubagentWorkerPool({ maxWorkers: () => 4, idleMs: 600000, worker: { initTimeoutMs: 60000 } });
	setSubagentWorkerPoolForTests(pool);
	const definition: AgentDefinition = {
		name: "studio-worker",
		description: "Studio worker regression",
		source: "bundled",
		tools: ["bash", "ask"],
		systemPrompt: "Execute only the test task.",
	};
	const aborts = Array.from({ length: 9 }, () => new AbortController());
	const options = (index: number): ExecutorOptions => ({
		cwd,
		agent: definition,
		id: `studio-child-${index}`,
		index,
		task: `HOLD-18180-${index}`,
		description: `child ${index}`,
		parentAgentId: MAIN_AGENT_ID,
		taskDepth: 0,
		modelOverride: "studio-test/model",
		structured: false,
		settings,
		authStorage: auth,
		modelRegistry: registry,
		costGate: cost,
		asyncJobManager: jobs,
		enableLsp: false,
		enableMCP: false,
		noContextFiles: true,
		artifactsDir: path.join(directory, "artifacts"),
		signal: aborts[index]!.signal,
	});
	const pending = Array.from({ length: 9 }, (_, index) => runSubprocess(options(index)));
	let workerDone = false,
		workerDetail = "";
	void pending[8]!.then(result => {
		workerDone = true;
		workerDetail = JSON.stringify(result);
	});
	const events: ConversationRuntimeEvent[] = [];
	let projector: ConversationLiveProjector | undefined;
	const btw = new StudioAgentBtwService(root),
		conversation = new StudioAgentConversationService({ registry: agents, runtimeEpoch: () => 1 });
	try {
		await waitFor(() => seen.size === 9, "all nine model requests");
		expect(pool.runsInFlight).toBe(9);
		expect(pool.workers()).toHaveLength(1);
		const worker = agents.get("studio-child-8")?.session;
		expect(worker).toBeInstanceOf(RemoteAgentSession);
		if (!(worker instanceof RemoteAgentSession)) throw new Error("ninth child did not enter the worker path");
		expect(agents.get("studio-child-0")?.session).toBeInstanceOf(AgentSession);
		projector = new ConversationLiveProjector({
			sessionId: worker.sessionId,
			runtimeEpoch: 1,
			reserveMessageId: () => {
				throw new Error("Worker must supply persisted entry identities");
			},
		});
		projector.onEvent(event => events.push(event));
		projector.bind(worker);
		held[8]!.resolve();
		await waitFor(() => interaction.pending()?.request.kind === "approval", "worker bash approval");
		expect(interaction.pending()?.request.commandId).toContain(worker.sessionId);
		agentPauseGate.pause();
		const approval = interaction.pending()!.request;
		interaction.respond({
			kind: "interaction.respond",
			commandId: approval.commandId,
			interactionId: approval.interactionId,
			decision: "submit",
			value: true,
		});
		await waitFor(() => worker.agent.isPaused, "worker pause mirror");
		await waitFor(
			() => jobs.getAllJobs().some(job => job.type === "bash" && job.status === "completed"),
			"worker background shell completion",
		);
		expect(turns.get(8)).toBe(1);
		agentPauseGate.resume();
		await waitFor(
			() => interaction.pending() !== undefined || workerDone,
			"worker Ask after resume",
			() => ({
				turns: turns.get(8),
				extraRequests,
				paused: worker.agent.isPaused,
				streaming: worker.isStreaming,
				tools: worker.messages.filter(message => message.role === "toolResult"),
			}),
		);
		expect(
			interaction.pending()?.request.kind,
			workerDetail + "\n" + JSON.stringify(worker.messages).slice(-12000),
		).toBe("ask");
		const ask = interaction.pending()!.request;
		interaction.respond({
			kind: "interaction.respond",
			commandId: ask.commandId,
			interactionId: ask.interactionId,
			decision: "submit",
			value: { results: [{ id: "check", selectedOptions: ["Proceed"] }] },
		});
		const result = await pending[8]!;
		expect(result.error).toBeUndefined();
		expect(result.output).toBe("done 8");
		expect(jobs.getAllJobs().find(job => job.type === "bash")?.ownerId).toBe("studio-child-8");
		expect(cost.spent).toBeGreaterThan(0);
		const audio = new StudioLiveAudioService(root);
		try {
			const shell = (await new StudioRuntimeViews(root, audio).execute({
				kind: "shell.view.read",
				sessionId: root.sessionId,
				agentId: "studio-child-8",
				toolCallId: "studio-shell",
			})) as RuntimeViewResultMap["shell.view.read"];
			expect(shell.available).toBe(true);
			expect(shell.presentation?.output).toContain("你好");
		} finally {
			audio.dispose();
		}
		await worker.settleInFlightMessagePersistence();
		projector.flush();
		const transcript = await conversation.read({ agentId: "studio-child-8", limit: 50 });
		const persistedIds = new Set(transcript.items.map(item => item.itemId));
		const completed = events.filter(event => event.kind === "conversation.message.completed");
		expect(
			completed.some(event => event.kind === "conversation.message.completed" && event.item.role === "assistant"),
		).toBe(true);
		for (const event of completed)
			if (event.kind === "conversation.message.completed") expect(persistedIds.has(event.item.itemId)).toBe(true);
		expect(
			(
				await new StudioAgentModelService(root).execute({
					kind: "agent.model.inspect",
					sessionId: root.sessionId,
					agentId: "studio-child-8",
				})
			).selectedModel,
		).toBe("studio-test/model");
		await new StudioRuntimeFeatureService(root).execute({
			kind: "session.history.rename",
			sessionId: root.sessionId,
			targetSessionId: worker.sessionId,
			title: "线程内重命名",
		});
		expect(worker.sessionManager.getSessionName()).toBe("线程内重命名");
		const binding = await btw.execute({
			kind: "agent.btw.read",
			sessionId: root.sessionId,
			agentId: "studio-child-8",
		});
		await btw.execute({
			kind: "agent.btw.ask",
			sessionId: root.sessionId,
			agentId: "studio-child-8",
			binding: binding.binding,
			question: "SIDE-18180",
		});
		let side = binding;
		for (let i = 0; i < 200 && side.snapshot?.status !== "completed"; i++) {
			await Bun.sleep(10);
			side = await btw.execute({
				kind: "agent.btw.read",
				sessionId: root.sessionId,
				agentId: "studio-child-8",
				binding: binding.binding,
			});
		}
		expect(side.snapshot?.text).toContain("side conversation is isolated");
		const before = extraRequests;
		cfgSessionMaxCost.override(settings, cost.spent / 2);
		await worker.prompt("BLOCKED-BY-COST-18180").catch(() => false);
		expect(extraRequests).toBe(before);
		cfgSessionMaxCost.override(settings, undefined);
		aborts[0]!.abort();
		held[0]!.resolve();
		const cancelled = await pending[0]!;
		expect(cancelled.exitCode).not.toBe(0);
		for (const gate of held) gate.resolve();
		await Promise.all(pending);
		expect(pool.runsInFlight).toBe(0);
		expect(jobs.getAllJobs().filter(job => job.status === "running")).toEqual([]);
	} finally {
		interaction.cancel();
		agentPauseGate.resume();
		for (const abort of aborts) abort.abort();
		for (const gate of held) gate.resolve();
		await Promise.allSettled(pending);
		projector?.dispose();
		conversation.dispose();
		await btw.dispose();
		await AgentLifecycleManager.global().dispose();
		await root.dispose();
		setStudioThreadInteraction(undefined);
		setSubagentWorkerPoolForTests(undefined);
		pool.dispose();
		server.stop(true);
		await jobs.dispose({ timeoutMs: 1000 });
		auth.close();
		AgentStorage.close();
		closeModelCache();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		await removeWithRetries(directory);
	}
}, 120000);
