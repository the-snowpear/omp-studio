import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitConfig,
	type LoopLimitRuntime,
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
	readonly #listeners = new Set<StudioLoopChangeListener>();

	constructor(
		private readonly port: StudioLoopPort,
		private readonly delayMs = DEFAULT_DELAY_MS,
	) {
		if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
			throw new TypeError("Loop delay must be a non-negative integer");
		}
	}

	enable(prompt?: string, limit?: StudioLoopLimit): StudioLoopEnableResult {
		return this.#enable(prompt, normalizeLimit(limit));
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
	enableFromConfig(prompt: string | undefined, config: LoopLimitConfig | undefined): StudioLoopEnableResult {
		return this.#enable(prompt, config);
	}

	limitState(): LoopLimitRuntime | undefined {
		return this.#limit === undefined ? undefined : structuredClone(this.#limit);
	}

	#enable(prompt: string | undefined, config: LoopLimitConfig | undefined): StudioLoopEnableResult {
		this.#assertUsable();
		if (this.#enabled) throw new StudioLoopError("COMMAND_BLOCKED", "Loop mode is already enabled");
		const normalizedPrompt = normalizePrompt(prompt);
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
		this.#prompt = normalizePrompt(prompt);
		if (this.#prompt === undefined) throw new StudioLoopError("INVALID_ARGUMENT", "Loop prompt must not be empty");
		this.#paused = false;
		this.#notify();
		return this.state()!;
	}

	pause(): StudioLoopState {
		this.#assertUsable();
		if (!this.#enabled) throw new StudioLoopError("COMMAND_BLOCKED", "Loop mode is not enabled");
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
		if (!this.#enabled || this.#paused || this.#prompt === undefined) return false;
		this.#timer = this.port.setTimer(() => {
			this.#timer = undefined;
			void this.#runIteration().catch(error => {
				this.#disable();
				this.port.onError?.(error);
			});
		}, this.delayMs);
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cancelTimer();
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.#listeners.clear();
	}

	async #runIteration(): Promise<void> {
		if (!this.#enabled || this.#paused || this.#prompt === undefined) return;
		if (isLoopDurationExpired(this.#limit, this.port.nowMs())) {
			this.#disable();
			return;
		}
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
		if (!this.#enabled || this.#paused || this.#prompt === undefined) return;
		if (isLoopDurationExpired(this.#limit, this.port.nowMs())) {
			this.#disable();
			return;
		}
		await this.port.submitPrompt(this.#prompt);
	}

	#disable(): boolean {
		const wasEnabled = this.#enabled;
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
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
