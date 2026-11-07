import { redactSensitiveCredentials, withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { STTController, type STTControllerDependencies } from "../../stt/stt-controller";
import type {
	DictationCaptureState,
	DictationEvent,
	DictationInput,
	DictationConfiguration,
} from "../dictation-protocol";

const MAX_TEXT_LENGTH = 16384;
const MAX_SEQUENCE = 0xffffffff;

type AudioReceiver = (error: Error | null, samples: Float32Array) => void;

/** One native capture. Its state and text exist only on the authenticated audio sideband. */
export class StudioDictationCapture {
	#state: DictationCaptureState = { phase: "prepared", committedText: "", partialText: "", submit: false };
	#controller: STTController | undefined;
	#receiver: AudioReceiver | undefined;
	#closed = false;
	#terminal = false;
	#sequence = 0;
	#lastState: string | undefined;
	#flushTimer: NodeJS.Timeout | undefined;
	#flushDeadline: PromiseWithResolvers<void> | undefined;
	#starting: Promise<void> | undefined;
	#stopping: Promise<void> | undefined;

	constructor(
		readonly audioId: string,
		readonly configuration: DictationConfiguration,
		readonly dependencies: STTControllerDependencies,
		readonly options: {
			send: (event: DictationEvent) => void;
			close: () => void;
			currentConfigurationId: () => string;
			flushTimeoutMs?: number;
		},
	) {}

	get phase(): DictationCaptureState["phase"] {
		return this.#state.phase;
	}

	#current(): boolean {
		return !this.#closed && !this.#terminal;
	}

	#send(event: DictationEvent): void {
		if (this.#closed) return;
		if (this.#sequence > MAX_SEQUENCE) {
			this.dispose();
			this.options.close();
			return;
		}
		event.sequence = this.#sequence++;
		this.options.send(event);
	}

	#publish(snapshot = false): void {
		if (this.#closed) return;
		const encoded = JSON.stringify(this.#state);
		if (!snapshot && this.#lastState === encoded) return;
		this.#lastState = encoded;
		this.#send({ kind: "state", audioId: this.audioId, sequence: 0, state: { ...this.#state } });
	}

	#patch(patch: Partial<DictationCaptureState>): void {
		if (!this.#current()) return;
		this.#state = { ...this.#state, ...patch };
		this.#publish();
	}

	#finish(phase: "complete" | "error" | "cancelled", patch: Partial<DictationCaptureState> = {}): void {
		if (!this.#current()) return;
		this.#state = {
			...this.#state,
			...patch,
			phase,
			progress: undefined,
			...(phase === "error" ? {} : { partialText: "" }),
			...(phase === "complete" ? {} : { submit: false }),
			...(phase === "cancelled" ? { committedText: "" } : {}),
		};
		this.#terminal = true;
		this.#receiver = undefined;
		this.#flushDeadline?.resolve();
		this.#flushDeadline = undefined;
		if (this.#flushTimer) clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#controller?.dispose();
		this.#controller = undefined;
		this.#publish();
		this.options.close();
	}

	fail(code: string, message: string): void {
		const detail = withCredentialRedaction(true, () => redactSensitiveCredentials(message))
			.replace(/https?:\/\/[^\s<>"']+/giu, "[endpoint]")
			.slice(0, 1024);
		this.#finish("error", { error: { code, message: detail } });
	}

	/** Called synchronously in frame order, before a following drain can be acknowledged. */
	consumeAudio(samples: Float32Array): void {
		if (!this.#current()) return;
		if (this.#state.phase !== "recording" || !this.#receiver) {
			this.fail(
				"RECEIVER_NOT_READY",
				"Wait for the dictation receiver and recording acknowledgement before sending audio",
			);
			return;
		}
		this.#receiver(null, samples);
	}

	input(input: DictationInput): void {
		if (!this.#current()) return;
		if (input.kind === "snapshot") {
			this.#publish(true);
			return;
		}
		if (input.kind === "ping") return;
		if (input.kind === "cancel") {
			this.#finish("cancelled");
			return;
		}
		if (input.kind === "stop") {
			if (this.#state.phase === "prepared" || this.#state.phase === "preparing" || this.#state.phase === "ready") {
				this.#finish("cancelled", { message: "Stopped before microphone recording began" });
			} else if (!this.#stopping) this.#stopping = this.#stop();
			return;
		}
		if (input.kind === "drain") {
			if (this.#state.phase !== "recording") {
				this.fail("RECEIVER_NOT_READY", "Drain requires a recording receiver");
				return;
			}
			// The socket parser has already synchronously delivered every preceding
			// PCM frame to the native capture callback, preserving worker message order.
			this.#send({ kind: "drained", audioId: this.audioId, sequence: 0, requestId: input.requestId });
			return;
		}
		if (input.kind === "recording") {
			if (this.#state.phase === "recording") return;
			if (this.#state.phase !== "ready") {
				this.fail("RECEIVER_NOT_READY", "The native speech receiver is not ready");
				return;
			}
			this.#patch({ phase: "recording", message: undefined });
			return;
		}
		if (input.kind === "start") {
			if (this.#starting) return;
			if (
				input.configurationId !== this.configuration.configurationId ||
				input.configurationId !== this.options.currentConfigurationId()
			) {
				this.fail("CONFIGURATION_CHANGED", "Voice configuration changed; inspect and open a new dictation channel");
				return;
			}
			this.#starting = this.#start(input.mode).catch(error =>
				this.fail("STT_FAILED", error instanceof Error ? error.message : "Dictation preparation failed"),
			);
		}
	}

	async #start(mode: "click" | "hold" | "toggle" | "retry"): Promise<void> {
		this.#patch({ phase: "preparing" });
		const controller = new STTController(onAudio => {
			if (!this.#current()) throw new Error("Dictation capture closed while preparing");
			if (this.configuration.configurationId !== this.options.currentConfigurationId()) {
				this.fail("CONFIGURATION_CHANGED", "Voice configuration changed while preparing; open a new channel");
				throw new Error("Dictation configuration changed");
			}
			this.#receiver = onAudio;
			return {
				stop: () => {
					this.#receiver = undefined;
				},
			};
		}, this.dependencies);
		this.#controller = controller;
		try {
			await controller.start(
				{
					setVolatileText: text => {
						if (text.length + this.#state.committedText.length > MAX_TEXT_LENGTH) {
							this.fail(
								"TEXT_LIMIT",
								"Dictation text reached its limit; keep the recognized text and start another capture",
							);
							return;
						}
						this.#patch({ partialText: text });
					},
					clearVolatileText: () => this.#patch({ partialText: "" }),
					commitVolatileText: text => {
						if (this.#state.committedText.length + text.length > MAX_TEXT_LENGTH) {
							this.fail(
								"TEXT_LIMIT",
								"Dictation text reached its limit; keep the recognized text and start another capture",
							);
							return;
						}
						this.#patch({ committedText: this.#state.committedText + text, partialText: "" });
					},
					submit: () => {
						if (this.#current()) this.#state.submit = true;
					},
					deleteBeforeCursor: count =>
						this.#patch({
							committedText: this.#state.committedText.slice(
								0,
								Math.max(0, this.#state.committedText.length - count),
							),
						}),
				},
				{
					manualSubmit: mode === "click" || mode === "retry",
					waitForModel: true,
					onProgress: progress =>
						this.#patch({
							progress: {
								stage: progress.status,
								component: progress.component ?? progress.label,
								percent: progress.total > 0 ? progress.percent : undefined,
								loaded: progress.loaded,
								total: progress.total,
							},
						}),
					showStatus: message =>
						this.#patch({
							message: message.slice(0, 1024),
							...(message === "No speech detected." ? { notice: "no-speech" } : {}),
						}),
					showWarning: message => this.fail("STT_FAILED", message),
					onStateChange: state => {
						if (!this.#current()) return;
						if (state === "recording") {
							if (!this.#receiver) {
								this.fail("RECEIVER_NOT_READY", "Speech receiver did not attach");
								return;
							}
							this.#patch({ phase: "ready", progress: undefined, message: undefined });
						} else if (state === "transcribing") this.#patch({ phase: "transcribing", progress: undefined });
						// idle can precede showWarning on a microphone error. The stop
						// promise, not idle, owns the single terminal event.
					},
				},
			);
			if (this.#current() && controller.state !== "recording")
				this.fail("STT_NOT_STARTED", "Native dictation did not become ready");
		} catch (error) {
			this.fail("STT_FAILED", error instanceof Error ? error.message : "Dictation preparation failed");
		}
	}

	async #stop(): Promise<void> {
		const controller = this.#controller;
		if (!controller || !this.#current()) return;
		this.#patch({ phase: "transcribing" });
		const deadline = Promise.withResolvers<void>();
		this.#flushDeadline = deadline;
		this.#flushTimer = setTimeout(
			() => deadline.reject(new Error("Dictation flush timed out")),
			this.options.flushTimeoutMs ?? 120000,
		);
		try {
			await Promise.race([
				(async () => {
					await this.#starting;
					if (this.#current()) await controller.stop();
				})(),
				deadline.promise,
			]);
			if (this.#current())
				this.#finish("complete", this.#state.committedText ? {} : { notice: "no-speech", submit: false });
		} catch (error) {
			this.fail("STT_FAILED", error instanceof Error ? error.message : "Dictation flush failed");
		} finally {
			if (this.#flushTimer) clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
	}

	dispose(): void {
		this.#closed = true;
		this.#receiver = undefined;
		this.#flushDeadline?.resolve();
		this.#flushDeadline = undefined;
		if (this.#flushTimer) clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#controller?.dispose();
		this.#controller = undefined;
		this.#state = { phase: "cancelled", committedText: "", partialText: "", submit: false };
	}
}
