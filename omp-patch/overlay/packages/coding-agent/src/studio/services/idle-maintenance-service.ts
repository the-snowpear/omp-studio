import { cfgRecapEnabled } from "../../modes/settings";
import { cfgCompactionIdleEnabled } from "../../session/context-settings";
import type { AgentSession } from "../../session/agent-session";
import type { SessionOwnerState } from "../session-owner-protocol";
import type { StudioLoopService } from "./loop-service";
import type { StudioInteractionGateway } from "./interaction-port";
import { applyStudioDefaults } from "../settings-defaults";

/** Owner signals gate the session's native scheduler; no draft text is sent or retained. */
export class StudioIdleMaintenance {
	#state: SessionOwnerState = { known: false, visibleSessionIds: [], blockedSessionIds: [] };
	#disposed = false;
	constructor(
		readonly session: AgentSession,
		readonly loop: StudioLoopService,
		readonly interaction: StudioInteractionGateway,
		readonly isWorkerActive: () => boolean,
	) {
		this.rebind();
	}
	rebind(): void {
		applyStudioDefaults(this.session.settings);
		this.session.enableIdleMaintenance?.({
			isBlocked: () => this.blocked(),
			scheduledTurn: () => this.loop.state() !== undefined && this.loop.state()?.status !== "paused",
			onRecap: () => this.session.emitNotice("info", "Idle recap saved to native history", "idle-recap"),
		});
	}
	get state(): SessionOwnerState {
		return this.#state;
	}
	update(state: SessionOwnerState): void {
		this.#state = {
			known: state.known === true,
			visibleSessionIds: [...state.visibleSessionIds],
			blockedSessionIds: [...state.blockedSessionIds],
		};
		this.session.refreshIdleMaintenance?.();
	}
	blocked(): boolean {
		return (
			this.#disposed ||
			!this.#state.known ||
			!this.isWorkerActive() ||
			!this.#state.visibleSessionIds.includes(this.session.sessionId) ||
			this.#state.blockedSessionIds.includes(this.session.sessionId) ||
			this.interaction.pending() !== undefined
		);
	}
	keepWorkerLive(): boolean {
		return (
			this.#state.known &&
			this.#state.visibleSessionIds.includes(this.session.sessionId) &&
			(cfgRecapEnabled.get(this.session.settings) || cfgCompactionIdleEnabled.get(this.session.settings))
		);
	}
	dispose(): void {
		this.#disposed = true;
		this.#state = { known: false, visibleSessionIds: [], blockedSessionIds: [] };
		this.session.refreshIdleMaintenance?.();
	}
}
