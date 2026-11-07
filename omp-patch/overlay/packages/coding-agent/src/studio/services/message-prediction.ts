import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ComposerPredictionController, predictionAnchor } from "../../modes/controllers/composer-prediction-controller";
import type { AgentSession } from "../../session/agent-session";
import { cfgComposerPredictions } from "../../modes/settings";

/** Reuses native prediction, normalization, deadline and usage accounting on the private editor channel. */
export class StudioMessagePrediction {
	readonly #controller: ComposerPredictionController;
	readonly #tried = new WeakSet<AgentMessage>();
	readonly #unsubscribe: () => void;
	readonly #unsubscribeSettings: () => void;
	#active: { channelId: string; revision: number; text: string } | undefined;
	#disposed = false;
	get running(): boolean {
		return this.#controller.running;
	}
	constructor(
		readonly session: AgentSession,
		readonly publish: (
			channelId: string,
			revision: number,
			text: string | null,
			choices?: readonly string[],
			rank?: number,
		) => void,
	) {
		const owner = this;
		this.#controller = new ComposerPredictionController({
			get settings() {
				return session.settings;
			},
			get viewSession() {
				return session;
			},
			editor: { getText: () => this.#active?.text ?? "draft" },
			ui: {
				requestRender() {
					owner.#show();
				},
			},
		});
		this.#unsubscribe = session.subscribe(event => {
			if (
				event.type === "agent_start" ||
				event.type === "auto_compaction_start" ||
				event.type === "manual_compaction_start"
			)
				this.#controller.cancel();
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
	update(channelId: string, revision: number, empty: boolean, text?: string): void {
		if (this.#active?.channelId === channelId && revision < this.#active.revision) return;
		const prefix = text?.trimEnd() ?? (empty ? "" : "draft");
		if (
			this.#active?.channelId !== channelId ||
			(prefix && !this.#controller.choices?.some(choice => choice.startsWith(prefix)))
		)
			this.#controller.cancel();
		this.#active = { channelId, revision, text: prefix };
		this.#show();
		if (!prefix) this.#request();
	}
	shown(channelId: string, revision: number): void {
		if (this.#active?.channelId === channelId && this.#active.revision === revision) this.#controller.shown();
	}
	accepted(channelId: string, revision: number, rank: number): void {
		if (this.#active?.channelId === channelId && this.#active.revision === revision) this.#controller.accepted(rank);
	}
	release(channelId: string): void {
		if (this.#active?.channelId !== channelId) return;
		this.#active = undefined;
		this.#controller.cancel();
	}
	dismiss(channelId: string, revision: number, accepted = false): boolean {
		if (this.#active?.channelId !== channelId || this.#active.revision !== revision || !this.#controller.choices)
			return false;
		if (accepted) this.#controller.accepted(0);
		this.release(channelId);
		return true;
	}
	#show(): void {
		const active = this.#active;
		if (this.#disposed || !active) return;
		const choices = this.#controller.choices;
		const rank = choices?.findIndex(choice => choice.startsWith(active.text)) ?? -1;
		this.publish(
			active.channelId,
			active.revision,
			rank >= 0 ? choices![rank]!.slice(active.text.length) : null,
			choices,
			rank >= 0 ? rank : undefined,
		);
	}
	#request(): void {
		if (
			this.#disposed ||
			!this.#active ||
			this.#active.text !== "" ||
			!cfgComposerPredictions.get(this.session.settings) ||
			this.session.isStreaming ||
			this.session.isCompacting
		)
			return;
		const last = predictionAnchor(this.session);
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
