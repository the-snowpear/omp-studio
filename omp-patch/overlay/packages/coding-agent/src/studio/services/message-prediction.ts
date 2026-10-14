import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ComposerPredictionController } from "../../modes/controllers/composer-prediction-controller";
import type { AgentSession } from "../../session/agent-session";
import { cfgComposerPredictions } from "../../modes/settings";

/** Reuses native prediction, normalization, deadline and usage accounting on the private editor channel. */
export class StudioMessagePrediction {
	readonly #controller: ComposerPredictionController;
	readonly #tried = new WeakSet<AgentMessage>();
	readonly #unsubscribe: () => void;
	readonly #unsubscribeSettings: () => void;
	#active: { channelId: string; revision: number; empty: boolean } | undefined;
	#disposed = false;
	get running(): boolean {
		return this.#controller.running;
	}
	constructor(
		readonly session: AgentSession,
		readonly publish: (channelId: string, revision: number, text: string | null) => void,
	) {
		const owner = this;
		this.#controller = new ComposerPredictionController({
			get settings() {
				return session.settings;
			},
			get viewSession() {
				return session;
			},
			editor: { getText: () => (this.#active?.empty ? "" : "draft") },
			ui: {
				requestRender() {
					owner.#show();
				},
			},
		});
		this.#unsubscribe = session.subscribe(event => {
			if (event.type === "agent_start" || event.type === "auto_compaction_start") this.#controller.cancel();
			if (event.type === "agent_end" && event.isTerminal !== false) {
				void session
					.waitForIdle()
					.then(() => this.#request())
					.catch(() => {});
			}
		});
		this.#unsubscribeSettings = cfgComposerPredictions.listen(session.settings, () => {
			if (!cfgComposerPredictions.get(session.settings)) this.#controller.cancel();
		});
	}
	update(channelId: string, revision: number, empty: boolean): void {
		if (this.#active?.channelId === channelId && revision < this.#active.revision) return;
		if (this.#active?.channelId !== channelId || !empty) this.#controller.cancel();
		this.#active = { channelId, revision, empty };
		if (empty) {
			this.#show();
			this.#request();
		}
	}
	release(channelId: string): void {
		if (this.#active?.channelId !== channelId) return;
		this.#active = undefined;
		this.#controller.cancel();
	}
	dismiss(channelId: string, revision: number): boolean {
		if (this.#active?.channelId !== channelId || this.#active.revision !== revision || !this.#active.empty)
			return false;
		this.release(channelId);
		return true;
	}
	#show(): void {
		const active = this.#active;
		if (!this.#disposed && active?.empty)
			this.publish(active.channelId, active.revision, this.#controller.text ?? null);
	}
	#request(): void {
		if (
			this.#disposed ||
			!this.#active?.empty ||
			!cfgComposerPredictions.get(this.session.settings) ||
			this.session.isStreaming ||
			this.session.isCompacting
		)
			return;
		const last = this.session.messages.at(-1);
		if (!last || last.role !== "assistant" || this.#tried.has(last)) return;
		this.#tried.add(last);
		this.#controller.request();
	}
	dispose(): void {
		this.#disposed = true;
		this.#active = undefined;
		this.#controller.cancel();
		this.#unsubscribe();
		this.#unsubscribeSettings();
	}
}
