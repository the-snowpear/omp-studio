import { STTController, type SttTarget, type SttCallbacks } from "../../stt";
import { cfgSttEnabled, cfgSttLanguage } from "../../stt/settings";
import { resolveSttModelSpec } from "../../stt/models";
import { isSttModelCached } from "../../stt/downloader";
import type { DictationOperation, DictationState } from "../dictation-protocol";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LiveSessionController, type LiveSessionControllerOptions } from "../../live/controller";
import type { AgentSession } from "../../session/agent-session";
import {
	type LiveAudioOperation,
	type LiveAudioState,
	validateLiveAudioOperation,
	validateLiveAudioResult,
} from "../live-audio-protocol";
import { StudioLiveError, type StudioLiveService, type StudioLiveSessionFactory } from "./live-service";

interface Controller {
	start(): Promise<void>;
	stop(): Promise<void>;
	toggleMute(): void;
	readonly muted: boolean;
}
export interface DictationControllerPort {
	readonly state: "idle" | "recording" | "transcribing";
	start(target: SttTarget, callbacks: SttCallbacks): Promise<void>;
	stop(): Promise<void>;
	dispose(): void;
}
interface Capture {
	kind?: "live" | "dictation";
	id: string;
	sessionId: string;
	voice: string;
	token: string;
	endpoint: string;
	descriptor: string;
	server: Server;
	peers: Set<Socket>;
	socket?: Socket;
	timer: ReturnType<typeof setTimeout>;
	onAudio?: (error: Error | null, samples: Float32Array) => void;
	controller?: Controller;
	started: boolean;
	closed: boolean;
}
const blank = (available: boolean): LiveAudioState => ({
	available,
	attached: false,
	voice: "sol",
	phase: "off",
	muted: false,
	inputLevel: 0,
	outputLevel: 0,
	transcripts: [],
});
/** macOS `sun_path` holds 104 bytes including the NUL; Node rejects longer paths with EINVAL. */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
/**
 * Socket name for one audio id, identical to `liveAudioSocketName` in
 * `@omp-studio/studio-host` (`socket-paths.ts`): Desktop connects only to the
 * endpoint it derives itself, so both copies assert the same test vector.
 */
export function liveAudioSocketName(audioId: string): string {
	return `a-${createHash("sha256").update(audioId).digest("hex").slice(0, 16)}.sock`;
}
/** Private authenticated PCM transport. No credentials or audio bytes cross the Studio ledger. */
export class StudioLiveAudioService {
	readonly #root: string | undefined;
	/** POSIX only: the Host's short private socket directory (`OMP_STUDIO_SOCKET_DIR`). */
	readonly #socketDirectory: string | undefined;
	readonly #available: boolean;
	readonly #unsubscribe: () => void;
	#dictationController: DictationControllerPort | undefined;
	#dictationText = "";
	#dictationVolatile = "";
	#dictationGeneration = 0;
	#dictationState: DictationState = {
		available: false,
		enabled: false,
		phase: "off",
		text: "",
		model: "",
		language: "",
		cloud: false,
		downloadRequired: false,
	};
	#dictationStop: Promise<DictationState> | undefined;
	#dictationStart: Promise<void> | undefined;
	#capture?: Capture;
	#state: LiveAudioState;
	#disposed = false;
	#control?: StudioLiveService;
	bindControl(control: StudioLiveService): void {
		this.#control = control;
	}
	#operations: Promise<unknown> = Promise.resolve();
	readonly factory: StudioLiveSessionFactory;
	constructor(
		readonly session: AgentSession,
		readonly options: {
			directory?: string;
			socketDirectory?: string;
			createDictationController?: (
				createCapture: (onAudio: (error: Error | null, samples: Float32Array) => void) => { stop(): void },
			) => DictationControllerPort;
			createController?: (options: LiveSessionControllerOptions) => Controller;
			prepareTimeoutMs?: number;
			dictationFlushTimeoutMs?: number;
		} = {},
	) {
		this.#root = options.directory ?? process.env.OMP_STUDIO_MEDIA_ROOT;
		this.#socketDirectory = options.socketDirectory ?? process.env.OMP_STUDIO_SOCKET_DIR;
		this.#available = !!this.#root && (process.platform === "win32" || !!this.#socketDirectory);
		this.#state = blank(this.#available);
		this.factory = {
			create: callbacks => {
				const capture = this.#capture;
				if (
					!capture ||
					capture.closed ||
					capture.id !== callbacks.deviceId ||
					capture.sessionId !== this.session.sessionId ||
					!capture.socket ||
					capture.started
				)
					throw new StudioLiveError(
						"COMMAND_BLOCKED",
						"Attach this window's authenticated microphone before starting Live",
					);
				if (capture.kind === "dictation")
					throw new StudioLiveError("COMMAND_BLOCKED", "End dictation before starting Live");
				capture.started = true;
				clearTimeout(capture.timer);
				this.#state.phase = "connecting";
				const controller = (this.options.createController ?? (options => new LiveSessionController(options)))({
					session: this.session,
					voice: capture.voice,
					extractAssistantText: message =>
						message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n"),
					createAudioInput: onAudio => {
						if (capture.closed || !capture.socket) throw new Error("Microphone detached while connecting");
						capture.onAudio = onAudio;
						return {
							stop: () => {
								capture.onAudio = undefined;
								this.#closeSocket(capture);
							},
						};
					},
					callbacks: {
						onPhase: phase => {
							if (this.#capture !== capture || capture.closed) return;
							this.#state.phase = phase;
							if (phase === "listening") callbacks.onActive();
						},
						onLevels: (input, output) => {
							if (this.#capture !== capture || capture.closed) return;
							this.#state.inputLevel = input;
							this.#state.outputLevel = output;
						},
						onTranscript: transcript => {
							if (this.#capture !== capture || capture.closed || !transcript) return;
							const item = { ...transcript, text: transcript.text.slice(-2000) };
							const index = this.#state.transcripts.findIndex(
								row => row.role === item.role && row.turn === item.turn,
							);
							if (index >= 0) this.#state.transcripts[index] = item;
							else this.#state.transcripts.push(item);
							this.#state.transcripts = this.#state.transcripts.slice(-40);
						},
						onTerminal: error => {
							if (this.#capture === capture) {
								this.#state.phase = error ? "error" : "off";
								if (error)
									this.#state.error =
										"Live stopped. Check the Codex OAuth account, microphone and network before reconnecting.";
								this.#state.inputLevel = this.#state.outputLevel = 0;
							}
							this.#closeSocket(capture);
							callbacks.onTerminal(error ? new Error("Live connection failed") : undefined);
						},
					},
				});
				capture.controller = controller;
				return { start: () => controller.start(), stop: () => this.#release(capture) };
			},
		};
		this.#unsubscribe =
			session.registerSessionChangeCallback?.(() => {
				const capture = this.#capture;
				if (capture && capture.sessionId !== session.sessionId) {
					this.#cancelDictation();
					void this.#release(capture).catch(() => {});
				}
			}) ?? (() => {});
	}
	#captureActive(): boolean {
		return !!this.#capture && (!this.#capture.closed || !["off", "error"].includes(this.#state.phase));
	}
	get running(): boolean {
		return !!this.#dictationController || this.#captureActive();
	}
	dispose(): void {
		this.#disposed = true;
		this.#cancelDictation();
		this.#unsubscribe();
		if (this.#capture) void this.#release(this.#capture).catch(() => {});
	}

	async dictation(operation: DictationOperation): Promise<DictationState> {
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new StudioLiveError("COMMAND_BLOCKED", "Dictation requires the active session");
		if (operation.kind === "dictation.status") return this.#dictationStatus();
		if (operation.kind === "dictation.prepare") {
			if (!cfgSttEnabled.get(this.session.settings))
				throw new StudioLiveError("COMMAND_BLOCKED", "Enable draft dictation in voice settings first");
			if (this.running)
				throw new StudioLiveError("COMMAND_BLOCKED", "End Live or dictation before starting another capture");
			this.#cancelDictation();
			await this.#prepare(operation.sessionId, "dictation");
			const capture = this.#capture!;
			capture.kind = "dictation";
			this.#dictationState = {
				...(await this.#dictationStatus()),
				audioId: capture.id,
				phase: "prepared",
				text: "",
			};
			return { ...this.#dictationState };
		}
		const capture = this.#capture;
		if (
			!capture ||
			capture.kind !== "dictation" ||
			capture.id !== operation.audioId ||
			capture.sessionId !== operation.sessionId
		)
			throw new StudioLiveError("COMMAND_BLOCKED", "Dictation capture expired");
		if (operation.kind === "dictation.cancel") {
			this.#cancelDictation();
			this.#closeSocket(capture);
			this.#state.phase = "off";
			return { ...this.#dictationState };
		}
		if (operation.kind === "dictation.stop") return this.#stopDictation(capture);
		if (this.#dictationController || !capture.socket || capture.closed)
			throw new StudioLiveError("COMMAND_BLOCKED", "Attach the microphone before starting dictation");
		const generation = ++this.#dictationGeneration;
		capture.started = true;
		clearTimeout(capture.timer);
		this.#dictationText = this.#dictationVolatile = "";
		this.#dictationState = { ...this.#dictationState, phase: "starting", text: "" };
		const current = () =>
			generation === this.#dictationGeneration && operation.sessionId === this.session.sessionId && !this.#disposed;
		const publish = () => {
			if (current()) this.#dictationState.text = (this.#dictationText + this.#dictationVolatile).slice(0, 65536);
		};
		const target: SttTarget = {
			setVolatileText: text => {
				if (current()) {
					this.#dictationVolatile = text.slice(0, 65536);
					publish();
				}
			},
			clearVolatileText: () => {
				if (current()) {
					this.#dictationVolatile = "";
					publish();
				}
			},
			commitVolatileText: text => {
				if (current()) {
					this.#dictationText = (this.#dictationText + text).slice(0, 65536);
					this.#dictationVolatile = "";
					publish();
				}
			},
			submit: () => {
				throw new Error("Draft dictation cannot submit a prompt");
			},
			deleteBeforeCursor: () => {
				throw new Error("Draft dictation cannot edit a prompt");
			},
		};
		const createCapture = (onAudio: (error: Error | null, samples: Float32Array) => void) => {
			if (!capture.socket || capture.closed) throw new Error("Microphone detached");
			capture.onAudio = onAudio;
			return {
				stop: () => {
					capture.onAudio = undefined;
				},
			};
		};
		const controller =
			this.options.createDictationController?.(createCapture) ??
			new STTController(createCapture, {
				settings: this.session.settings,
				registry: this.session.modelRegistry,
				getSessionId: () => operation.sessionId,
			});
		this.#dictationController = controller;
		const start = controller.start(target, {
			manualSubmit: true,
			showStatus: () => {},
			showWarning: message => {
				if (current()) this.#dictationState = { ...this.#dictationState, phase: "error", error: message };
			},
			onStateChange: state => {
				if (!current()) return;
				this.#dictationState.phase = state === "idle" ? "complete" : state;
				publish();
			},
		});
		this.#dictationStart = start;
		void start
			.then(
				() => {
					if (current() && controller.state !== "recording")
						this.#dictationState.phase = this.#dictationState.error ? "error" : "complete";
				},
				error => {
					if (current())
						this.#dictationState = {
							...this.#dictationState,
							phase: "error",
							error: error instanceof Error ? error.message : "Dictation start failed",
						};
				},
			)
			.finally(() => {
				if (current() && this.#dictationState.phase === "error") {
					controller.dispose();
					if (this.#dictationController === controller) this.#dictationController = undefined;
					this.#state.phase = "off";
					this.#closeSocket(capture);
				}
			});
		return { ...this.#dictationState };
	}

	async #dictationStatus(): Promise<DictationState> {
		const model = this.session.resolveRoleModel("dictation");
		const cloud = model !== undefined && model.api !== "local-inference";
		const spec = resolveSttModelSpec(model?.id);
		return {
			...this.#dictationState,
			available: this.#available,
			enabled: cfgSttEnabled.get(this.session.settings),
			model: model ? model.provider + "/" + model.id : spec.key,
			language: cfgSttLanguage.get(this.session.settings),
			cloud,
			downloadRequired: !cloud && !(await isSttModelCached(spec.key)),
			...(cloud ? {} : { downloadSize: spec.sizeHint }),
		};
	}

	#cancelDictation(): void {
		this.#dictationGeneration++;
		this.#dictationController?.dispose();
		this.#dictationController = undefined;
		this.#dictationStart = undefined;
		this.#dictationStop = undefined;
		this.#dictationText = this.#dictationVolatile = "";
		this.#dictationState = { ...this.#dictationState, phase: "off", text: "" };
	}

	#stopDictation(capture: Capture): Promise<DictationState> {
		if (this.#dictationStop) return this.#dictationStop;
		const generation = this.#dictationGeneration;
		const controller = this.#dictationController;
		if (!controller) return Promise.resolve({ ...this.#dictationState });
		// No new samples after stop, but the transport stays attached until flush completes.
		capture.onAudio = undefined;
		capture.socket?.setTimeout(0);
		this.#dictationState.phase = "transcribing";
		this.#dictationStop = (async () => {
			const deadline = Promise.withResolvers<void>();
			const timer = setTimeout(
				() => deadline.reject(new Error("Dictation flush timed out")),
				this.options.dictationFlushTimeoutMs ?? 120000,
			);
			try {
				await Promise.race([
					(async () => {
						await controller.stop();
						await this.#dictationStart;
						if (controller.state === "recording") await controller.stop();
					})(),
					deadline.promise,
				]);
				if (generation === this.#dictationGeneration)
					this.#dictationState.phase = this.#dictationState.error ? "error" : "complete";
			} catch (error) {
				if (generation === this.#dictationGeneration)
					this.#dictationState = {
						...this.#dictationState,
						phase: "error",
						error: error instanceof Error ? error.message : "Dictation failed",
					};
			} finally {
				clearTimeout(timer);
				controller.dispose();
				if (this.#dictationController === controller) this.#dictationController = undefined;
				if (generation === this.#dictationGeneration) this.#state.phase = "off";
				this.#closeSocket(capture);
			}
			return { ...this.#dictationState };
		})();
		return this.#dictationStop;
	}

	execute(operation: LiveAudioOperation): Promise<LiveAudioState> {
		const work = this.#operations.then(async () => {
			validateLiveAudioOperation(operation);
			if (this.#disposed || operation.sessionId !== this.session.sessionId)
				throw new StudioLiveError("COMMAND_BLOCKED", "Live audio requires the active session");
			if (operation.kind === "live.audio.prepare")
				await this.#prepare(operation.sessionId, operation.voice ?? "sol");
			else if (operation.kind !== "live.audio.status") {
				const capture = this.#capture;
				if (!capture || operation.audioId !== capture.id || capture.sessionId !== operation.sessionId)
					throw new StudioLiveError("COMMAND_BLOCKED", "This Live call has ended or belongs to another window");
				if (operation.kind === "live.audio.release") await this.#release(capture);
				else if (operation.kind === "live.audio.start") {
					if (!this.#control)
						throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "Live controller is unavailable");
					void this.#control.start(capture.id).catch(() => {
						if (this.#capture === capture) {
							this.#state.phase = "error";
							this.#state.error = "Live connection failed; check your Codex OAuth account and network.";
							this.#closeSocket(capture);
						}
					});
				} else {
					if (!capture.controller || capture.closed)
						throw new StudioLiveError("COMMAND_BLOCKED", "Start Live before changing mute");
					if (capture.controller.muted !== operation.muted) capture.controller.toggleMute();
					this.#state.muted = capture.controller.muted;
				}
			}
			const state = this.#capture?.sessionId === operation.sessionId ? this.#state : blank(this.#available);
			validateLiveAudioResult(operation.kind, state);
			return structuredClone(state);
		});
		this.#operations = work.catch(() => {});
		return work;
	}
	/** The socket goes in the Host's short directory; the media root is far too long for `sun_path`. */
	#socketEndpoint(id: string): string {
		const endpoint = this.#socketDirectory ? join(this.#socketDirectory, liveAudioSocketName(id)) : undefined;
		if (endpoint === undefined || Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES)
			throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "The desktop audio socket directory is unavailable");
		return endpoint;
	}
	async #prepare(sessionId: string, voice: string): Promise<void> {
		if (!this.#root) throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "The desktop audio boundary is unavailable");
		if (this.running)
			throw new StudioLiveError("COMMAND_BLOCKED", "Stop the current Live call before preparing another");
		const id = randomUUID(),
			token = randomBytes(32).toString("hex");
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${id}` : this.#socketEndpoint(id);
		const dir = join(this.#root, "audio");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const descriptor = join(dir, id + ".json");
		const server = createServer(socket => this.#peer(capture, socket));
		const capture: Capture = {
			id,
			sessionId,
			voice,
			token,
			endpoint,
			descriptor,
			server,
			peers: new Set(),
			started: false,
			closed: false,
			timer: setTimeout(() => {
				void this.#release(capture).catch(() => {});
			}, this.options.prepareTimeoutMs ?? 30000),
		};
		capture.timer.unref?.();
		this.#capture = capture;
		this.#state = { ...blank(true), audioId: id, voice, phase: "prepared" };
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			server.on("error", () => {
				void this.#release(capture).catch(() => {});
			});
			if (capture.closed || sessionId !== this.session.sessionId || this.#disposed)
				throw new Error("Session changed while preparing audio");
			await writeFile(
				descriptor,
				JSON.stringify({
					version: 1,
					audioId: id,
					sessionId,
					endpoint,
					token,
					expiresAt: Date.now() + (this.options.prepareTimeoutMs ?? 30000),
				}),
				{ mode: 0o600, flag: "wx" },
			);
		} catch (cause) {
			await this.#release(capture);
			throw cause;
		}
	}
	#peer(capture: Capture, socket: Socket): void {
		if (capture.closed || capture.socket || capture.peers.size >= 4) {
			socket.destroy();
			return;
		}
		capture.peers.add(socket);
		socket.setTimeout(3000, () => socket.destroy());
		let authenticated = false;
		let pending = Buffer.alloc(0);
		socket.on("error", () => {});
		socket.on("data", data => {
			if (typeof data === "string" || capture.closed || pending.length + data.length > 128 * 1024) {
				socket.destroy();
				return;
			}
			pending = Buffer.concat([pending, data]);
			if (!authenticated) {
				if (pending.length < 65) return;
				if (
					capture.socket ||
					pending[64] !== 10 ||
					!timingSafeEqual(Buffer.from(capture.token), pending.subarray(0, 64))
				) {
					socket.destroy();
					return;
				}
				authenticated = true;
				capture.socket = socket;
				this.#state.attached = true;
				pending = pending.subarray(65);
				socket.setTimeout(5000, () => socket.destroy());
				socket.write("OK\n");
				void unlink(capture.descriptor).catch(() => {});
			}
			while (pending.length >= 4) {
				const length = pending.readUInt32LE(0);
				if (length < 4 || length > 12800 || length % 4) {
					socket.destroy();
					return;
				}
				if (pending.length < length + 4) break;
				const samples = new Float32Array(length / 4);
				for (let i = 0; i < samples.length; i++) {
					const value = pending.readFloatLE(4 + i * 4);
					if (!Number.isFinite(value) || Math.abs(value) > 1) {
						socket.destroy();
						return;
					}
					samples[i] = value;
				}
				pending = pending.subarray(4 + length);
				capture.onAudio?.(null, samples);
			}
		});
		socket.once("close", () => {
			capture.peers.delete(socket);
			if (capture.socket !== socket) return;
			capture.socket = undefined;
			if (this.#capture === capture) this.#state.attached = false;
			if (!capture.closed) {
				if (capture.kind === "dictation") this.#cancelDictation();
				void this.#release(capture).catch(() => {});
			}
		});
	}
	#closeSocket(capture: Capture): void {
		if (capture.closed) return;
		capture.closed = true;
		clearTimeout(capture.timer);
		capture.onAudio = undefined;
		capture.socket = undefined;
		for (const socket of capture.peers) socket.destroy();
		capture.peers.clear();
		if (capture.server.listening) capture.server.close();
		else capture.server.once("listening", () => capture.server.close());
		void unlink(capture.descriptor).catch(() => {});
		if (this.#capture === capture) this.#state.attached = false;
	}
	async #release(capture: Capture): Promise<void> {
		this.#closeSocket(capture);
		await capture.controller?.stop();
		if (this.#capture === capture) {
			this.#state.phase = "off";
			this.#state.inputLevel = this.#state.outputLevel = 0;
			this.#state.muted = false;
		}
	}
}
