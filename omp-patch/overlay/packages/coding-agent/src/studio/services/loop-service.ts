import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import type { LoopConditionVerdict } from "../../modes/loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitConfig,
} from "../../modes/loop-limit";

export interface StudioLoopLimit {
	turns?: number;
	minutes?: number;
	tokens?: number;
}

export interface StudioLoopState {
	status: "waiting" | "running" | "paused";
	prompt?: string;
	iterations?: number;
	condition?: LoopConditionConfig;
	evaluatingCondition?: boolean;
}

export interface StudioLoopPort {
	action(): "prompt" | "compact" | "reset";
	isBlocked(): boolean;
	isVibeActive(): boolean;
	submitPrompt(prompt: string): void | Promise<void>;
	compact(): void | Promise<void>;
	reset(): void | Promise<void>;
	nowMs(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
	evaluateCondition?(condition: LoopConditionConfig, signal: AbortSignal): Promise<LoopConditionVerdict>;
	onStatus?(message: string): void;
	onError?(error: unknown): void;
}

export class StudioLoopError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioLoopError";
	}
}

export interface StudioLoopEnableResult {
	initialPrompt?: string;
	state: StudioLoopState;
}

export type StudioLoopChangeListener = (state: StudioLoopState | undefined) => void;

const DEFAULT_DELAY_MS = 800;

/** Presentation-neutral loop state and scheduler shared by TUI and Bridge adapters. */
export class StudioLoopService {
	#enabled = false;
	#paused = false;
	#prompt: string | undefined;
	#limit: LoopLimitRuntime | undefined;
	#iterations = 0;
	#timer: unknown;
	#disposed = false;
	#condition: LoopConditionConfig | undefined;
	#conditionAbort: AbortController | undefined;
	#evaluatingCondition = false;
	#generation = 0;
	#iterationInFlight = false;
	#rescheduleRequested = false;
	#promptHolds = 0;
	readonly #listeners = new Set<StudioLoopChangeListener>();

	constructor(
		private readonly port: StudioLoopPort,
		private readonly delayMs = DEFAULT_DELAY_MS,
	) {
		if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
			throw new TypeError("Loop delay must be a non-negative integer");
		}
	}

	enable(prompt?: string, limit?: StudioLoopLimit, condition?: LoopConditionConfig): StudioLoopEnableResult {
		return this.#enable(prompt, normalizeLimit(limit), condition);
	}

	/**
	 * Replace the active limit without dropping the captured prompt or iteration
	 * count. Duration/turn budgets restart from `nowMs()`.
	 */
	setLimit(limit?: StudioLoopLimit): StudioLoopState {
		this.#assertUsable();
		if (!this.#enabled) throw new StudioLoopError("COMMAND_BLOCKED", "Loop mode is not enabled");
		this.#limit = createLoopLimitRuntime(normalizeLimit(limit), this.port.nowMs());
		this.#notify();
		return this.state()!;
	}

	/** TUI adapter entry point that preserves the CLI parser's sub-minute duration support. */
	enableFromConfig(
		prompt: string | undefined,
		config: LoopLimitConfig | undefined,
		condition?: LoopConditionConfig,
	): StudioLoopEnableResult {
		return this.#enable(prompt, config, condition);
	}

	limitState(): LoopLimitRuntime | undefined {
		return this.#limit === undefined ? undefined : structuredClone(this.#limit);
	}

	interruptPending(): void {
		this.#assertUsable();
		this.#invalidatePending();
		this.scheduleNext();
	}

	holdPrompt(): { capture: (prompt: string) => void; release: () => void } {
		this.#assertUsable();
		this.#invalidatePending();
		const generation = this.#generation;
		this.#promptHolds += 1;
		this.#notify();
		let released = false;
		return {
			capture: prompt => {
				if (!released && !this.#disposed && this.#enabled && generation === this.#generation) {
					this.capturePrompt(prompt);
				}
			},
			release: () => {
				if (released) return;
				released = true;
				this.#promptHolds -= 1;
				if (!this.#disposed && this.#promptHolds === 0) this.scheduleNext();
			},
		};
	}

	#enable(
		prompt: string | undefined,
		config: LoopLimitConfig | undefined,
		condition?: LoopConditionConfig,
	): StudioLoopEnableResult {
		this.#assertUsable();
		if (this.#enabled) throw new StudioLoopError("COMMAND_BLOCKED", "Loop mode is already enabled");
		const normalizedPrompt = normalizePrompt(prompt);
		const normalizedCondition = normalizeCondition(condition);
		if (normalizedCondition !== undefined && this.port.evaluateCondition === undefined) {
			throw new StudioLoopError("COMMAND_BLOCKED", "Loop condition evaluation is unavailable");
		}
		this.#invalidatePending();
		this.#condition = normalizedCondition;
		this.#enabled = true;
		this.#paused = false;
		this.#prompt = normalizedPrompt;
		this.#limit = createLoopLimitRuntime(config, this.port.nowMs());
		this.#iterations = 0;
		this.#notify();
		return {
			...(normalizedPrompt === undefined ? {} : { initialPrompt: normalizedPrompt }),
			state: this.state()!,
		};
	}

	capturePrompt(prompt: string): StudioLoopState {
		this.#assertUsable();
		if (!this.#enabled) throw new StudioLoopError("COMMAND_BLOCKED", "Loop mode is not enabled");
		const normalized = normalizePrompt(prompt);
		if (normalized === undefined) throw new StudioLoopError("INVALID_ARGUMENT", "Loop prompt must not be empty");
		this.#invalidatePending();
		this.#prompt = normalized;
		this.#paused = false;
		this.#notify();
		return this.state()!;
	}

	pause(): StudioLoopState {
		this.#assertUsable();
		if (!this.#enabled) throw new StudioLoopError("COMMAND_BLOCKED", "Loop mode is not enabled");
		this.#invalidatePending();
		this.#prompt = undefined;
		this.#paused = true;
		this.#cancelTimer();
		this.#notify();
		return this.state()!;
	}

	disable(): { disabled: boolean } {
		this.#assertUsable();
		return { disabled: this.#disable() };
	}

	state(): StudioLoopState | undefined {
		if (!this.#enabled) return undefined;
		return {
			status: this.#paused ? "paused" : this.#prompt === undefined ? "waiting" : "running",
			...(this.#prompt === undefined ? {} : { prompt: this.#prompt }),
			...(this.#iterations === 0 ? {} : { iterations: this.#iterations }),
			...(this.#condition === undefined ? {} : { condition: { ...this.#condition } }),
			...(this.#evaluatingCondition ? { evaluatingCondition: true } : {}),
		};
	}

	onChange(listener: StudioLoopChangeListener): () => void {
		this.#assertUsable();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called by the shared session/TUI adapter when the Runtime becomes idle. */
	scheduleNext(): boolean {
		this.#assertUsable();
		this.#cancelTimer();
		if (!this.#enabled || this.#paused || this.#prompt === undefined || this.#promptHolds > 0) return false;
		if (this.#iterationInFlight) {
			this.#rescheduleRequested = true;
			return true;
		}
		const generation = this.#generation;
		this.#timer = this.port.setTimer(() => {
			this.#timer = undefined;
			void this.#runIteration(generation).catch(error => {
				if (generation !== this.#generation) return;
				this.#disable();
				this.port.onError?.(error);
			});
		}, this.delayMs);
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#invalidatePending();
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.#condition = undefined;
		this.#listeners.clear();
	}

	async #runIteration(generation: number): Promise<void> {
		if (!this.#isCurrent(generation) || this.#iterationInFlight) return;
		this.#iterationInFlight = true;
		try {
			await this.#iterate(generation);
		} finally {
			this.#iterationInFlight = false;
			if (this.#rescheduleRequested) {
				this.#rescheduleRequested = false;
				if (!this.#disposed) this.scheduleNext();
			}
		}
	}

	async #iterate(generation: number): Promise<void> {
		if (isLoopDurationExpired(this.#limit, this.port.nowMs())) {
			this.#disable();
			return;
		}
		if (this.port.isBlocked()) {
			this.scheduleNext();
			return;
		}
		if (this.#condition !== undefined) {
			const controller = new AbortController();
			this.#conditionAbort = controller;
			this.#evaluatingCondition = true;
			this.#notify();
			let verdict: LoopConditionVerdict;
			try {
				verdict = await this.port.evaluateCondition!(this.#condition, controller.signal);
			} finally {
				if (this.#conditionAbort === controller) {
					this.#conditionAbort = undefined;
					this.#evaluatingCondition = false;
					this.#notify();
				}
			}
			if (!this.#isCurrent(generation) || verdict.kind === "aborted") return;
			if (verdict.kind !== "continue") {
				this.#disable();
				if (verdict.kind === "error") this.port.onError?.(new StudioLoopError("COMMAND_BLOCKED", verdict.message));
				else this.port.onStatus?.(verdict.message);
				return;
			}
		}
		if (!this.#isCurrent(generation)) return;
		if (this.port.isBlocked()) {
			this.scheduleNext();
			return;
		}
		const action = this.port.action();
		if (action === "reset" && this.port.isVibeActive()) {
			throw new StudioLoopError("COMMAND_BLOCKED", "Exit vibe mode before using reset loops");
		}
		if (!consumeLoopLimitIteration(this.#limit, this.port.nowMs())) {
			this.#disable();
			return;
		}
		this.#iterations += 1;
		this.#notify();
		if (action === "compact") await this.port.compact();
		if (action === "reset") await this.port.reset();
		if (!this.#isCurrent(generation)) return;
		if (isLoopDurationExpired(this.#limit, this.port.nowMs())) {
			this.#disable();
			return;
		}
		await this.port.submitPrompt(this.#prompt!);
	}

	#isCurrent(generation: number): boolean {
		return (
			!this.#disposed &&
			this.#enabled &&
			!this.#paused &&
			this.#prompt !== undefined &&
			this.#promptHolds === 0 &&
			generation === this.#generation
		);
	}

	#invalidatePending(): void {
		this.#generation += 1;
		this.#cancelTimer();
		this.#conditionAbort?.abort();
		this.#conditionAbort = undefined;
		this.#evaluatingCondition = false;
		this.#rescheduleRequested = false;
	}

	#disable(): boolean {
		const wasEnabled = this.#enabled;
		this.#invalidatePending();
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.#condition = undefined;
		this.#iterations = 0;
		this.#cancelTimer();
		if (wasEnabled) this.#notify();
		return wasEnabled;
	}

	#cancelTimer(): void {
		if (this.#timer === undefined) return;
		this.port.clearTimer(this.#timer);
		this.#timer = undefined;
	}

	#notify(): void {
		const state = this.state();
		for (const listener of this.#listeners) listener(state === undefined ? undefined : structuredClone(state));
	}

	#assertUsable(): void {
		if (this.#disposed) throw new StudioLoopError("COMMAND_BLOCKED", "Loop service is disposed");
	}
}

function normalizePrompt(prompt: string | undefined): string | undefined {
	const normalized = prompt?.trim();
	return normalized ? normalized : undefined;
}

function normalizeCondition(condition: LoopConditionConfig | undefined): LoopConditionConfig | undefined {
	if (condition === undefined) return undefined;
	if (
		typeof condition.command !== "string" ||
		condition.command.trim() === "" ||
		typeof condition.until !== "boolean"
	) {
		throw new StudioLoopError("INVALID_ARGUMENT", "Loop conditions require a command and an until flag");
	}
	return { command: condition.command.trim(), until: condition.until };
}

function normalizeLimit(limit: StudioLoopLimit | undefined): LoopLimitConfig | undefined {
	if (limit === undefined) return undefined;
	if (limit.tokens !== undefined) {
		throw new StudioLoopError("INVALID_ARGUMENT", "Token loop limits are not supported by this Runtime");
	}
	const fields = [limit.turns !== undefined, limit.minutes !== undefined].filter(Boolean).length;
	if (fields > 1) throw new StudioLoopError("INVALID_ARGUMENT", "Specify only one loop limit");
	if (limit.turns !== undefined) {
		if (!Number.isSafeInteger(limit.turns) || limit.turns <= 0) {
			throw new StudioLoopError("INVALID_ARGUMENT", "Loop turns must be a positive integer");
		}
		return { kind: "iterations", iterations: limit.turns };
	}
	if (limit.minutes !== undefined) {
		if (!Number.isSafeInteger(limit.minutes) || limit.minutes <= 0) {
			throw new StudioLoopError("INVALID_ARGUMENT", "Loop minutes must be a positive integer");
		}
		return { kind: "duration", durationMs: limit.minutes * 60_000 };
	}
	return undefined;
}
