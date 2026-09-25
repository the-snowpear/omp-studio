import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
interface Capture {
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
/** Private authenticated PCM transport. No credentials or audio bytes cross the Studio ledger. */
export class StudioLiveAudioService {
	readonly #root: string | undefined;
	readonly #unsubscribe: () => void;
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
			createController?: (options: LiveSessionControllerOptions) => Controller;
			prepareTimeoutMs?: number;
		} = {},
	) {
		this.#root = options.directory ?? process.env.OMP_STUDIO_MEDIA_ROOT;
		this.#state = blank(!!this.#root);
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
				if (capture && capture.sessionId !== session.sessionId) void this.#release(capture).catch(() => {});
			}) ?? (() => {});
	}
	get running(): boolean {
		return !!this.#capture && (!this.#capture.closed || !["off", "error"].includes(this.#state.phase));
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		if (this.#capture) void this.#release(this.#capture).catch(() => {});
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
			const state = this.#capture?.sessionId === operation.sessionId ? this.#state : blank(!!this.#root);
			validateLiveAudioResult(operation.kind, state);
			return structuredClone(state);
		});
		this.#operations = work.catch(() => {});
		return work;
	}
	async #prepare(sessionId: string, voice: string): Promise<void> {
		if (!this.#root) throw new StudioLiveError("CAPABILITY_UNAVAILABLE", "The desktop audio boundary is unavailable");
		if (this.running)
			throw new StudioLiveError("COMMAND_BLOCKED", "Stop the current Live call before preparing another");
		const id = randomUUID(),
			token = randomBytes(32).toString("hex");
		const dir = join(this.#root, "audio");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${id}` : join(dir, id + ".sock");
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
			if (!capture.closed) void this.#release(capture).catch(() => {});
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
