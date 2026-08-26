import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { VERSION } from "@oh-my-pi/pi-utils";
import { StudioBridgeDispatcher } from "./bridge-dispatcher";
import {
	createChallengeProof,
	encodeStudioFrame,
	parseStudioHelloRequest,
	parseStudioRequest,
	STUDIO_IMPLEMENTED_CAPABILITIES,
	STUDIO_LIMITED_CAPABILITIES,
	STUDIO_PROTOCOL_VERSION,
	StudioFrameDecoder,
	type StudioHelloResponse,
	stableImplementedManifestHash,
} from "./bridge-protocol";
import { StudioStateProjector } from "./state-projector";
import type { StudioBridgeLifecycle, StudioHostRuntime } from "./studio-host-mode";

const UPSTREAM_COMMIT = "160ed439ac0df594347e7d7018b813a7ffdb5e81";
/**
 * Must match `omp-patch/patches/series.json` `patchsetVersion`. The Runtime
 * reports `${VERSION}-${PATCHSET_VERSION}` in its Studio Hello, and packaging
 * refuses to sign an artifact whose probed identity disagrees with the series,
 * so a stale value here fails the build (see `scripts/build-omp-host.mjs`).
 */
const PATCHSET_VERSION = "studio.3";

export const STUDIO_BRIDGE_MAX_QUEUED_WRITE_BYTES = 4 * 1024 * 1024;

type StudioBridgeWritePriority = "control" | "event";

type QueuedBridgeWrite = {
	frame: Buffer;
	onFlushed?: () => void;
};

/**
 * One writer per authenticated socket. Node's writable high-water mark is a
 * signal, not a limit: continuing to call write() after false grows the JS
 * queue without bound. Keep the outstanding byte total bounded, wait for
 * drain, and let receipts/snapshots pass events that have not entered Node's
 * socket buffer yet.
 */
export class StudioBridgeWritePump {
	readonly #control: QueuedBridgeWrite[] = [];
	readonly #events: QueuedBridgeWrite[] = [];
	#controlHead = 0;
	#eventHead = 0;
	#bufferedBytes = 0;
	#blocked = false;
	#pumping = false;
	#disposed = false;

	constructor(
		private readonly socket: net.Socket,
		private readonly maxQueuedBytes = STUDIO_BRIDGE_MAX_QUEUED_WRITE_BYTES,
	) {
		if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1) {
			throw new RangeError("Studio Bridge write queue limit must be a positive integer");
		}
	}

	get bufferedBytes(): number {
		return this.#bufferedBytes;
	}

	send(frame: Buffer, priority: StudioBridgeWritePriority, onFlushed?: () => void): boolean {
		if (this.#disposed || this.socket.destroyed) return false;
		if (frame.byteLength > this.maxQueuedBytes - this.#bufferedBytes) {
			this.#overflow();
			return false;
		}
		const item: QueuedBridgeWrite = { frame, ...(onFlushed === undefined ? {} : { onFlushed }) };
		(priority === "control" ? this.#control : this.#events).push(item);
		this.#bufferedBytes += frame.byteLength;
		this.#pump();
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.socket.off("drain", this.#onDrain);
		this.#control.length = 0;
		this.#events.length = 0;
		this.#controlHead = 0;
		this.#eventHead = 0;
		this.#bufferedBytes = 0;
	}

	readonly #onDrain = (): void => {
		if (this.#disposed) return;
		this.#blocked = false;
		this.#pump();
	};

	#next(): QueuedBridgeWrite | undefined {
		const control = this.#control[this.#controlHead];
		if (control !== undefined) {
			this.#controlHead += 1;
			if (this.#controlHead === this.#control.length) {
				this.#control.length = 0;
				this.#controlHead = 0;
			}
			return control;
		}
		const event = this.#events[this.#eventHead];
		if (event !== undefined) {
			this.#eventHead += 1;
			if (this.#eventHead === this.#events.length) {
				this.#events.length = 0;
				this.#eventHead = 0;
			}
		}
		return event;
	}

	#pump(): void {
		if (this.#disposed || this.#blocked || this.#pumping) return;
		this.#pumping = true;
		try {
			while (!this.#disposed && !this.#blocked) {
				const item = this.#next();
				if (item === undefined) return;
				const writable = this.socket.write(item.frame, error => {
					if (this.#disposed) return;
					this.#bufferedBytes = Math.max(0, this.#bufferedBytes - item.frame.byteLength);
					if (error !== undefined && error !== null) {
						this.socket.destroy(error);
						return;
					}
					item.onFlushed?.();
				});
				if (!writable) {
					this.#blocked = true;
					this.socket.once("drain", this.#onDrain);
				}
			}
		} finally {
			this.#pumping = false;
		}
	}

	#overflow(): void {
		this.dispose();
		this.socket.destroy(new Error("Studio Bridge write queue overflow"));
	}
}

/** Reads and interrupts must not wait for `core.prompt` to finish. Prompt holds
 *  `#dispatchQueue` for the whole turn, including 503 auto-retry backoff. */
const CONCURRENT_DISPATCH_OPERATION_KINDS = new Set<string>([
	"runtime.snapshot",
	"session.transcript.read",
	"agent.conversation.read",
	"interaction.respond",
	"tui.transfer",
	"core.abort",
	"core.steer",
	"core.followUp",
	"queue.enqueue",
	"session.model.set",
	"session.thinking.set",
	"btw.abort",
]);

export interface StudioBridgeServerOptions {
	handshakeTimeoutMs?: number;
	maxQueuedWriteBytes?: number;
	now?: () => Date;
}

async function consumeBridgeToken(tokenFile: string): Promise<string> {
	const claimed = `${tokenFile}.claimed-${process.pid}-${crypto.randomUUID()}`;
	await fs.rename(tokenFile, claimed);
	try {
		const token = await fs.readFile(claimed, "utf8");
		if (token.length === 0) throw new Error("Studio Bridge token is empty");
		return token;
	} finally {
		await fs.rm(claimed, { force: true });
	}
}

export class StudioBridgeServer implements StudioBridgeLifecycle {
	readonly #endpoint: string;
	readonly #tokenFile: string;
	readonly #handshakeTimeoutMs: number;
	readonly #maxQueuedWriteBytes: number | undefined;
	readonly #now: () => Date;
	readonly #sockets = new Set<net.Socket>();
	#server: net.Server | undefined;
	#authenticatedSocket: net.Socket | undefined;
	#authenticatedWriter: StudioBridgeWritePump | undefined;
	#token: string | undefined;
	#runtime: StudioHostRuntime | undefined;
	#projector: StudioStateProjector | undefined;
	#dispatcher: StudioBridgeDispatcher | undefined;
	#unsubscribeProjector: (() => void) | undefined;
	#dispatchQueue = Promise.resolve();
	#firstSnapshot: PromiseWithResolvers<"ready" | "stopped" | "timeout"> | undefined;
	#stopped = false;

	constructor(endpoint: string, tokenFile: string, options: StudioBridgeServerOptions = {}) {
		if (endpoint.length === 0 || tokenFile.length === 0)
			throw new TypeError("Studio Bridge endpoint and token file are required");
		this.#endpoint = endpoint;
		this.#tokenFile = tokenFile;
		this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
		this.#maxQueuedWriteBytes = options.maxQueuedWriteBytes;
		this.#now = options.now ?? (() => new Date());
	}

	async start(runtime: StudioHostRuntime): Promise<void> {
		if (this.#server !== undefined) throw new Error("Studio Bridge is already started");
		this.#runtime = runtime;
		this.#projector = new StudioStateProjector(runtime);
		this.#dispatcher = new StudioBridgeDispatcher(runtime, this.#projector, () => {});
		this.#unsubscribeProjector = this.#projector.onEvent(event => {
			try {
				const writer = this.#authenticatedWriter;
				if (writer !== undefined) {
					writer.send(encodeStudioFrame(`event:${event.eventSeq}`, runtime.runtimeEpoch, event), "event");
				}
			} catch {
				// Isolate mapper/write failures so a bad conversation frame cannot destroy the socket.
			}
		});
		this.#token = await consumeBridgeToken(this.#tokenFile);
		this.#firstSnapshot = Promise.withResolvers<"ready" | "stopped" | "timeout">();
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const listening = Promise.withResolvers<void>();
		server.once("listening", listening.resolve);
		server.once("error", listening.reject);
		if (process.platform === "win32") {
			server.listen({ path: this.#endpoint, readableAll: false, writableAll: false });
		} else {
			server.listen(this.#endpoint);
		}
		try {
			await listening.promise;
			if (process.platform !== "win32") await fs.chmod(this.#endpoint, 0o600);
			const snapshotTimeout = setTimeout(() => this.#firstSnapshot?.resolve("timeout"), this.#handshakeTimeoutMs);
			try {
				const outcome = await this.#firstSnapshot.promise;
				if (outcome === "timeout") throw new Error("Studio Bridge initial snapshot timed out");
				if (outcome === "stopped") throw new Error("Studio Bridge stopped before initial snapshot");
			} finally {
				clearTimeout(snapshotTimeout);
			}
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#firstSnapshot?.resolve("stopped");
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#authenticatedWriter?.dispose();
		this.#authenticatedWriter = undefined;
		this.#authenticatedSocket = undefined;
		const server = this.#server;
		this.#server = undefined;
		if (server?.listening) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		this.#token = undefined;
		this.#runtime = undefined;
		this.#unsubscribeProjector?.();
		this.#unsubscribeProjector = undefined;
		this.#projector?.dispose();
		this.#projector = undefined;
		this.#dispatcher?.dispose();
		this.#dispatcher = undefined;
	}

	#accept(socket: net.Socket): void {
		if (this.#authenticatedSocket?.destroyed) this.#authenticatedSocket = undefined;
		if (this.#stopped || this.#authenticatedSocket !== undefined) {
			socket.destroy();
			return;
		}
		this.#sockets.add(socket);
		const decoder = new StudioFrameDecoder();
		const writer = new StudioBridgeWritePump(socket, this.#maxQueuedWriteBytes);
		let authenticated = false;
		const timeout = setTimeout(() => socket.destroy(), this.#handshakeTimeoutMs);
		socket.once("close", () => {
			clearTimeout(timeout);
			writer.dispose();
			this.#sockets.delete(socket);
			if (this.#authenticatedSocket === socket) {
				this.#authenticatedSocket = undefined;
				this.#authenticatedWriter = undefined;
			}
		});
		socket.once("error", () => socket.destroy());
		socket.on("data", chunk => {
			if (authenticated) {
				try {
					const frames = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
					for (const frame of frames) {
						const runtime = this.#runtime;
						const dispatcher = this.#dispatcher;
						if (
							runtime === undefined ||
							dispatcher === undefined ||
							frame.header.runtimeEpoch !== runtime.runtimeEpoch
						)
							throw new Error("Stale Runtime epoch");
						const request = parseStudioRequest(frame.body);
						if (request.runtimeEpoch !== runtime.runtimeEpoch) throw new Error("Stale Runtime epoch");
						const dispatch = () =>
							dispatcher.dispatch(request, (frameId, body) => {
								if (socket.destroyed || this.#authenticatedSocket !== socket) return;
								writer.send(
									encodeStudioFrame(frameId, runtime.runtimeEpoch, body),
									body.type === "studio.event" ? "event" : "control",
									body.type === "studio.snapshot" ? () => this.#firstSnapshot?.resolve("ready") : undefined,
								);
							});
						if (CONCURRENT_DISPATCH_OPERATION_KINDS.has(request.operation.kind)) {
							void dispatch().catch(() => socket.destroy());
						} else {
							this.#dispatchQueue = this.#dispatchQueue.then(dispatch).catch(() => {
								socket.destroy();
							});
						}
					}
				} catch {
					socket.destroy();
				}
				return;
			}
			try {
				const frames = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
				if (frames.length === 0) return;
				if (frames.length !== 1 || frames[0]?.header.runtimeEpoch !== 0) throw new Error("Invalid hello frame");
				const hello = parseStudioHelloRequest(frames[0].body);
				if (!hello.supportedProtocolVersions.includes(STUDIO_PROTOCOL_VERSION)) {
					socket.destroy();
					return;
				}
				const token = this.#token;
				const runtime = this.#runtime;
				if (token === undefined || runtime === undefined) throw new Error("Studio Bridge is not initialized");
				const response: StudioHelloResponse = {
					type: "studio.hello.result",
					requestId: hello.requestId,
					selectedProtocolVersion: STUDIO_PROTOCOL_VERSION,
					runtimeVersion: `${VERSION}-${PATCHSET_VERSION}`,
					upstreamVersion: VERSION,
					upstreamCommit: UPSTREAM_COMMIT,
					runtimeInstanceId: runtime.runtimeId,
					runtimeEpoch: runtime.runtimeEpoch,
					capabilityManifest: {
						profile: "limited",
						generatedAt: this.#now().toISOString(),
						hash: stableImplementedManifestHash("capabilities"),
						capabilities: STUDIO_IMPLEMENTED_CAPABILITIES.map(id => {
							const limited = STUDIO_LIMITED_CAPABILITIES[id];
							return {
								id,
								grade: (limited === undefined ? "stable" : "limited") as "stable" | "limited",
								version: 1,
								evidence: `studio-runtime:${id}:v1`,
								...(limited === undefined ? {} : { limitations: [...limited.limitations] }),
							};
						}),
					},
					commandManifestHash: runtime.services.commands.manifestHash(),
					stateVersion: this.#projector?.stateVersion ?? 0,
					challengeProof: createChallengeProof(token, hello.challenge, runtime.runtimeId),
				};
				writer.send(
					encodeStudioFrame(`hello-result:${hello.requestId}`, runtime.runtimeEpoch, response),
					"control",
				);
				authenticated = true;
				clearTimeout(timeout);
				this.#authenticatedSocket = socket;
				this.#authenticatedWriter = writer;
			} catch {
				socket.destroy();
			}
		});
	}
}
