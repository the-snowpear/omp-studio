import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../../thinking";

export class StudioModelControlError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "BUSY_STREAMING" | "BUSY_COMPACTING" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioModelControlError";
	}
}

/** Active model of the shared session, projected without provider credentials. */
export interface StudioModelState {
	/** Canonical `provider/id` selector. */
	selector: string;
	provider: string;
	id: string;
	/** Effective level applied to the next request; absent when reasoning is disabled. */
	thinking?: string;
	/** What the operator selected: a concrete level or `auto`. */
	configuredThinking?: string;
}

type PendingSessionPreference = {
	model?: Model;
	thinking?: ConfiguredThinkingLevel;
};

/**
 * Runtime-owned session model/thinking control shared by Bridge and the
 * `studio-host` TUI. It changes only the live session — same semantics as
 * `/model` — and never writes `modelRoles` back to disk, so the GUI model pill
 * cannot silently rewrite the operator's configuration.
 *
 * A switch during streaming, compacting, or 503 auto-retry is accepted and
 * projected immediately, but `session.setModel` waits for the next user turn
 * so the in-flight request and its retries keep the previous model.
 */
export class StudioModelControlService {
	#pending: PendingSessionPreference | undefined;
	#changeListeners = new Set<() => void>();

	constructor(private readonly session: AgentSession) {}

	/** Bridge/TUI task-model switches call this so snapshots stay fresh. */
	onChange(listener: () => void): () => void {
		this.#changeListeners.add(listener);
		return () => {
			this.#changeListeners.delete(listener);
		};
	}

	#notifyChanged(): void {
		for (const listener of [...this.#changeListeners]) {
			try {
				listener();
			} catch {
				// A throwing listener must not break the switch itself.
			}
		}
	}

	state(): StudioModelState | undefined {
		const model = this.#pending?.model ?? this.session.model;
		if (model === undefined) return undefined;
		if (this.#pending?.thinking !== undefined) {
			return this.#project(model, this.#pending.thinking);
		}
		if (this.#pending?.model !== undefined) {
			const defaultLevel = this.#pending.model.thinking?.defaultLevel;
			return defaultLevel === undefined ? this.#identity(model) : this.#project(model, defaultLevel);
		}
		return this.#projectLive(model);
	}

	/** Switch the live session model, optionally pinning a thinking level with it. */
	async setModel(selector: string, thinking?: string): Promise<StudioModelState> {
		const level = thinking === undefined ? undefined : this.#parseLevel(thinking);
		const model = await this.#resolve(selector);
		if (this.#shouldDefer()) {
			this.#pending = level === undefined ? { model } : { model, thinking: level };
			return this.#requireState();
		}
		await this.#commit({ model, ...(level === undefined ? {} : { thinking: level }) });
		return this.#requireState();
	}

	/** Set the session thinking level without touching the active model. */
	setThinking(level: string): StudioModelState {
		const parsed = this.#parseLevel(level);
		if ((this.#pending?.model ?? this.session.model) === undefined) {
			throw new StudioModelControlError("COMMAND_BLOCKED", "No model is selected for this session");
		}
		if (this.#shouldDefer()) {
			this.#pending =
				this.#pending?.model === undefined
					? { thinking: parsed }
					: { model: this.#pending.model, thinking: parsed };
			return this.#requireState();
		}
		this.session.setThinkingLevel(parsed);
		return this.#requireState();
	}

	/**
	 * Apply a deferred switch to the live session. Safe to call when idle;
	 * no-ops when nothing is queued. Used at the start of the next user turn.
	 */
	async applyPending(): Promise<void> {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		try {
			await this.#commit(pending);
		} catch (error) {
			this.#pending = pending;
			throw error;
		}
	}

	/**
	 * Effective Task subagent model for this session: the `task` entry of the
	 * merged `task.agentModelOverrides` layer (runtime override first, then the
	 * persisted configuration). `undefined` means the subagent inherits the
	 * session model — including when the entry is a pattern or no longer
	 * resolves, because the resolver falls back the same way.
	 */
	taskState(): StudioModelState | undefined {
		const selector = this.#taskSelector();
		if (selector === undefined) return undefined;
		const model = this.session
			.getAvailableModels()
			.find(candidate => `${candidate.provider}/${candidate.id}` === selector || candidate.id === selector);
		return model === undefined ? undefined : this.#identity(model);
	}

	/**
	 * Pin or clear the session-scoped Task subagent model. Mirrors the TUI
	 * picker's alt+p Task mode: a runtime-only settings override that never
	 * touches disk, takes effect at the next subagent spawn, and keeps every
	 * other agent's override intact. `null` returns the subagent to whatever
	 * the persisted configuration (or inheritance) resolves to.
	 */
	async setTaskModel(selector: string | null): Promise<StudioModelState | undefined> {
		const current = this.session.settings.get("task.agentModelOverrides");
		if (selector === null) {
			const { task: _cleared, ...rest } = current;
			this.session.settings.override("task.agentModelOverrides", rest);
			this.#notifyChanged();
			return this.taskState();
		}
		const model = await this.#resolve(selector);
		const canonical = `${model.provider}/${model.id}`;
		this.session.settings.override("task.agentModelOverrides", { ...current, task: canonical });
		this.#notifyChanged();
		return this.taskState();
	}

	/** Merged `task` override entry; a pattern array projects its first member, like the TUI. */
	#taskSelector(): string | undefined {
		const entry = this.session.settings.get("task.agentModelOverrides").task;
		if (entry === undefined || entry === null) return undefined;
		const value = Array.isArray(entry) ? entry[0] : entry;
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}

	#shouldDefer(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.#pending !== undefined;
	}

	async #commit(pending: PendingSessionPreference): Promise<void> {
		if (pending.model !== undefined) {
			try {
				await this.session.setModel(pending.model);
			} catch (error) {
				throw new StudioModelControlError("COMMAND_BLOCKED", errorMessage(error));
			}
			if (pending.thinking !== undefined) this.session.setThinkingLevel(pending.thinking);
			return;
		}
		if (pending.thinking !== undefined) this.session.setThinkingLevel(pending.thinking);
	}

	#identity(model: Model): StudioModelState {
		return {
			selector: `${model.provider}/${model.id}`,
			provider: model.provider,
			id: model.id,
		};
	}

	#projectLive(model: Model): StudioModelState {
		const thinking = this.session.thinkingLevel;
		const configured = this.session.configuredThinkingLevel();
		return {
			...this.#identity(model),
			...(thinking === undefined ? {} : { thinking }),
			...(configured === undefined ? {} : { configuredThinking: configured }),
		};
	}

	#project(model: Model, level: ConfiguredThinkingLevel): StudioModelState {
		const configuredThinking = String(level);
		if (level === AUTO_THINKING) {
			const live = this.session.thinkingLevel;
			return live === undefined
				? { ...this.#identity(model), configuredThinking }
				: { ...this.#identity(model), thinking: String(live), configuredThinking };
		}
		if (level === ThinkingLevel.Off) {
			return { ...this.#identity(model), configuredThinking };
		}
		return { ...this.#identity(model), thinking: String(level), configuredThinking };
	}

	/** Accept the canonical `provider/id` selector plus a bare model id, like `/model`. */
	async #resolve(selector: string): Promise<Model> {
		const wanted = selector.trim();
		if (wanted.length === 0) throw new StudioModelControlError("INVALID_ARGUMENT", "Model selector is empty");
		let available = this.session.getAvailableModels();
		let match = available.find(model => `${model.provider}/${model.id}` === wanted || model.id === wanted);
		if (match === undefined && this.session.modelRegistry !== undefined) {
			// models.yml is written by the desktop Host in another process, so the
			// Runtime registry can still hold the pre-write snapshot. Reload local
			// configuration without starting network discovery: the model was just
			// persisted as a static `models:` entry (or is already in models.db for
			// discovery-backed providers), and `offline` still refreshes both.
			try {
				await this.session.modelRegistry.refresh("offline");
			} catch {
				// A refresh can fail after the static reload already happened; the
				// retry below still sees that partial progress.
			}
			available = this.session.getAvailableModels();
			match = available.find(model => `${model.provider}/${model.id}` === wanted || model.id === wanted);
		}
		if (match === undefined) {
			throw new StudioModelControlError("INVALID_ARGUMENT", `Model is not available: ${wanted}`);
		}
		return match;
	}

	#parseLevel(value: string): ConfiguredThinkingLevel {
		const parsed = parseConfiguredThinkingLevel(value);
		// `inherit` resolves back to the provider default, which is never what a
		// session-level selection means.
		if (parsed === undefined || parsed === ThinkingLevel.Inherit) {
			throw new StudioModelControlError("INVALID_ARGUMENT", `Unsupported thinking level: ${value}`);
		}
		return parsed;
	}

	#requireState(): StudioModelState {
		const state = this.state();
		if (state === undefined) {
			throw new StudioModelControlError("COMMAND_BLOCKED", "Session has no active model after the switch");
		}
		return state;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
