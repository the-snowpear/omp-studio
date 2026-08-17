import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { onModelRolesChanged } from "../../config/settings";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { resolvePlanModelTransition } from "../../plan-mode/model-transition";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planModeApprovedPrompt from "../../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";
import { PROPOSE_DEVICE_NAME, writeDeviceDispatch } from "../../tools/resolve";
import { type VibeOwnerScope, type VibeParentSession, VibeSessionRegistry } from "../../vibe/runtime";

export class StudioModeError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "COMMAND_BLOCKED" | "MODE_CONFLICT" | "INTERACTION_REQUIRED",
		message: string,
	) {
		super(message);
		this.name = "StudioModeError";
	}
}

export interface StudioModeState {
	plan?: { status: "active" | "paused" | "off" | "review"; planFilePath?: string; title?: string; body?: string };
	goal?: {
		status: "active" | "paused" | "complete" | "off";
		objective?: string;
		tokenBudget?: number;
		tokensUsed?: number;
	};
	vibe?: { enabled: boolean; workerAgentIds: string[] };
}

export type StudioModeChangeListener = (state: StudioModeState) => void;

type PendingSessionMode =
	| { kind: "normal" }
	| { kind: "plan"; initialPrompt?: string }
	| { kind: "goal"; objective: string; tokenBudget?: number }
	| { kind: "vibe"; initialPrompt?: string };

const DEFAULT_PLAN_FILE = "local://PLAN.md";

/** Runtime-owned Plan/Goal/Vibe transitions shared by Bridge and presentation adapters. */
export class StudioModeControlService {
	readonly #listeners = new Set<StudioModeChangeListener>();
	#planPreviousTools: string[] | undefined;
	#goalPreviousTools: string[] | undefined;
	#vibePreviousTools: string[] | undefined;
	#vibeOwnerScope: VibeOwnerScope | undefined;
	#pendingPlan: { planFilePath: string; title: string; body: string } | undefined;
	#pendingSession: PendingSessionMode | undefined;
	#committing = false;
	#planReviewAbortPending = false;
	#planPreviousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	readonly #unsubscribeSession: () => void;
	readonly #unsubscribeModelRoles: () => void;

	constructor(readonly session: AgentSession) {
		this.#unsubscribeSession = session.subscribe(event => {
			if (event.type === "goal_updated") this.#notify();
			if (event.type === "tool_execution_end" && this.#planReviewAbortPending && !event.isError) {
				const dispatch = writeDeviceDispatch(event.toolName, event.result);
				if (dispatch?.tool === PROPOSE_DEVICE_NAME && dispatch.mode === "execute") {
					this.#planReviewAbortPending = false;
					queueMicrotask(() => {
						void this.#abortPlanReviewTurn();
					});
				}
			}
			if (event.type === "agent_end") {
				queueMicrotask(() => void this.flushPendingModelSwitch());
			}
		});
		this.#unsubscribeModelRoles = onModelRolesChanged(() => {
			if (this.session.getPlanModeState()?.enabled) void this.#applyPlanModel();
		});
	}

	state(): StudioModeState {
		return this.#projectPending(this.#committedState());
	}

	onChange(listener: StudioModeChangeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async enterPlan(initialPrompt?: string): Promise<StudioModeState> {
		if (!this.session.settings.get("plan.enabled")) {
			throw new StudioModeError("COMMAND_BLOCKED", "Plan mode is disabled in settings");
		}
		if (this.#shouldDefer()) {
			return this.#queuePending(
				initialPrompt === undefined ? { kind: "plan" } : { kind: "plan", initialPrompt },
			);
		}
		this.#pendingSession = undefined;
		this.#assertNoOtherMode("plan");
		if (this.session.getPlanModeState()?.enabled) {
			throw new StudioModeError("COMMAND_BLOCKED", "Plan mode is already active");
		}
		const previousTools = this.session.getEnabledToolNames();
		const previousModel = this.session.model;
		this.#planPreviousModelState = previousModel
			? { model: previousModel, thinkingLevel: this.session.configuredThinkingLevel() }
			: undefined;
		const tools = [...previousTools];
		if (this.session.hasBuiltInTool("write") && !tools.includes("write")) tools.push("write");
		const planFilePath = this.session.getPlanReferencePath() || DEFAULT_PLAN_FILE;
		await this.session.setActiveToolsByName(tools);
		this.#planPreviousTools = previousTools;
		this.session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel" });
		this.session.setPlanProposalHandler(async title => {
			const result = await this.session.preparePlanForReview(title);
			if (result.details !== undefined) {
				this.#armPendingPlan(result.details);
				this.#planReviewAbortPending = true;
			}
			return result;
		});
		await this.#applyPlanModel();
		this.session.sessionManager.appendModeChange("plan", { planFilePath });
		if (this.session.isStreaming) await this.session.sendPlanModeContext({ deliverAs: "steer" });
		this.#notify();
		if (initialPrompt !== undefined) await this.#submit(initialPrompt);
		return this.state();
	}

	async exitPlan(discardDraft = false): Promise<StudioModeState> {
		if (this.#shouldDefer()) {
			if (this.#pendingSession?.kind === "plan") return this.#queuePending(undefined);
			if (this.#committedKind() === "plan") return this.#queuePending({ kind: "normal" });
			return this.state();
		}
		this.#pendingSession = undefined;
		const current = this.session.getPlanModeState();
		if (!current) return this.state();
		if (!discardDraft && current.enabled) {
			throw new StudioModeError("INTERACTION_REQUIRED", "Confirm discarding the active plan draft");
		}
		const previousModel = this.#planPreviousModelState;
		const planTools = this.session.getEnabledToolNames();
		const planModel = this.session.model
			? { model: this.session.model, thinkingLevel: this.session.configuredThinkingLevel() }
			: undefined;
		this.#clearPendingModelSwitch();
		this.session.setPlanModeState(undefined);
		try {
			if (this.#planPreviousTools !== undefined) await this.session.setActiveToolsByName(this.#planPreviousTools);
			if (previousModel !== undefined) await this.#restorePreviousModel(previousModel);
		} catch (error) {
			this.#clearPendingModelSwitch();
			this.session.setPlanModeState(current);
			try {
				await this.session.setActiveToolsByName(planTools);
				if (planModel !== undefined) await this.#restorePreviousModel(planModel);
			} catch (rollbackError) {
				logger.warn("Failed to roll back Plan mode exit", { error: String(rollbackError) });
			}
			throw new StudioModeError(
				"COMMAND_BLOCKED",
				`Failed to exit Plan mode: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.session.setPlanProposalHandler(null);
		this.#planPreviousTools = undefined;
		this.#planPreviousModelState = undefined;
		this.#pendingPlan = undefined;
		this.#planReviewAbortPending = false;
		this.session.sessionManager.appendModeChange("none");
		this.#notify();
		return this.state();
	}

	async openPlanReview(): Promise<{ planFilePath: string; title: string; planExists: boolean }> {
		const result = await this.session.preparePlanForReview("");
		const details = result.details;
		if (details === undefined) throw new StudioModeError("COMMAND_BLOCKED", "Plan review details are unavailable");
		this.#armPendingPlan(details);
		return { planFilePath: details.planFilePath, title: details.title, planExists: details.planExists };
	}

	async respondPlanReview(decision: "approve" | "refine" | "dismiss", feedback?: string): Promise<unknown> {
		const pending = this.#pendingPlan;
		if (!pending) throw new StudioModeError("COMMAND_BLOCKED", "No plan review is open");
		if (decision === "dismiss") {
			this.#pendingPlan = undefined;
			this.#planReviewAbortPending = false;
			this.#notify();
			return { decision };
		}
		if (decision === "refine") {
			const normalized = feedback?.trim();
			if (!normalized) throw new StudioModeError("INVALID_ARGUMENT", "Plan refinement feedback is required");
			this.#pendingPlan = undefined;
			this.#planReviewAbortPending = false;
			this.#notify();
			await this.#submit(normalized);
			return { decision };
		}
		if (this.session.isStreaming) {
			throw new StudioModeError("COMMAND_BLOCKED", "Cannot approve a plan while the Runtime is streaming");
		}
		this.session.setPlanReferencePath(pending.planFilePath);
		this.session.markPlanReferenceSent();
		await this.exitPlan(true);
		const executionPrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: pending.planFilePath,
			contextPreserved: true,
		});
		await this.#submit(executionPrompt, true);
		return { decision, planFilePath: pending.planFilePath, title: pending.title };
	}

	async createGoal(objective: string, tokenBudget?: number): Promise<StudioModeState> {
		if (this.#shouldDefer()) {
			return this.#queuePending(
				tokenBudget === undefined
					? { kind: "goal", objective }
					: { kind: "goal", objective, tokenBudget },
			);
		}
		this.#pendingSession = undefined;
		this.#assertNoOtherMode("goal");
		this.#goalPreviousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
		await this.session.setActiveToolsByName([...new Set([...this.#goalPreviousTools, "goal"])]);
		await this.session.goalRuntime.createGoal({ objective, tokenBudget });
		this.#notify();
		return this.state();
	}

	async replaceGoal(objective: string, tokenBudget?: number): Promise<StudioModeState> {
		await this.session.goalRuntime.replaceGoal({ objective, tokenBudget });
		this.#notify();
		return this.state();
	}

	async setGoalBudget(tokenBudget?: number): Promise<StudioModeState> {
		await this.session.goalRuntime.onBudgetMutated(tokenBudget);
		this.#notify();
		return this.state();
	}

	async pauseGoal(): Promise<StudioModeState> {
		await this.session.goalRuntime.pauseGoal();
		await this.#restoreGoalTools();
		this.#notify();
		return this.state();
	}

	async resumeGoal(): Promise<StudioModeState> {
		this.#assertNoOtherMode("goal");
		this.#goalPreviousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
		await this.session.setActiveToolsByName([...new Set([...this.#goalPreviousTools, "goal"])]);
		await this.session.goalRuntime.resumeGoal();
		this.#notify();
		return this.state();
	}

	async dropGoal(): Promise<StudioModeState> {
		if (this.#shouldDefer()) {
			if (this.#pendingSession?.kind === "goal") return this.#queuePending(undefined);
			if (this.#committedKind() === "goal") return this.#queuePending({ kind: "normal" });
			return this.state();
		}
		this.#pendingSession = undefined;
		await this.session.goalRuntime.dropGoal();
		await this.#restoreGoalTools();
		this.#notify();
		return this.state();
	}

	async startGuidedGoal(initial?: string): Promise<{ started: true }> {
		this.#assertNoOtherMode("goal");
		const enabled = this.session.getEnabledToolNames();
		this.#goalPreviousTools = enabled.filter(name => name !== "goal");
		if (!enabled.includes("goal")) await this.session.setActiveToolsByName([...enabled, "goal"]);
		await this.#submit(prompt.render(guidedGoalInterviewPrompt, { initial: initial?.trim() || undefined }), true);
		return { started: true };
	}

	async enterVibe(initialPrompt?: string): Promise<StudioModeState> {
		if (this.#shouldDefer()) {
			return this.#queuePending(
				initialPrompt === undefined ? { kind: "vibe" } : { kind: "vibe", initialPrompt },
			);
		}
		this.#pendingSession = undefined;
		this.#assertNoOtherMode("vibe");
		if (this.session.getVibeModeState()?.enabled) {
			throw new StudioModeError("COMMAND_BLOCKED", "Vibe mode is already active");
		}
		const parent = this.#vibeParent();
		const registry = VibeSessionRegistry.global();
		const scope = registry.ownerScope(parent);
		registry.activateScope(scope);
		const previousTools = this.session.getEnabledToolNames();
		const baseTools = ["read"];
		if (this.session.hasBuiltInTool("todo")) baseTools.push("todo");
		await this.session.activateVibeTools(baseTools);
		this.#vibePreviousTools = previousTools;
		this.#vibeOwnerScope = scope;
		this.session.setVibeModeState({ enabled: true });
		this.session.sessionManager.appendModeChange("vibe");
		if (this.session.isStreaming) await this.session.sendVibeModeContext({ deliverAs: "steer" });
		this.#notify();
		if (initialPrompt !== undefined) await this.#submit(initialPrompt);
		return this.state();
	}

	async exitVibe(): Promise<{ killed: number; state: StudioModeState }> {
		if (this.#shouldDefer()) {
			if (this.#pendingSession?.kind === "vibe") {
				return { killed: 0, state: this.#queuePending(undefined) };
			}
			if (this.#committedKind() === "vibe") {
				return { killed: 0, state: this.#queuePending({ kind: "normal" }) };
			}
			return { killed: 0, state: this.state() };
		}
		this.#pendingSession = undefined;
		if (!this.session.getVibeModeState()?.enabled) return { killed: 0, state: this.state() };
		const parent = this.#vibeParent();
		const killed = await VibeSessionRegistry.global().killAll(parent, this.#vibeOwnerScope);
		await this.session.deactivateVibeTools(this.#vibePreviousTools ?? []);
		this.session.setVibeModeState(undefined);
		this.session.sessionManager.appendModeChange("none");
		this.#vibePreviousTools = undefined;
		this.#vibeOwnerScope = undefined;
		this.#notify();
		return { killed, state: this.state() };
	}

	/**
	 * Apply a deferred Plan/Goal/Vibe switch. Safe to call when idle or just
	 * before the next user steer/follow-up; no-ops when nothing is queued.
	 */
	async applyPending(): Promise<void> {
		const pending = this.#pendingSession;
		if (pending === undefined) return;
		this.#pendingSession = undefined;
		try {
			await this.#commitPending(pending);
		} catch (error) {
			this.#pendingSession = pending;
			throw error;
		}
	}

	dispose(): void {
		this.#pendingSession = undefined;
		this.#clearPendingModelSwitch();
		this.#unsubscribeSession();
		this.#unsubscribeModelRoles();
		this.#listeners.clear();
	}

	#committedState(): StudioModeState {
		const plan = this.session.getPlanModeState();
		const goal = this.session.getGoalModeState();
		const vibe = this.session.getVibeModeState();
		const pending = this.#pendingPlan;
		return {
			...(plan === undefined
				? {}
				: {
						plan: {
							status: pending ? ("review" as const) : plan.enabled ? ("active" as const) : ("paused" as const),
							planFilePath: pending?.planFilePath ?? plan.planFilePath,
							...(pending?.title ? { title: pending.title } : {}),
							...(pending?.body ? { body: pending.body } : {}),
						},
					}),
			...(goal === undefined
				? {}
				: {
						goal: {
							status:
								goal.goal.status === "complete"
									? ("complete" as const)
									: goal.enabled
										? ("active" as const)
										: ("paused" as const),
							objective: goal.goal.objective,
							tokenBudget: goal.goal.tokenBudget,
							tokensUsed: goal.goal.tokensUsed,
						},
					}),
			...(vibe === undefined
				? {}
				: {
						vibe: {
							enabled: vibe.enabled,
							workerAgentIds: [],
						},
					}),
		};
	}

	#projectPending(committed: StudioModeState): StudioModeState {
		const pending = this.#pendingSession;
		if (pending === undefined) return committed;
		if (pending.kind === "normal") return {};
		if (pending.kind === "plan") {
			return {
				plan: {
					status: "active",
					planFilePath: committed.plan?.planFilePath ?? DEFAULT_PLAN_FILE,
				},
			};
		}
		if (pending.kind === "vibe") {
			return {
				vibe: {
					enabled: true,
					workerAgentIds: committed.vibe?.workerAgentIds ?? [],
				},
			};
		}
		return {
			goal: {
				status: "active",
				objective: pending.objective,
				...(pending.tokenBudget === undefined ? {} : { tokenBudget: pending.tokenBudget }),
				...(committed.goal?.tokensUsed === undefined ? {} : { tokensUsed: committed.goal.tokensUsed }),
			},
		};
	}

	#committedKind(): "normal" | "plan" | "goal" | "vibe" {
		if (this.session.getGoalModeState() !== undefined) return "goal";
		if (this.session.getPlanModeState() !== undefined) return "plan";
		if (this.session.getVibeModeState()?.enabled) return "vibe";
		return "normal";
	}

	#shouldDefer(): boolean {
		return !this.#committing && (this.session.isStreaming || this.session.isCompacting);
	}

	#queuePending(pending: PendingSessionMode | undefined): StudioModeState {
		this.#pendingSession = pending;
		this.#notify();
		return this.state();
	}

	async #commitPending(pending: PendingSessionMode): Promise<void> {
		this.#committing = true;
		try {
			const committed = this.#committedKind();
			if (pending.kind === "normal") {
				if (committed === "plan") await this.exitPlan(true);
				else if (committed === "vibe") await this.exitVibe();
				else if (committed === "goal") await this.dropGoal();
				return;
			}
			if (committed === pending.kind) return;
			if (committed !== "normal") {
				if (committed === "plan") await this.exitPlan(true);
				else if (committed === "vibe") await this.exitVibe();
				else await this.dropGoal();
			}
			if (pending.kind === "plan") {
				await (pending.initialPrompt === undefined ? this.enterPlan() : this.enterPlan(pending.initialPrompt));
			} else if (pending.kind === "vibe") {
				await (pending.initialPrompt === undefined ? this.enterVibe() : this.enterVibe(pending.initialPrompt));
			} else if (pending.tokenBudget === undefined) {
				await this.createGoal(pending.objective);
			} else {
				await this.createGoal(pending.objective, pending.tokenBudget);
			}
		} finally {
			this.#committing = false;
		}
	}

	async #applyPlanModel(): Promise<void> {
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) {
			this.#clearPendingModelSwitch();
			return;
		}
		const transition = resolvePlanModelTransition(this.session.model, resolved, this.session.isStreaming);
		switch (transition.kind) {
			case "none":
				return;
			case "thinking":
				this.session.setThinkingLevel(transition.thinkingLevel);
				return;
			case "apply":
				if (transition.deferred) {
					this.#pendingModelSwitch = { model: transition.model, thinkingLevel: transition.thinkingLevel };
					return;
				}
				try {
					await this.session.setModelTemporary(transition.model, transition.thinkingLevel, { ephemeral: true });
				} catch (error) {
					logger.warn("Failed to switch to the Plan role model", { error: String(error) });
				}
		}
	}

	async #restorePreviousModel(previous: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }): Promise<void> {
		if (modelsAreEqual(this.session.model, previous.model)) {
			this.session.setThinkingLevel(previous.thinkingLevel);
			return;
		}
		if (this.session.isStreaming) {
			this.#pendingModelSwitch = { model: previous.model, thinkingLevel: previous.thinkingLevel };
			return;
		}
		await this.session.setModelTemporary(previous.model, previous.thinkingLevel, { ephemeral: true });
	}

	#clearPendingModelSwitch(): void {
		this.#pendingModelSwitch = undefined;
	}

	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (pending === undefined || this.session.isStreaming) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(pending.model, pending.thinkingLevel, { ephemeral: true });
		} catch (error) {
			logger.warn("Failed to apply a deferred Plan model transition", { error: String(error) });
		}
	}

	async #restoreGoalTools(): Promise<void> {
		if (this.#goalPreviousTools !== undefined) await this.session.setActiveToolsByName(this.#goalPreviousTools);
		this.#goalPreviousTools = undefined;
	}

	#assertNoOtherMode(target: "plan" | "goal" | "vibe"): void {
		if (target === "goal" && !this.session.settings.get("goal.enabled")) {
			throw new StudioModeError("COMMAND_BLOCKED", "Goal mode is disabled in settings");
		}
		if (target !== "plan" && this.session.getPlanModeState() !== undefined) {
			throw new StudioModeError("MODE_CONFLICT", "Exit plan mode first");
		}
		if (target !== "goal" && this.session.getGoalModeState() !== undefined) {
			throw new StudioModeError("MODE_CONFLICT", "Exit goal mode first");
		}
		if (target !== "vibe" && this.session.getVibeModeState()?.enabled) {
			throw new StudioModeError("MODE_CONFLICT", "Exit vibe mode first");
		}
	}

	async #submit(text: string, synthetic = false): Promise<void> {
		const normalized = text.trim();
		if (!normalized) throw new StudioModeError("INVALID_ARGUMENT", "Prompt must not be empty");
		if (this.session.isStreaming) {
			await this.session.followUp(normalized, undefined, { synthetic });
		} else {
			await this.session.prompt(normalized, { synthetic });
		}
	}

	#vibeParent(): VibeParentSession {
		return {
			getAgentId: () => this.session.getAgentId() ?? null,
			getSessionId: () => this.session.sessionManager.getSessionId(),
			getSessionFile: () => this.session.sessionManager.getSessionFile() ?? null,
			sessionManager: this.session.sessionManager,
			asyncJobManager: this.session.asyncJobManager,
			settings: this.session.settings,
		};
	}

	#armPendingPlan(details: PlanApprovalDetails): void {
		this.#pendingPlan = {
			planFilePath: details.planFilePath,
			title: details.title,
			body: details.planContent ?? "",
		};
		this.#notify();
	}

	async #abortPlanReviewTurn(): Promise<void> {
		this.session.markPlanInternalAbortPending();
		try {
			await this.session.abort();
		} finally {
			this.session.clearPlanInternalAbortPending();
		}
	}

	#notify(): void {
		const state = this.state();
		for (const listener of this.#listeners) listener(structuredClone(state));
	}
}
