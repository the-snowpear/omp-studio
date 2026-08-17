import { type AgentPauseGate, agentPauseGate } from "@oh-my-pi/pi-agent-core";

export interface StudioPauseState {
	paused: boolean;
	pauseEpoch?: number;
	pausedAt?: string;
}

export type StudioPauseChangeListener = (state: StudioPauseState) => void;

export class StudioPauseError extends Error {
	constructor(
		readonly code: "ALREADY_PAUSED" | "NOT_PAUSED" | "STALE_PAUSE_EPOCH",
		message: string,
	) {
		super(message);
		this.name = "StudioPauseError";
	}
}

/**
 * Shared presentation-neutral pause service used by both the TUI and Studio
 * Bridge. The process-global AgentPauseGate remains the single execution gate.
 */
export class StudioPauseService {
	#pauseEpoch = 0;
	#pausedAt: string | undefined;
	readonly #listeners = new Set<StudioPauseChangeListener>();

	constructor(private readonly gate: AgentPauseGate = agentPauseGate) {}

	pause(now = new Date()): { pauseEpoch: number; pausedAt: string } {
		if (!this.gate.pause()) throw new StudioPauseError("ALREADY_PAUSED", "Runtime is already paused");
		this.#pauseEpoch += 1;
		this.#pausedAt = now.toISOString();
		const state = this.state();
		this.#notify(state);
		return { pauseEpoch: this.#pauseEpoch, pausedAt: this.#pausedAt };
	}

	resume(expectedPauseEpoch: number): { pauseEpoch: number; heldMs: number } {
		if (!this.gate.paused) throw new StudioPauseError("NOT_PAUSED", "Runtime is not paused");
		if (expectedPauseEpoch !== this.#pauseEpoch) {
			throw new StudioPauseError("STALE_PAUSE_EPOCH", "Pause epoch is stale");
		}
		const heldMs = this.gate.resume();
		if (heldMs === undefined) throw new StudioPauseError("NOT_PAUSED", "Runtime is not paused");
		const pauseEpoch = this.#pauseEpoch;
		this.#pausedAt = undefined;
		this.#notify(this.state());
		return { pauseEpoch, heldMs };
	}

	state(): StudioPauseState {
		if (!this.gate.paused) return { paused: false };
		return {
			paused: true,
			pauseEpoch: this.#pauseEpoch,
			...(this.#pausedAt === undefined ? {} : { pausedAt: this.#pausedAt }),
		};
	}

	onChange(listener: StudioPauseChangeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#notify(state: StudioPauseState): void {
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(state));
			} catch {
				// Presentation listeners must never break the process pause gate.
			}
		}
	}
}

export const studioPauseService = new StudioPauseService();
