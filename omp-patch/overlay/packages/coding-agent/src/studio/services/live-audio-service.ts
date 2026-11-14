import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LiveSessionController, type LiveSessionControllerOptions } from "../../live/controller";
import type { AgentSession } from "../../session/agent-session";
import { isSttModelCached } from "../../stt/downloader";
import { resolveSttModelSpec } from "../../stt/models";
import type {
	DictationChannel,
	DictationConfiguration,
	DictationInput,
	DictationOperation,
	DictationState,
} from "../dictation-protocol";
import { type LiveAudioOperation, type LiveAudioState } from "../live-audio-protocol";
import { StudioLiveError, type StudioLiveService, type StudioLiveSessionFactory } from "./live-service";
import { StudioDictationCapture } from "./dictation-capture";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { inspectDictationConfiguration } from "./dictation-configuration";

interface Controller {
	readonly sdpAnswer?: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	toggleMute(): void;
	readonly muted: boolean;
}
interface Capture {
	kind: "live" | "dictation";
	id: string;
	sessionId: string;
	voice: string;
	token: string;
	endpoint: string;
	descriptor: string;
	server: Server;
	peers: Set<Socket>;
	socket?: Socket;
	timer?: NodeJS.Timeout;
	expiresAt: number;
	onAudio?: (error: Error | null, samples: Float32Array) => void;
	controller?: Controller;
	dictation?: StudioDictationCapture;
	started: boolean;
	closed: boolean;
}
interface WebRtcCapture {
	kind: "webrtc";
	id: string;
	sessionId: string;
	voice: string;
	sdpOffer: string;
	ownerTimer?: NodeJS.Timeout;
	controller?: Controller;
	started: boolean;
	closed: boolean;
}
type LiveCaptureTarget = Capture | WebRtcCapture;
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
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const MAX_PENDING_AUDIO_BYTES = 128 * 1024;
const MAX_OUTBOUND_DICTATION_BYTES = 512 * 1024;
/** Same deterministic name as the Desktop Host, including macOS sun_path budget. */
export function liveAudioSocketName(audioId: string): string {
	return `a-${createHash("sha256").update(audioId).digest("hex").slice(0, 16)}.sock`;
}
/** Private authenticated audio transport. No audio, temporary text or credentials enter the ledger. */
export class StudioLiveAudioService {
	readonly #root: string | undefined;
	readonly #socketDirectory: string | undefined;
	readonly #available: boolean;
	readonly #unsubscribe: () => void;
	#capture: Capture | undefined;
	#webrtc: WebRtcCapture | undefined;
	#current(): LiveCaptureTarget | undefined {
		return this.#webrtc ?? this.#capture;
	}
	#dictationKeybindings: KeybindingsManager | undefined;
	#state: LiveAudioState;
	#disposed = false;
	#control: StudioLiveService | undefined;
	#operations: Promise<unknown> = Promise.resolve();
	readonly factory: StudioLiveSessionFactory;

	constructor(
		readonly session: AgentSession,
		readonly options: {
			directory?: string;
			socketDirectory?: string;
			createController?: (options: LiveSessionControllerOptions) => Controller;
			prepareTimeoutMs?: number;
			webRtcOwnerTimeoutMs?: number;
			dictationFlushTimeoutMs?: number;
		} = {},
	) {
		this.#root = options.directory ?? process.env.OMP_STUDIO_MEDIA_ROOT;
		this.#socketDirectory = options.socketDirectory ?? process.env.OMP_STUDIO_SOCKET_DIR;
		this.#available = !!this.#root && (process.platform === "win32" || !!this.#socketDirectory);
		this.#state = blank(this.#available);
		this.factory = {
			create: callbacks => {
				const capture = this.#current();
				if (
					!capture ||
					capture.closed ||
					capture.id !== callbacks.deviceId ||
					capture.sessionId !== this.session.sessionId ||
					(capture.kind !== "webrtc" && !capture.socket) ||
					capture.started
				)
					throw new StudioLiveError(
						"COMMAND_BLOCKED",
						"Attach this window's authenticated microphone before starting Live",
					);
				if (capture.kind === "dictation")
					throw new StudioLiveError("COMMAND_BLOCKED", "End dictation before starting Live");
				capture.started = true;
				if (capture.kind !== "webrtc" && capture.timer) clearTimeout(capture.timer);
				this.#state.phase = "connecting";
				const controller = (this.options.createController ?? (options => new LiveSessionController(options)))({
					session: this.session,
					voice: capture.voice,
					sdpOffer: capture.kind === "webrtc" ? capture.sdpOffer : undefined,
					extractAssistantText: message =>
						message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n"),
					createAudioInput:
						capture.kind === "webrtc"
							? undefined
							: onAudio => {
									if (capture.closed || !capture.socket)
										throw new Error("Microphone detached while connecting");
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
							if (this.#current() !== capture || capture.closed) return;
							this.#state.phase = phase;
							if (phase === "listening") callbacks.onActive();
						},
						onLevels: (input, output) => {
							if (this.#current() !== capture || capture.closed) return;
							this.#state.inputLevel = input;
							this.#state.outputLevel = output;
						},
						onTranscript: transcript => {
							if (this.#current() !== capture || capture.closed || !transcript) return;
							const item = { ...transcript, text: transcript.text.slice(-2000) };
							const index = this.#state.transcripts.findIndex(
								row => row.role === item.role && row.turn === item.turn,
							);
							if (index >= 0) this.#state.transcripts[index] = item;
							else this.#state.transcripts.push(item);
							this.#state.transcripts = this.#state.transcripts.slice(-40);
						},
						onTerminal: error => {
							if (this.#current() === capture) {
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
				const capture = this.#current();
				if (capture && capture.sessionId !== session.sessionId) {
					if (capture.kind === "dictation") capture.dictation?.input({ kind: "cancel" });
					void this.#release(capture).catch(() => {});
				}
			}) ?? (() => {});
	}
	bindControl(control: StudioLiveService): void {
		this.#control = control;
	}
	get running(): boolean {
		const capture = this.#current();
		return (
			!!capture &&
			(!capture.closed || (capture.kind !== "dictation" && !["off", "error"].includes(this.#state.phase)))
		);
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		const capture = this.#current();
		if (capture) void this.#release(capture).catch(() => {});
	}

	async connectWebRtc(operation: {
		sessionId: string;
		audioId: string;
		sdpOffer: string;
		voice?: string;
	}): Promise<{ audioId: string; sdpAnswer: string; state: LiveAudioState }> {
		const reserve = this.#operations.then(() => {
			if (this.#disposed || operation.sessionId !== this.session.sessionId)
				throw new StudioLiveError("COMMAND_BLOCKED", "Live requires the active session");
			if (!operation.sdpOffer?.trim()) throw new StudioLiveError("INVALID_ARGUMENT", "WebRTC requires an SDP offer");
			if (this.running)
				throw new StudioLiveError("COMMAND_BLOCKED", "Stop Live or dictation before starting another call");
			if (!this.#control) throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "Live controller is unavailable");
			const capture: WebRtcCapture = {
				kind: "webrtc",
				id: operation.audioId,
				sessionId: operation.sessionId,
				voice: operation.voice ?? "sol",
				sdpOffer: operation.sdpOffer,
				started: false,
				closed: false,
			};
			this.#webrtc = capture;
			this.#touchWebRtcOwner(capture);
			this.#state = {
				...blank(true),
				audioId: capture.id,
				voice: capture.voice,
				attached: true,
				phase: "connecting",
			};
			return capture;
		});
		this.#operations = reserve.catch(() => {});
		const capture = await reserve;
		try {
			// Only reservation is serialized: mute/stop can interrupt an in-flight connection.
			await this.#control!.start(capture.id);
			if (capture.closed || this.#current() !== capture || capture.sessionId !== this.session.sessionId)
				throw new StudioLiveError("COMMAND_BLOCKED", "Live connection was cancelled");
			const sdpAnswer = capture.controller?.sdpAnswer;
			if (!sdpAnswer)
				throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "The Live provider did not negotiate WebRTC");
			return { audioId: capture.id, sdpAnswer, state: structuredClone(this.#state) };
		} catch (error) {
			await this.#release(capture);
			throw error;
		}
	}

	webRtcStatus(sessionId: string, audioId?: string): Promise<LiveAudioState> {
		const capture = this.#webrtc;
		if (capture && !capture.closed && capture.sessionId === sessionId && capture.id === audioId)
			this.#touchWebRtcOwner(capture);
		return this.execute({ kind: "live.audio.status", sessionId });
	}

	#touchWebRtcOwner(capture: WebRtcCapture): void {
		if (capture.ownerTimer) clearTimeout(capture.ownerTimer);
		capture.ownerTimer = setTimeout(() => {
			void this.#release(capture).catch(() => {});
		}, this.options.webRtcOwnerTimeoutMs ?? 5000);
		capture.ownerTimer.unref();
	}

	async #inspect(): Promise<DictationConfiguration> {
		const { configuration, model } = inspectDictationConfiguration(this.session, this.#available);
		this.#dictationKeybindings ??= KeybindingsManager.create();
		this.#dictationKeybindings.reload();
		configuration.hotkeys = {
			pushToTalk: this.#dictationKeybindings.getKeys("app.stt.pushToTalk"),
			toggle: this.#dictationKeybindings.getKeys("app.stt.toggle"),
		};
		if (!configuration.cloud)
			configuration.downloadRequired = !(await isSttModelCached(resolveSttModelSpec(model?.id).key));
		if (this.running && !configuration.blockedReason)
			configuration.blockedReason = this.#capture?.kind === "dictation" ? "capture-active" : "live-active";
		return configuration;
	}

	dictation(operation: DictationOperation): Promise<DictationState | DictationConfiguration | DictationChannel> {
		// Open/Live prepare share a queue: asynchronous cache inspection must not
		// allow two windows to reserve different captures concurrently.
		const work = this.#operations.then(async () => {
			if (this.#disposed || operation.sessionId !== this.session.sessionId)
				throw new StudioLiveError("COMMAND_BLOCKED", "Dictation requires the active session");
			const configuration = await this.#inspect();
			if (this.#disposed || operation.sessionId !== this.session.sessionId)
				throw new StudioLiveError("COMMAND_BLOCKED", "Session changed while inspecting dictation");
			if (operation.kind === "dictation.inspect") return configuration;
			if (operation.kind === "dictation.status") {
				const capture = this.#capture?.kind === "dictation" ? this.#capture : undefined;
				const phase = capture?.dictation?.phase;
				const legacyPhase: DictationState["phase"] =
					!phase || phase === "cancelled"
						? "off"
						: phase === "preparing"
							? "starting"
							: phase === "ready"
								? "prepared"
								: phase;
				return {
					available: configuration.available,
					enabled: configuration.enabled,
					...(capture ? { audioId: capture.id } : {}),
					phase: legacyPhase,
					text: "",
					model: configuration.model,
					language: configuration.language,
					cloud: configuration.cloud,
					downloadRequired: configuration.downloadRequired,
					...(configuration.downloadSize ? { downloadSize: configuration.downloadSize } : {}),
				};
			}
			if (operation.kind === "dictation.cancel") {
				const capture = this.#capture;
				if (
					!capture ||
					capture.kind !== "dictation" ||
					capture.id !== operation.audioId ||
					capture.sessionId !== operation.sessionId
				)
					throw new StudioLiveError("COMMAND_BLOCKED", "Dictation capture expired or belongs to another session");
				capture.dictation?.input({ kind: "cancel" });
				await this.#release(capture);
				return {
					available: configuration.available,
					enabled: configuration.enabled,
					phase: "off" as const,
					text: "",
					model: configuration.model,
					language: configuration.language,
					cloud: configuration.cloud,
					downloadRequired: configuration.downloadRequired,
					...(configuration.downloadSize ? { downloadSize: configuration.downloadSize } : {}),
				};
			}
			if (operation.kind !== "dictation.open")
				throw new StudioLiveError(
					"CAPABILITY_UNAVAILABLE",
					"Legacy dictation control is unavailable; use dictation.inspect/open and the version 2 private audio channel",
				);
			if (
				operation.configurationId !== configuration.configurationId ||
				operation.configurationId !==
					inspectDictationConfiguration(this.session, this.#available).configuration.configurationId
			)
				throw new StudioLiveError(
					"COMMAND_BLOCKED",
					"Voice configuration changed; inspect dictation before opening a channel",
				);
			if (configuration.blockedReason)
				throw new StudioLiveError("COMMAND_BLOCKED", `Dictation is not ready: ${configuration.blockedReason}`);
			const capture = await this.#prepare(operation.sessionId, "dictation", configuration);
			return {
				protocolVersion: 2 as const,
				audioId: capture.id,
				sessionId: capture.sessionId,
				expiresAt: capture.expiresAt,
				configuration,
			};
		});
		this.#operations = work.catch(() => {});
		return work;
	}

	execute(operation: LiveAudioOperation): Promise<LiveAudioState> {
		const work = this.#operations.then(async () => {
			if (this.#disposed || operation.sessionId !== this.session.sessionId)
				throw new StudioLiveError("COMMAND_BLOCKED", "Live audio requires the active session");
			if (operation.kind === "live.audio.prepare")
				await this.#prepare(operation.sessionId, operation.voice ?? "sol");
			else if (operation.kind !== "live.audio.status") {
				const capture = this.#current();
				if (
					!capture ||
					capture.kind === "dictation" ||
					operation.audioId !== capture.id ||
					capture.sessionId !== operation.sessionId
				)
					throw new StudioLiveError("COMMAND_BLOCKED", "This Live call has ended or belongs to another window");
				if (operation.kind === "live.audio.release") await this.#release(capture);
				else if (operation.kind === "live.audio.start") {
					if (!this.#control)
						throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "Live controller is unavailable");
					void this.#control.start(capture.id).catch(() => {
						if (this.#current() === capture) {
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
			const state = this.#current()?.sessionId === operation.sessionId ? this.#state : blank(this.#available);
			return structuredClone(state);
		});
		this.#operations = work.catch(() => {});
		return work;
	}

	#socketEndpoint(id: string): string {
		const endpoint = this.#socketDirectory ? path.join(this.#socketDirectory, liveAudioSocketName(id)) : undefined;
		if (!endpoint || Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES)
			throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "The desktop audio socket directory is unavailable");
		return endpoint;
	}
	async #prepare(sessionId: string, voice: string, configuration?: DictationConfiguration): Promise<Capture> {
		if (!this.#root || !this.#available)
			throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "The desktop audio boundary is unavailable");
		if (this.running)
			throw new StudioLiveError(
				"COMMAND_BLOCKED",
				"Stop the current Live call or dictation before preparing another",
			);
		const id = randomUUID(),
			token = randomBytes(32).toString("hex");
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${id}` : this.#socketEndpoint(id);
		const descriptor = path.join(this.#root, "audio", `${id}.json`);
		const server = createServer(socket => this.#peer(capture, socket));
		const capture: Capture = {
			kind: configuration ? "dictation" : "live",
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
			expiresAt: Date.now() + (this.options.prepareTimeoutMs ?? 30000),
		};
		capture.timer = setTimeout(() => {
			void this.#release(capture).catch(() => {});
		}, this.options.prepareTimeoutMs ?? 30000);
		capture.timer.unref?.();
		this.#webrtc = undefined;
		this.#capture = capture;
		this.#state = { ...blank(true), audioId: id, voice, phase: "prepared" };
		if (configuration) {
			const { model } = inspectDictationConfiguration(this.session, this.#available);
			capture.dictation = new StudioDictationCapture(
				id,
				configuration,
				{
					settings: this.session.settings,
					registry: this.session.modelRegistry,
					getSessionId: () => sessionId,
					configuration: { model, language: configuration.language, submitTrigger: configuration.submitTrigger },
				},
				{
					flushTimeoutMs: this.options.dictationFlushTimeoutMs,
					currentConfigurationId: () =>
						inspectDictationConfiguration(this.session, this.#available).configuration.configurationId,
					send: event => {
						const socket = capture.socket;
						if (!socket || capture.closed) return;
						const line = JSON.stringify(event) + "\n";
						if (socket.writableLength + Buffer.byteLength(line) > MAX_OUTBOUND_DICTATION_BYTES) {
							void this.#release(capture).catch(() => {});
							return;
						}
						socket.write(line);
					},
					close: () => this.#closeSocket(capture, true),
				},
			);
		}
		try {
			await fs.mkdir(path.dirname(descriptor), { recursive: true, mode: 0o700 });
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(endpoint, () => {
				server.removeListener("error", listening.reject);
				listening.resolve();
			});
			await listening.promise;
			server.on("error", () => {
				void this.#release(capture).catch(() => {});
			});
			if (capture.closed || sessionId !== this.session.sessionId || this.#disposed)
				throw new Error("Session changed while preparing audio");
			await fs.writeFile(
				descriptor,
				JSON.stringify({
					version: configuration ? 2 : 1,
					audioId: id,
					sessionId,
					endpoint,
					token,
					expiresAt: capture.expiresAt,
				}),
				{ mode: 0o600, flag: "wx" },
			);
			if (capture.closed || sessionId !== this.session.sessionId || this.#disposed) {
				await fs.unlink(descriptor).catch(() => {});
				throw new Error("Session changed while publishing audio descriptor");
			}
			return capture;
		} catch (error) {
			await this.#release(capture);
			throw error;
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
			if (typeof data === "string" || capture.closed || pending.length + data.length > MAX_PENDING_AUDIO_BYTES) {
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
				if (capture.kind === "dictation") {
					if (capture.timer) clearTimeout(capture.timer);
					capture.timer = undefined;
					socket.setTimeout(0);
				} else socket.setTimeout(5000, () => socket.destroy());
				socket.write("OK\n");
				capture.dictation?.input({ kind: "snapshot" });
				void fs.unlink(capture.descriptor).catch(() => {});
			}
			try {
				while (pending.length >= 4 && !capture.closed) {
					const header = pending.readUInt32LE(0),
						control = (header & 0x80000000) !== 0,
						length = header & 0x7fffffff;
					if (control) {
						if (!capture.dictation || length < 1 || length > 4096) throw new Error("Invalid audio control frame");
						if (pending.length < length + 4) break;
						const input = JSON.parse(pending.toString("utf8", 4, length + 4)) as DictationInput;
						pending = pending.subarray(length + 4);
						if (
							!input ||
							typeof input !== "object" ||
							!["start", "recording", "drain", "stop", "cancel", "snapshot", "ping"].includes(input.kind)
						)
							throw new Error("Unknown audio control");
						if (
							input.kind === "start" &&
							(!["click", "hold", "toggle", "retry"].includes(input.mode) ||
								typeof input.configurationId !== "string")
						)
							throw new Error("Invalid dictation start");
						if (
							input.kind === "drain" &&
							(typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 128)
						)
							throw new Error("Invalid dictation drain");
						capture.dictation.input(input);
						if (capture.dictation.phase === "recording") socket.setTimeout(5000);
						else socket.setTimeout(0);
						continue;
					}
					if (length < 4 || length > 12800 || length % 4) throw new Error("Invalid PCM frame");
					if (pending.length < length + 4) break;
					const samples = new Float32Array(length / 4);
					for (let i = 0; i < samples.length; i++) {
						const value = pending.readFloatLE(4 + i * 4);
						if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error("Invalid PCM sample");
						samples[i] = value;
					}
					pending = pending.subarray(4 + length);
					if (capture.dictation) capture.dictation.consumeAudio(samples);
					else capture.onAudio?.(null, samples);
				}
			} catch {
				if (capture.dictation)
					capture.dictation.fail("AUDIO_PROTOCOL_ERROR", "The private dictation audio channel failed");
				else socket.destroy();
			}
		});
		socket.once("close", () => {
			capture.peers.delete(socket);
			if (capture.socket !== socket) return;
			capture.socket = undefined;
			if (this.#capture === capture) this.#state.attached = false;
			if (!capture.closed) void this.#release(capture).catch(() => {});
		});
	}

	#closeSocket(capture: LiveCaptureTarget, graceful = false): void {
		if (capture.kind === "webrtc") {
			if (capture.ownerTimer) clearTimeout(capture.ownerTimer);
			capture.ownerTimer = undefined;
			capture.closed = true;
			if (this.#webrtc === capture) this.#state.attached = false;
			return;
		}
		if (capture.closed) return;
		capture.closed = true;
		if (capture.timer) clearTimeout(capture.timer);
		capture.timer = undefined;
		capture.onAudio = undefined;
		capture.dictation?.dispose();
		for (const peer of capture.peers) {
			if (graceful && peer === capture.socket) {
				peer.setTimeout(0);
				peer.end();
				peer.destroySoon();
			} else peer.destroy();
		}
		capture.socket = undefined;
		capture.peers.clear();
		if (capture.server.listening) capture.server.close();
		else capture.server.once("listening", () => capture.server.close());
		void fs.unlink(capture.descriptor).catch(() => {});
		if (this.#capture === capture) {
			this.#state.attached = false;
			if (capture.kind === "dictation") this.#state.phase = "off";
		}
	}
	async #release(capture: LiveCaptureTarget): Promise<void> {
		this.#closeSocket(capture);
		await capture.controller?.stop();
		if (this.#current() === capture) {
			this.#state.phase = "off";
			this.#state.inputLevel = this.#state.outputLevel = 0;
			this.#state.muted = false;
		}
	}
}
