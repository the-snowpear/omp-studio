import type {
	ExtensionSessionModes,
	SessionModeRequest,
	SessionModeResult,
	SessionModeState,
} from "../../extensibility/extensions/types";
import { cfgExtensionHandlersModeControl } from "../../extensibility/settings";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import { cfgGoalEnabled } from "../../goals/settings";
import type { AgentSession } from "../../session/agent-session";
import type { StudioLoopService } from "./loop-service";
import { StudioModeError, type StudioModeControlService } from "./mode-control-service";

/** The same mode owners serve extensions and GUI commands; this adapter never submits a prompt. */
export class StudioExtensionModes implements ExtensionSessionModes {
	#setting = false;
	#disposed = false;
	#notificationPending = false;
	#previous: SessionModeState = {
		plan: { status: "inactive" },
		vibe: { status: "inactive" },
		goal: { status: "inactive" },
		loop: { status: "inactive" },
	};
	#release: (() => void) | undefined;
	readonly #stops: Array<() => void>;

	constructor(
		readonly session: AgentSession,
		readonly modes: StudioModeControlService,
		readonly loop: StudioLoopService,
	) {
		this.#stops = [
			modes.onChange(() => this.#schedule()),
			loop.onChange(() => this.#schedule()),
			session.subscribe(event => {
				if (event.type === "agent_end" || event.type === "goal_updated") this.#schedule();
			}),
		];
		this.rebind();
	}

	rebind(): void {
		this.#release?.();
		this.#release = this.session.extensionRunner?.bindSessionModes(this);
		this.#schedule();
	}

	getState(): SessionModeState {
		const plan = this.session.getPlanModeState();
		const goal = this.session.getGoalModeState();
		const vibe = this.session.getVibeModeState();
		const loop = this.loop.state();
		return {
			plan: plan
				? { status: plan.enabled ? "active" : "paused", planFilePath: plan.planFilePath }
				: { status: "inactive" },
			vibe: { status: vibe?.enabled ? "active" : "inactive" },
			goal: goal
				? {
						status: goal.enabled || goal.mode === "exiting" ? "active" : "paused",
						objective: goal.goal.objective,
						tokenBudget: goal.goal.tokenBudget,
					}
				: { status: "inactive" },
			loop: { status: !loop ? "inactive" : loop.status === "paused" ? "paused" : "active" },
		};
	}

	async set(request: SessionModeRequest): Promise<SessionModeResult> {
		const refuse = (
			code: "busy" | "conflict" | "disabled" | "invalid_request",
			message: string,
		): SessionModeResult => ({ ok: false, code, message, state: this.getState() });
		if (this.#disposed) return refuse("disabled", "The mode owner has closed");
		if (!cfgExtensionHandlersModeControl.get(this.session.settings))
			return refuse("disabled", "Extension mode control is disabled");
		if (
			this.#setting ||
			this.session.isSessionTransitioning ||
			this.session.isBusyForSnapshot ||
			this.modes.vibeTransitionPending ||
			this.session.getGoalModeState()?.mode === "exiting"
		)
			return refuse("busy", "Wait for the current turn or mode transition to settle");
		const before = this.getState();
		const blocks = (mode: "plan" | "vibe" | "goal") => before[mode].status !== "inactive";
		if (request?.action === "enter") {
			if (request.mode === "plan" && !cfgPlanEnabled.get(this.session.settings))
				return refuse("disabled", "Plan mode is disabled");
			if (request.mode === "goal" && !cfgGoalEnabled.get(this.session.settings))
				return refuse("disabled", "Goal mode is disabled");
			if (request.mode !== "loop") {
				for (const mode of ["plan", "vibe", "goal"] as const)
					if (mode !== request.mode && blocks(mode)) return refuse("conflict", `Exit ${mode} mode first`);
			}
		}
		this.#setting = true;
		try {
			switch (request?.mode) {
				case "plan":
					if (request.action === "enter") {
						if (before.plan.status !== "active") await this.modes.enterPlan();
					} else if (request.action === "exit") {
						if (before.plan.status !== "inactive") await this.modes.exitPlan(true);
					} else return refuse("invalid_request", "Invalid plan transition");
					break;
				case "vibe":
					if (request.action === "enter") {
						if (before.vibe.status !== "active") await this.modes.enterVibe();
					} else if (request.action === "exit") {
						if (before.vibe.status !== "inactive") await this.modes.exitVibe();
					} else return refuse("invalid_request", "Invalid vibe transition");
					break;
				case "goal":
					if (request.action === "enter") {
						if (
							!request.objective?.trim() ||
							(request.tokenBudget !== undefined &&
								(!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0))
						)
							return refuse("invalid_request", "Supply a goal objective and positive token budget");
						if (before.goal.status === "inactive")
							await this.modes.createGoal(request.objective, request.tokenBudget);
						else if (
							before.goal.objective !== request.objective ||
							before.goal.tokenBudget !== request.tokenBudget
						)
							await this.modes.replaceGoal(request.objective, request.tokenBudget);
						if (this.getState().goal.status === "paused") await this.modes.resumeGoal();
					} else if (request.action === "pause") {
						if (before.goal.status === "active") await this.modes.pauseGoal();
					} else if (request.action === "resume") {
						if (before.goal.status === "inactive") return refuse("invalid_request", "There is no goal to resume");
						if (blocks("plan") || blocks("vibe")) return refuse("conflict", "Exit the other session mode first");
						if (before.goal.status === "paused") await this.modes.resumeGoal();
					} else if (request.action === "drop") {
						if (before.goal.status !== "inactive") await this.modes.dropGoal();
					} else return refuse("invalid_request", "Invalid goal transition");
					break;
				case "loop":
					if (request.action === "exit") {
						if (this.loop.state()) this.loop.disable();
					} else if (request.action === "enter") {
						if (this.loop.state()) {
							if (request.limit || request.condition) {
								this.loop.disable();
								this.loop.enableFromConfig(request.prompt, request.limit, request.condition);
							} else if (request.prompt) this.loop.capturePrompt(request.prompt);
							else this.loop.resume();
						} else this.loop.enableFromConfig(request.prompt, request.limit, request.condition);
					} else return refuse("invalid_request", "Invalid loop transition");
					break;
				default:
					return refuse("invalid_request", "Unknown session mode");
			}
			const state = this.getState();
			return { ok: true, changed: JSON.stringify(before) !== JSON.stringify(state), state };
		} catch (error) {
			return refuse(
				error instanceof StudioModeError && error.code === "MODE_CONFLICT" ? "conflict" : "invalid_request",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			this.#setting = false;
			this.#schedule();
		}
	}

	#schedule(): void {
		if (this.#disposed || this.#notificationPending) return;
		this.#notificationPending = true;
		queueMicrotask(() => {
			this.#notificationPending = false;
			if (this.#disposed || this.#setting || this.session.isSessionTransitioning) return;
			const state = this.getState();
			if (JSON.stringify(state) === JSON.stringify(this.#previous)) return;
			const previous = this.#previous;
			this.#previous = state;
			void this.session.extensionRunner?.emit({ type: "mode_changed", previous, state: structuredClone(state) });
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.#release?.();
		for (const stop of this.#stops) stop();
	}
}
