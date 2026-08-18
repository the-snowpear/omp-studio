import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseStudioRequest } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import {
	StudioModeControlService,
	StudioModeError,
} from "@oh-my-pi/pi-coding-agent/studio/services/mode-control-service";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("WP-030/031/032 StudioModeControlService", () => {
	let authStorage: AuthStorage;
	let service: StudioModeControlService;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-studio-modes-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		service = new StudioModeControlService(session);
	});

	afterEach(async () => {
		service.dispose();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function armPlanReview(): Promise<{ planFilePath: string; body: string }> {
		const body = "# Demo plan\n\nNo-op review body.";
		const planFilePath = "local://demo-plan.md";
		await Bun.write(
			resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			}),
			body,
		);
		await service.enterPlan();
		const handler = session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected Plan proposal handler");
		await handler("demo");
		expect(service.state().plan).toMatchObject({ status: "review", planFilePath, title: "demo" });
		return { planFilePath, body };
	}

	test("Plan is Runtime-owned, conflict-fenced, and requires explicit draft discard", async () => {
		const states: unknown[] = [];
		service.onChange(state => states.push(state));
		await service.enterPlan();
		expect(service.state().plan).toMatchObject({ status: "active", planFilePath: "local://PLAN.md" });
		expect(session.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		await expect(service.createGoal("conflicting goal")).rejects.toBeInstanceOf(StudioModeError);
		await expect(service.exitPlan()).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
		await service.exitPlan(true);
		expect(service.state().plan).toBeUndefined();
		expect(states.length).toBeGreaterThanOrEqual(2);
	});

	test("Plan switches to the configured role model and restores the pre-Plan model", async () => {
		const previous = session.model;
		const planModel = new ModelRegistry(authStorage).find("anthropic", "claude-opus-4-6");
		if (!previous || !planModel) throw new Error("Expected bundled Plan test models");
		session.settings.setModelRole("plan", `${planModel.provider}/${planModel.id}`);
		await service.enterPlan();
		expect(session.model?.id).toBe(planModel.id);
		await service.exitPlan(true);
		expect(session.model?.id).toBe(previous.id);
	});

	test("Plan applies an explicit thinking level without resetting the same model", async () => {
		const current = session.model;
		if (!current) throw new Error("Expected current test model");
		session.settings.setModelRole("plan", `${current.provider}/${current.id}:off`);
		await service.enterPlan();
		expect(session.configuredThinkingLevel()).toBe("off");
		await service.exitPlan(true);
		expect(session.configuredThinkingLevel()).not.toBe("off");
	});

	test("Plan defers a streaming role-model switch until the Runtime is idle", async () => {
		const planModel = new ModelRegistry(authStorage).find("anthropic", "claude-opus-4-6");
		if (!planModel) throw new Error("Expected bundled Plan test model");
		session.settings.setModelRole("plan", `${planModel.provider}/${planModel.id}`);
		session.agent.state.isStreaming = true;
		await service.enterPlan();
		expect(session.getPlanModeState()).toBeUndefined();
		expect(service.state().plan).toMatchObject({ status: "active", planFilePath: "local://PLAN.md" });
		expect(session.model?.id).not.toBe(planModel.id);
		session.agent.state.isStreaming = false;
		await service.applyPending();
		expect(session.getPlanModeState()).toMatchObject({ enabled: true });
		expect(session.model?.id).toBe(planModel.id);
	});

	test("Plan projects a streaming enter and only mutates tools on applyPending", async () => {
		const before = session.getEnabledToolNames();
		session.agent.state.isStreaming = true;
		await service.enterPlan();
		expect(session.getEnabledToolNames()).toEqual(before);
		expect(session.getPlanModeState()).toBeUndefined();
		await service.exitPlan(true);
		expect(service.state().plan).toBeUndefined();
		await service.enterPlan();
		session.agent.state.isStreaming = false;
		await service.applyPending();
		expect(session.getPlanModeState()).toMatchObject({ enabled: true });
		await service.exitPlan(true);
		expect(session.getPlanModeState()).toBeUndefined();
	});

	test("Plan applyPending runs on agent_end once the Runtime is idle", async () => {
		session.agent.state.isStreaming = true;
		await service.enterPlan();
		expect(session.getPlanModeState()).toBeUndefined();
		expect(service.state().plan).toMatchObject({ status: "active" });
		session.agent.state.isStreaming = false;
		session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(session.getPlanModeState()).toMatchObject({ enabled: true });
	});

	test("Plan proposal reaches review before the successful propose tool triggers the internal abort", async () => {
		const body = "# Demo plan\n\nNo-op review body.";
		const planFilePath = "local://demo-plan.md";
		await Bun.write(
			resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			}),
			body,
		);
		const abort = mock(async () => {});
		session.abort = abort;
		await service.enterPlan();
		const handler = session.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected Plan proposal handler");

		const proposal = await handler("demo");
		expect(abort).toHaveBeenCalledTimes(0);
		expect(proposal.details).toMatchObject({ planFilePath, title: "demo", planExists: true, planContent: body });
		expect(service.state().plan).toMatchObject({ status: "review", planFilePath, title: "demo", body });

		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "proposal",
			toolName: "write",
			result: {
				content: proposal.content,
				details: {
					xdev: {
						tool: PROPOSE_DEVICE_NAME,
						mode: "execute",
						args: { title: "demo" },
						inner: proposal.details,
					},
				},
			},
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(abort).toHaveBeenCalledTimes(1);
	});

	test("Goal create, budget, pause, resume, and drop preserve one state source", async () => {
		await service.createGoal("ship the backend", 1_000);
		expect(service.state().goal).toMatchObject({
			status: "active",
			objective: "ship the backend",
			tokenBudget: 1_000,
		});
		await service.setGoalBudget(2_000);
		expect(service.state().goal?.tokenBudget).toBe(2_000);
		await service.pauseGoal();
		expect(service.state().goal?.status).toBe("paused");
		await service.resumeGoal();
		expect(service.state().goal?.status).toBe("active");
		await service.dropGoal();
		expect(service.state().goal).toBeUndefined();
	});

	test("openPlanReview fails closed when Plan mode is not active", async () => {
		await expect(service.openPlanReview()).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
			message: "Plan mode is not active",
		});
	});

	test("Approve and keep context preserves history and does not compact", async () => {
		const { planFilePath } = await armPlanReview();
		const compact = mock(async () => ({ summary: "unused", firstKeptEntryId: "e1", tokensBefore: 1 }));
		const reset = mock(async () => ({ droppedCount: 1 }));
		const prompted: string[] = [];
		session.compact = compact;
		session.resetSessionContext = reset;
		session.prompt = mock(async (text: string) => {
			prompted.push(text);
			return true;
		});

		const result = await service.respondPlanReview("keep");
		expect(result).toMatchObject({ decision: "keep", dispatched: true, planFilePath });
		expect(compact).toHaveBeenCalledTimes(0);
		expect(reset).toHaveBeenCalledTimes(0);
		expect(prompted[0] ?? "").toContain("History usable");
		expect(prompted[0] ?? "").toContain(planFilePath);
	});

	test("legacy approve is keep-context", async () => {
		await armPlanReview();
		const compact = mock(async () => ({ summary: "unused", firstKeptEntryId: "e1", tokensBefore: 1 }));
		session.compact = compact;
		session.prompt = mock(async () => true);
		const result = await service.respondPlanReview("approve");
		expect(result).toMatchObject({ decision: "keep", dispatched: true });
		expect(compact).toHaveBeenCalledTimes(0);
	});

	test("Approve and execute clears context without compacting", async () => {
		await armPlanReview();
		const compact = mock(async () => ({ summary: "unused", firstKeptEntryId: "e1", tokensBefore: 1 }));
		const reset = mock(async () => ({ droppedCount: 4 }));
		const prompted: string[] = [];
		session.compact = compact;
		session.resetSessionContext = reset;
		session.prompt = mock(async (text: string) => {
			prompted.push(text);
			return true;
		});

		const result = await service.respondPlanReview("execute");
		expect(result).toMatchObject({ decision: "execute", dispatched: true });
		expect(reset).toHaveBeenCalledTimes(1);
		expect(compact).toHaveBeenCalledTimes(0);
		expect(prompted[0] ?? "").not.toContain("History usable");
	});

	test("Approve and compact context distills history before the execution turn", async () => {
		const { planFilePath } = await armPlanReview();
		const compact = mock(async (_instructions?: string, options?: { internalGuidance?: string }) => {
			expect(options?.internalGuidance ?? "").toContain(planFilePath);
			return { summary: "distilled", firstKeptEntryId: "e1", tokensBefore: 12 };
		});
		const reset = mock(async () => ({ droppedCount: 1 }));
		session.compact = compact;
		session.resetSessionContext = reset;
		session.prompt = mock(async () => true);

		const result = await service.respondPlanReview("compact");
		expect(result).toMatchObject({ decision: "compact", dispatched: true, planFilePath });
		expect(compact).toHaveBeenCalledTimes(1);
		expect(reset).toHaveBeenCalledTimes(0);
	});

	test("Approve and compact context skips the execution turn when compaction is cancelled", async () => {
		await armPlanReview();
		session.compact = mock(async () => {
			throw new CompactionCancelledError();
		});
		const promptFn = mock(async () => true);
		session.prompt = promptFn;

		const result = await service.respondPlanReview("compact");
		expect(result).toMatchObject({ decision: "compact", dispatched: false, reason: "compaction_cancelled" });
		expect(promptFn).toHaveBeenCalledTimes(0);
	});

	test("Approve and compact context still executes when compaction fails", async () => {
		await armPlanReview();
		session.compact = mock(async () => {
			throw new Error("Nothing to compact (session too small)");
		});
		const promptFn = mock(async () => true);
		session.prompt = promptFn;

		const result = await service.respondPlanReview("compact");
		expect(result).toMatchObject({ decision: "compact", dispatched: true });
		expect(promptFn).toHaveBeenCalledTimes(1);
	});

	test("the Runtime mirror parser accepts M3 operations and rejects unknown fields", () => {
		const base = { type: "studio.request", requestId: "m3-op", runtimeEpoch: 1 };
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "session.tree.navigate", targetId: "entry-1", summarize: true },
			}).operation.kind,
		).toBe("session.tree.navigate");
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "session.tree.branch", targetId: "entry-1" },
			}).operation.kind,
		).toBe("session.tree.branch");
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "mode.plan.review.respond", decision: "compact" },
			}).operation,
		).toMatchObject({ kind: "mode.plan.review.respond", decision: "compact" });
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "mode.plan.review.respond", decision: "execute" },
			}).operation,
		).toMatchObject({ kind: "mode.plan.review.respond", decision: "execute" });
		expect(() =>
			parseStudioRequest({ ...base, operation: { kind: "mode.plan.review.respond", decision: "maybe" } }),
		).toThrow();
		expect(() =>
			parseStudioRequest({ ...base, operation: { kind: "goal.create", objective: "ship", surprise: true } }),
		).toThrow();
	});
});
