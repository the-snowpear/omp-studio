import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import {
	WordCompletionProvider,
	type WordPredictionBackend,
	type WordCompletionEngine,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { cfgSpellingAutocomplete } from "../../modes/settings";
import { resolveTextPredictMethod } from "../../predict/client";
import { StudioPredictionEngine, type StudioPredictionQuery } from "./prediction-engine";
import type { PredictionControlAction } from "../prediction-protocol";
import { readForeignPrompts } from "../../predict/foreign-history";

import type { AgentSession } from "../../session/agent-session";
import {
	validatePredictionInput,
	type PredictionChannelOperation,
	type PredictionSettings,
	type PredictionEvent,
	type PredictionInput,
} from "../prediction-channel-protocol";
import { SessionControlError } from "./session-control-service";
interface Channel {
	id: string;
	sessionId: string;
	descriptor: string;
	endpoint: string;
	token: string;
	server: Server;
	socket?: Socket;
	peers: Set<Socket>;
	timer: NodeJS.Timeout;
	lastSeen: number;
	closed: boolean;
	provider: WordCompletionProvider;
	input?: { revision: number; lines: string[]; line: number; column: number; suffix: string | null };
	importing: boolean;
}
const clean = (cause: unknown) =>
	sanitizeText(cause instanceof Error ? cause.message : String(cause))
		.replaceAll("\0", "")
		.slice(0, 1024) || "Prediction unavailable";
export function predictionSocketName(id: string): string {
	return "p-" + createHash("sha256").update(id).digest("hex").slice(0, 16) + ".sock";
}
/** Native completion/prose gates; typed settings over Bridge, draft text only over private sockets. */
export class StudioPredictionService {
	readonly #engine: StudioPredictionEngine;
	readonly directory: string | undefined;
	get running(): boolean {
		return this.#engine.running || [...this.#channels.values()].some(channel => channel.importing);
	}
	query(input: StudioPredictionQuery) {
		return this.#engine.query(input);
	}
	control(action: PredictionControlAction) {
		return this.#engine.control(action);
	}
	observeSent(id: string, text: string) {
		return this.#engine.observeSent(id, text);
	}
	readonly #channels = new Map<string, Channel>();
	#disposed = false;
	readonly #unsubscribe: () => void;
	constructor(
		readonly session: Pick<AgentSession, "sessionId" | "settings"> &
			Partial<Pick<AgentSession, "registerSessionChangeCallback" | "subscribe">>,
		directoryOrOptions: string | ConstructorParameters<typeof StudioPredictionEngine>[1] = process.env
			.OMP_STUDIO_MEDIA_ROOT,
		readonly socketDirectory = process.env.OMP_STUDIO_SOCKET_DIR,
	) {
		this.directory = typeof directoryOrOptions === "string" ? directoryOrOptions : process.env.OMP_STUDIO_MEDIA_ROOT;
		this.#engine = new StudioPredictionEngine(
			session,
			typeof directoryOrOptions === "object" ? directoryOrOptions : {},
		);
		this.#unsubscribe =
			session.registerSessionChangeCallback?.(() => {
				for (const channel of this.#channels.values()) this.#close(channel);
			}) ?? (() => {});
	}
	#check(id: string): void {
		if (this.#disposed || id !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Prediction requires the current session");
	}
	async #status(): Promise<PredictionSettings> {
		const method = cfgSpellingAutocomplete.get(this.session.settings);
		const status = await this.#engine.control("status");
		return {
			method,
			effective:
				method === "off"
					? "off"
					: method === "smollm" && !status.modelReady
						? "ngram"
						: resolveTextPredictMethod(method),
			source: this.session.settings.getProvenance(cfgSpellingAutocomplete),
			download: {
				state: status.modelReady
					? "ready"
					: status.download.state === "running"
						? "downloading"
						: status.download.state === "completed"
							? "ready"
							: status.download.state,
				bytes: status.download.loaded,
				total: status.download.total,
				...(status.download.error ? { error: status.download.error } : {}),
			},
		};
	}
	async execute(operation: PredictionChannelOperation): Promise<unknown> {
		this.#check(operation.sessionId);
		if (operation.kind === "prediction.prepare") return this.#prepare();
		if (operation.kind === "prediction.release") {
			const channel = this.#channels.get(operation.channelId);
			if (channel && channel.sessionId === operation.sessionId) this.#close(channel);
			return { released: true };
		}
		if (operation.kind === "prediction.download.cancel") await this.#engine.control("cancel");
		if (operation.kind === "prediction.clearOverride") cfgSpellingAutocomplete.clearOverride(this.session.settings);
		if (operation.kind === "prediction.configure") {
			cfgSpellingAutocomplete.assertWritable(operation.method);
			if (operation.method === "apple" && process.platform !== "darwin")
				throw new SessionControlError("COMMAND_BLOCKED", "Apple prediction is only available on macOS");
			if (operation.scope === "session") cfgSpellingAutocomplete.override(this.session.settings, operation.method);
			else {
				cfgSpellingAutocomplete.set(this.session.settings, operation.method);
				await this.session.settings.flush();
			}
		}
		const method = cfgSpellingAutocomplete.get(this.session.settings);
		if (operation.kind === "prediction.configure" && method === "smollm") await this.#engine.control("download");
		if (method !== "smollm" && this.#engine.running) await this.#engine.control("cancel");
		if (operation.kind !== "prediction.status")
			for (const channel of this.#channels.values()) {
				channel.provider.setMethod(method);
				channel.input = undefined;
				this.#send(channel, { kind: "suggestion", channelId: channel.id, revision: 0, suffix: null });
			}
		return this.#status();
	}
	async #prepare(): Promise<{ channelId: string; sessionId: string; expiresAt: number }> {
		if (!this.directory || (!this.socketDirectory && process.platform !== "win32"))
			throw new SessionControlError("COMMAND_BLOCKED", "Private prediction transport is unavailable");
		if (this.#channels.size >= 4) throw new SessionControlError("COMMAND_BLOCKED", "Too many prediction channels");
		const id = randomUUID(),
			sessionId = this.session.sessionId,
			token = randomBytes(32).toString("hex"),
			folder = path.join(this.directory, "prediction");
		const endpoint =
			process.platform === "win32"
				? "\\\\.\\pipe\\omp-studio-predict-" + id
				: path.join(this.socketDirectory!, predictionSocketName(id));
		if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 103)
			throw new SessionControlError("COMMAND_BLOCKED", "Prediction socket path is too long");
		await fs.mkdir(folder, { recursive: true, mode: 0o700 });
		this.#check(sessionId);
		if (this.#channels.size >= 4) throw new SessionControlError("COMMAND_BLOCKED", "Too many prediction channels");
		const server = createServer(socket => this.#connect(channel, socket));
		const backend = (method: WordCompletionEngine): WordPredictionBackend => ({
			complete: async (before, prefix) => {
				try {
					return (
						(await this.#engine.completeNative(resolveTextPredictMethod(method), before, prefix)).suggestion
							?.suffix ?? null
					);
				} catch (cause) {
					this.#send(channel, { kind: "error", channelId: id, message: clean(cause) });
					throw cause;
				}
			},
			feedback: (before, prefix, suggestion, accepted) =>
				this.#engine.feedback(method, before, prefix, suggestion, accepted),
		});
		const provider = new WordCompletionProvider(backend);
		provider.setMethod(cfgSpellingAutocomplete.get(this.session.settings));
		const channel: Channel = {
			id,
			sessionId,
			descriptor: path.join(folder, id + ".json"),
			endpoint,
			token,
			server,
			peers: new Set(),
			timer: setInterval(() => {
				if (Date.now() - channel.lastSeen > 45000 || channel.sessionId !== this.session.sessionId)
					this.#close(channel);
			}, 5000),
			lastSeen: Date.now(),
			closed: false,
			provider,
			importing: false,
		};
		channel.timer.unref();
		provider.onUpdate = () => this.#suggest(channel);
		this.#channels.set(id, channel);
		try {
			const ready = Promise.withResolvers<void>();
			server.once("error", ready.reject);
			server.listen(endpoint, ready.resolve);
			await ready.promise;
			this.#check(sessionId);
			const expiresAt = Date.now() + 15000;
			await fs.writeFile(
				channel.descriptor,
				JSON.stringify({ version: 1, channelId: id, sessionId, endpoint, token, expiresAt }),
				{ flag: "wx", mode: 0o600 },
			);
			this.#check(sessionId);
			if (channel.closed) {
				await fs.unlink(channel.descriptor).catch(() => {});
				throw new SessionControlError("COMMAND_BLOCKED", "Prediction channel closed");
			}
			return { channelId: id, sessionId, expiresAt };
		} catch (error) {
			this.#close(channel);
			await fs.unlink(channel.descriptor).catch(() => {});
			throw error;
		}
	}
	#suggest(channel: Channel): void {
		const input = channel.input;
		if (!input || channel.closed) return;
		const suffix = channel.provider.getWordCompletion(input.lines, input.line, input.column);
		input.suffix = suffix && suffix.length <= 256 ? suffix : null;
		this.#send(channel, {
			kind: "suggestion",
			channelId: channel.id,
			revision: input.revision,
			suffix: input.suffix,
		});
	}
	#connect(channel: Channel, socket: Socket): void {
		if (channel.closed || channel.socket || channel.peers.size >= 2) {
			socket.destroy();
			return;
		}
		channel.peers.add(socket);
		socket.setEncoding("utf8");
		let authenticated = false,
			pending = "";
		const timer = setTimeout(() => socket.destroy(), 3000);
		timer.unref();
		socket.on("error", () => {});
		socket.once("close", () => {
			clearTimeout(timer);
			channel.peers.delete(socket);
			if (channel.socket === socket) this.#close(channel);
		});
		socket.on("data", (text: string) => {
			pending += text;
			if (Buffer.byteLength(pending) > 32768) {
				socket.destroy();
				return;
			}
			for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
				const line = pending.slice(0, at);
				pending = pending.slice(at + 1);
				try {
					this.#check(channel.sessionId);
					if (channel.closed) throw new Error("Prediction channel closed");
					if (!authenticated) {
						if (
							!/^[a-f0-9]{64}$/.test(line) ||
							!timingSafeEqual(Buffer.from(line), Buffer.from(channel.token)) ||
							channel.socket
						)
							throw new Error("Invalid prediction authentication");
						authenticated = true;
						clearTimeout(timer);
						channel.socket = socket;
						socket.write("OK\n");
						void fs.unlink(channel.descriptor).catch(() => {});
						continue;
					}
					const request: unknown = JSON.parse(line);
					validatePredictionInput(request);
					channel.lastSeen = Date.now();
					void this.#input(channel, request).catch(cause =>
						this.#send(channel, {
							kind: "error",
							channelId: channel.id,
							message: clean(cause),
							...(request.kind === "import" ? { requestId: request.requestId } : {}),
						}),
					);
				} catch {
					socket.destroy();
					return;
				}
			}
		});
	}
	async #input(channel: Channel, input: PredictionInput): Promise<void> {
		if (input.kind === "ping") return;
		if (input.kind === "update") {
			if (channel.input && input.revision <= channel.input.revision) return;
			const head = input.text.slice(0, input.caret),
				line = head.split("\n").length - 1,
				column = head.length - (head.lastIndexOf("\n") + 1);
			channel.provider.setMethod(cfgSpellingAutocomplete.get(this.session.settings));
			channel.input = { revision: input.revision, lines: input.text.split("\n"), line, column, suffix: null };
			this.#suggest(channel);
			return;
		}
		if (input.kind === "feedback") {
			const shown = channel.input;
			if (shown?.revision === input.revision && shown.suffix)
				channel.provider.wordCompletionFeedback(
					shown.lines,
					shown.line,
					shown.column,
					shown.suffix,
					input.accepted,
				);
			return;
		}
		if (channel.importing) throw new Error("A prediction history import is already running");
		channel.importing = true;
		const file = path.join(this.directory!, "prediction-imports", input.transferId + ".jsonl");
		try {
			const stat = await fs.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
				throw new Error("Prediction history must be a regular JSONL file under 8 MiB");
			const prompts = await readForeignPrompts([file]);
			this.#check(channel.sessionId);
			if (channel.closed) throw new Error("Prediction channel closed");
			if (!prompts.length) throw new Error("No Claude Code or Codex prompt records were found in the selected file");
			const selected = prompts.slice(0, 2000).map(text => text.slice(0, 4096));
			const count = await this.#engine.importPrompts(selected);
			for (const current of this.#channels.values()) {
				current.provider.setMethod("off");
				current.provider.setMethod(cfgSpellingAutocomplete.get(this.session.settings));
			}
			this.#send(channel, {
				kind: "imported",
				channelId: channel.id,
				requestId: input.requestId,
				count,
				truncated: prompts.length > 2000 || prompts.some(text => text.length > 4096),
			});
		} finally {
			channel.importing = false;
			await fs.unlink(file).catch(() => {});
		}
	}
	#send(channel: Channel, event: PredictionEvent): void {
		if (channel.closed || !channel.socket) return;
		if (channel.socket.writableLength > 65536) {
			this.#close(channel);
			return;
		}
		channel.socket.write(JSON.stringify(event) + "\n");
	}
	#close(channel: Channel): void {
		if (channel.closed) return;
		this.#send(channel, { kind: "closed", channelId: channel.id });
		channel.closed = true;
		clearInterval(channel.timer);
		channel.provider.setMethod("off");
		channel.provider.onUpdate = undefined;
		channel.input = undefined;
		for (const socket of channel.peers) socket.destroy();
		channel.server.close();
		void fs.unlink(channel.descriptor).catch(() => {});
		this.#channels.delete(channel.id);
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const channel of this.#channels.values()) this.#close(channel);
		this.#engine.dispose();
	}
}
