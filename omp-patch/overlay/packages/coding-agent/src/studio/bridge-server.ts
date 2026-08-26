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
const PATCHSET_VERSION = "studio.4";

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
	readonly #now: () => Date;
	readonly #sockets = new Set<net.Socket>();
	#server: net.Server | undefined;
	#authenticatedSocket: net.Socket | undefined;
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
		this.#now = options.now ?? (() => new Date());
	}

	async start(runtime: StudioHostRuntime): Promise<void> {
		if (this.#server !== undefined) throw new Error("Studio Bridge is already started");
		this.#runtime = runtime;
		this.#projector = new StudioStateProjector(runtime);
		this.#dispatcher = new StudioBridgeDispatcher(runtime, this.#projector, () => {});
		this.#unsubscribeProjector = this.#projector.onEvent(event => {
			try {
				const socket = this.#authenticatedSocket;
				if (socket !== undefined && !socket.destroyed) {
					socket.write(encodeStudioFrame(`event:${event.eventSeq}`, runtime.runtimeEpoch, event));
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
		let authenticated = false;
		const timeout = setTimeout(() => socket.destroy(), this.#handshakeTimeoutMs);
		socket.once("close", () => {
			clearTimeout(timeout);
			this.#sockets.delete(socket);
			if (this.#authenticatedSocket === socket) this.#authenticatedSocket = undefined;
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
								socket.write(encodeStudioFrame(frameId, runtime.runtimeEpoch, body), () => {
									if (body.type === "studio.snapshot") this.#firstSnapshot?.resolve("ready");
								});
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
				socket.write(encodeStudioFrame(`hello-result:${hello.requestId}`, runtime.runtimeEpoch, response));
				authenticated = true;
				clearTimeout(timeout);
				this.#authenticatedSocket = socket;
			} catch {
				socket.destroy();
			}
		});
	}
}
