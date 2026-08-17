import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { AgentPauseGate } from "@oh-my-pi/pi-agent-core";
import {
	createChallengeProof,
	type DecodedStudioFrame,
	encodeStudioFrame,
	StudioFrameDecoder,
	type StudioHelloResponse,
	type StudioSnapshotResponse,
} from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioBridgeServer } from "@oh-my-pi/pi-coding-agent/studio/bridge-server";
import { StudioCommandManifestService } from "@oh-my-pi/pi-coding-agent/studio/services/command-manifest-service";
import { StudioInteractionGateway } from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";
import { StudioLiveService } from "@oh-my-pi/pi-coding-agent/studio/services/live-service";
import { StudioLoopService } from "@oh-my-pi/pi-coding-agent/studio/services/loop-service";
import { StudioPauseService } from "@oh-my-pi/pi-coding-agent/studio/services/pause-service";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

const servers: StudioBridgeServer[] = [];
const sockets: net.Socket[] = [];

function fakeLoopService(): StudioLoopService {
	return new StudioLoopService({
		action: () => "prompt",
		isBlocked: () => false,
		isVibeActive: () => false,
		submitPrompt: () => {},
		compact: () => {},
		reset: () => {},
		nowMs: Date.now,
		setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
	});
}

function fakeExtendedServices(session: Record<string, unknown>) {
	return {
		modes: {
			state: () => ({
				...((session.getPlanModeState as () => unknown)() === undefined
					? {}
					: { plan: { status: "active", planFilePath: "local://PLAN.md" } }),
			}),
			onChange: () => () => {},
			dispose: () => {},
		},
		tree: { getTree: () => ({ leafId: null, roots: [] }), navigate: async () => ({}) },
		fork: { fork: async () => ({ forked: true, sessionId: "session-test" }) },
		commands: new StudioCommandManifestService(session as never),
		agents: {
			list: () => [],
			onChange: () => () => {},
		},
		jobs: { list: () => [] },
		interaction: new StudioInteractionGateway(),
		btw: { onChange: () => () => {} },
	};
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const server of servers.splice(0)) {
		await Promise.race([
			server.stop(),
			Bun.sleep(2_000).then(() => {
				throw new Error("Studio Bridge teardown timed out");
			}),
		]);
	}
});

function fakeRuntime(runtimeId = "runtime-instance-test", runtimeEpoch = 7): StudioHostRuntime {
	const session = {
		isStreaming: false,
		isCompacting: false,
		queuedMessageCount: 0,
		getPlanModeState: () => undefined,
		getGoalModeState: () => undefined,
		getVibeModeState: () => undefined,
		getAgentId: () => undefined,
	};
	return {
		runtimeId,
		runtimeEpoch,
		sessionId: "session-test",
		session,
		services: {
			pause: new StudioPauseService(new AgentPauseGate()),
			loop: fakeLoopService(),
			live: new StudioLiveService(),
			...fakeExtendedServices(session),
		},
	} as unknown as StudioHostRuntime;
}

function sessionControlRuntime(): { runtime: StudioHostRuntime; session: Record<string, unknown> } {
	const session = {
		isStreaming: false,
		isCompacting: false,
		queuedMessageCount: 0,
		followUpCalls: 0,
		getPlanModeState: () => undefined,
		getGoalModeState: () => undefined,
		getVibeModeState: () => undefined,
		getAgentId: () => undefined,
		async followUp(_text: string) {
			this.followUpCalls += 1;
			this.queuedMessageCount += 1;
		},
		async resetSessionContext() {
			this.queuedMessageCount = 0;
			return { droppedCount: 4 };
		},
		async retry() {
			return false;
		},
		async prompt(_text: string) {
			return true;
		},
		async abort() {},
	};
	const runtime = {
		runtimeId: "runtime-instance-test",
		runtimeEpoch: 7,
		sessionId: "session-test",
		session,
		services: {
			pause: new StudioPauseService(new AgentPauseGate()),
			loop: fakeLoopService(),
			live: new StudioLiveService(),
			...fakeExtendedServices(session),
		},
	} as unknown as StudioHostRuntime;
	return { runtime, session };
}

async function bridgeFixture(): Promise<{ endpoint: string; tokenFile: string; token: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-runtime-bridge-"));
	const token = crypto.randomBytes(32).toString("base64url");
	const tokenFile = path.join(directory, "bridge.token");
	await fs.writeFile(tokenFile, token, { encoding: "utf8", mode: 0o600 });
	return {
		endpoint:
			process.platform === "win32"
				? `\\\\.\\pipe\\omp-studio-runtime-${crypto.randomUUID()}`
				: path.join(directory, "bridge.sock"),
		tokenFile,
		token,
	};
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function waitForTokenConsumption(tokenFile: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (!(await fileExists(tokenFile))) {
			await new Promise<void>(resolve => setImmediate(resolve));
			return;
		}
		await Bun.sleep(1);
	}
	throw new Error("Studio Bridge did not consume its token file");
}

async function connect(endpoint: string): Promise<net.Socket> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const socket = await new Promise<net.Socket | undefined>(resolve => {
			const candidate = net.createConnection(endpoint);
			candidate.once("connect", () => resolve(candidate));
			candidate.once("error", () => {
				candidate.destroy();
				resolve(undefined);
			});
		});
		if (socket !== undefined) {
			sockets.push(socket);
			return socket;
		}
		await Bun.sleep(1);
	}
	throw new Error("Studio Bridge endpoint did not start listening");
}

async function receiveFrame(socket: net.Socket): Promise<DecodedStudioFrame> {
	const decoder = new StudioFrameDecoder();
	return new Promise<DecodedStudioFrame>((resolve, reject) => {
		socket.on("data", chunk => {
			try {
				const frame = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)[0];
				if (frame !== undefined) resolve(frame);
			} catch (error) {
				reject(error);
			}
		});
		socket.once("error", reject);
	});
}

async function receiveFrames(socket: net.Socket, count: number): Promise<DecodedStudioFrame[]> {
	const decoder = new StudioFrameDecoder();
	return new Promise<DecodedStudioFrame[]>((resolve, reject) => {
		const frames: DecodedStudioFrame[] = [];
		const onData = (chunk: Buffer) => {
			try {
				frames.push(...decoder.push(chunk));
				if (frames.length >= count) {
					socket.off("data", onData);
					resolve(frames.slice(0, count));
				}
			} catch (error) {
				socket.off("data", onData);
				reject(error);
			}
		};
		socket.on("data", onData);
		socket.once("error", reject);
	});
}

async function collectFramesFor(socket: net.Socket, durationMs: number): Promise<DecodedStudioFrame[]> {
	const decoder = new StudioFrameDecoder();
	const frames: DecodedStudioFrame[] = [];
	const onData = (chunk: Buffer) => {
		frames.push(...decoder.push(chunk));
	};
	socket.on("data", onData);
	await Bun.sleep(durationMs);
	socket.off("data", onData);
	return frames;
}

async function exchangeSnapshot(
	socket: net.Socket,
	requestId: string,
	runtimeEpoch = 7,
): Promise<StudioSnapshotResponse> {
	const response = receiveFrame(socket);
	socket.write(
		encodeStudioFrame(`snapshot-request:${requestId}`, runtimeEpoch, {
			type: "studio.request",
			requestId,
			runtimeEpoch,
			operation: { kind: "runtime.snapshot" },
		}),
	);
	return (await response).body as StudioSnapshotResponse;
}

function sendHello(socket: net.Socket, challenge: string, versions = [1]): void {
	socket.write(
		encodeStudioFrame("hello-request", 0, {
			type: "studio.hello",
			requestId: `request-${challenge}`,
			supportedProtocolVersions: versions,
			requiredProfile: "full-parity-v1",
			challenge,
		}),
	);
}

describe("WP-011 Studio Bridge runtime server", () => {
	test("authenticates hello, consumes the token file, and reports only implemented capability grade", async () => {
		const fixture = await bridgeFixture();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile, {
			now: () => new Date("2026-08-11T00:00:00.000Z"),
		});
		servers.push(server);
		const started = server.start(fakeRuntime());
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const responsePromise = receiveFrame(socket);
		sendHello(socket, "challenge-one");
		const responseFrame = await responsePromise;
		const response = responseFrame.body as StudioHelloResponse;
		const snapshot = await exchangeSnapshot(socket, "snapshot-one");
		await started;
		expect(response.runtimeInstanceId).toBe("runtime-instance-test");
		expect(response.runtimeEpoch).toBe(7);
		expect(response.runtimeVersion).toBe("17.2.12-studio.39");
		expect(response.upstreamVersion).toBe("17.2.12");
		expect(responseFrame.header.runtimeEpoch).toBe(response.runtimeEpoch);
		expect(response.capabilityManifest.profile).toBe("limited");
		const capabilityIds = response.capabilityManifest.capabilities.map(entry => entry.id);
		expect(capabilityIds).toContain("runtime.shutdown");
		expect(capabilityIds).toContain("live.start");
		expect(capabilityIds).toContain("operator.manifest.get");
		expect(capabilityIds).toContain("session.history");
		expect(capabilityIds).toContain("session.transcript.read");
		expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
		expect(response.capabilityManifest.capabilities.find(entry => entry.id === "live.start")).toMatchObject({
			grade: "limited",
		});
		expect(response.capabilityManifest.capabilities.find(entry => entry.id === "loop.enable")).toMatchObject({
			grade: "limited",
			limitations: ["Token limits are unsupported; use turns or minutes"],
		});
		expect(response.challengeProof).toBe(
			createChallengeProof(fixture.token, "challenge-one", "runtime-instance-test"),
		);
		expect(snapshot).toEqual({
			type: "studio.snapshot",
			requestId: "snapshot-one",
			snapshot: {
				runtimeId: "runtime-instance-test",
				runtimeEpoch: 7,
				stateVersion: 0,
				sessionId: "session-test",
				isStreaming: false,
				isCompacting: false,
				activeMode: "normal",
				approvalMode: "yolo",
				pause: { paused: false },
				live: { status: "off" },
				pendingMessages: 0,
				activeCommandIds: [],
				agentsRevision: 0,
				jobsRevision: 0,
				agents: [],
				jobs: [],
				telemetry: {
					sessionId: "session-test",
					capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
						cost: 0,
					},
					context: null,
					unavailableReason: "model_context_unknown",
				},
			},
			commandManifestHash: expect.stringMatching(/^sha256:/),
			capabilityHash: expect.stringMatching(/^sha256:/),
			lastEventSeq: 0,
			messagesCursor: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
			terminalReceipts: [],
		});
		expect(await fileExists(fixture.tokenFile)).toBe(false);
	});

	test("executes pause/resume with receipts, state events, pause epoch fencing, and replay", async () => {
		const fixture = await bridgeFixture();
		const runtime = fakeRuntime();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(runtime);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const hello = receiveFrame(socket);
		sendHello(socket, "challenge-pause");
		await hello;
		await exchangeSnapshot(socket, "snapshot-pause");
		await started;

		const pausedFrames = receiveFrames(socket, 3);
		socket.write(
			encodeStudioFrame("pause-request", 7, {
				type: "studio.request",
				requestId: "pause-one",
				runtimeEpoch: 7,
				expectedStateVersion: 0,
				idempotencyKey: "pause-key",
				operation: { kind: "runtime.pause" },
			}),
		);
		const [pauseAccepted, pauseEvent, pauseCompleted] = await pausedFrames;
		expect((pauseAccepted!.body as { status: string }).status).toBe("accepted");
		expect((pauseEvent!.body as { event: { snapshot: { pause: unknown } } }).event.snapshot.pause).toEqual({
			paused: true,
			pauseEpoch: 1,
			pausedAt: expect.any(String),
		});
		expect((pauseCompleted!.body as { status: string; result: { pauseEpoch: number } }).status).toBe("completed");
		expect((pauseCompleted!.body as { result: { pauseEpoch: number } }).result.pauseEpoch).toBe(1);

		const staleResponse = receiveFrame(socket);
		socket.write(
			encodeStudioFrame("resume-stale", 7, {
				type: "studio.request",
				requestId: "resume-stale",
				runtimeEpoch: 7,
				expectedStateVersion: 1,
				operation: { kind: "runtime.resume", expectedPauseEpoch: 0 },
			}),
		);
		expect((await staleResponse).body).toMatchObject({
			status: "rejected",
			error: { code: "STATE_VERSION_CONFLICT", details: { reason: "STALE_PAUSE_EPOCH" } },
		});

		const resumedFrames = receiveFrames(socket, 3);
		socket.write(
			encodeStudioFrame("resume-request", 7, {
				type: "studio.request",
				requestId: "resume-one",
				runtimeEpoch: 7,
				expectedStateVersion: 1,
				operation: { kind: "runtime.resume", expectedPauseEpoch: 1 },
			}),
		);
		const [, resumeEvent, resumeCompleted] = await resumedFrames;
		expect((resumeEvent!.body as { event: { snapshot: { pause: unknown } } }).event.snapshot.pause).toEqual({
			paused: false,
		});
		expect((resumeCompleted!.body as { status: string }).status).toBe("completed");

		const replayResponse = receiveFrame(socket);
		socket.write(
			encodeStudioFrame("pause-replay", 7, {
				type: "studio.request",
				requestId: "pause-replay",
				runtimeEpoch: 7,
				idempotencyKey: "pause-key",
				operation: { kind: "runtime.pause" },
			}),
		);
		expect((await replayResponse).body).toMatchObject({ status: "completed", requestId: "pause-replay" });
	});

	test("executes queue.enqueue with truthful receipts and rejects session.drop with INTERACTION_REQUIRED", async () => {
		const fixture = await bridgeFixture();
		const { runtime, session } = sessionControlRuntime();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(runtime);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const hello = receiveFrame(socket);
		sendHello(socket, "challenge-session-control");
		await hello;
		await exchangeSnapshot(socket, "snapshot-session-control");
		await started;

		const enqueueFrames = receiveFrames(socket, 3);
		socket.write(
			encodeStudioFrame("enqueue-request", 7, {
				type: "studio.request",
				requestId: "enqueue-one",
				runtimeEpoch: 7,
				expectedStateVersion: 0,
				idempotencyKey: "enqueue-key",
				operation: { kind: "queue.enqueue", text: "run the checks" },
			}),
		);
		const [enqueueAccepted, enqueueEvent, enqueueCompleted] = await enqueueFrames;
		expect((enqueueAccepted!.body as { status: string }).status).toBe("accepted");
		expect(
			(enqueueEvent!.body as { event: { snapshot: { pendingMessages: number } } }).event.snapshot.pendingMessages,
		).toBe(1);
		expect((enqueueCompleted!.body as { status: string }).status).toBe("completed");
		expect((enqueueCompleted!.body as { result: { queued: true; pendingMessages: number } }).result).toEqual({
			queued: true,
			pendingMessages: 1,
		});
		expect(session.followUpCalls).toBe(1);

		const dropFrames = receiveFrames(socket, 3);
		socket.write(
			encodeStudioFrame("drop-request", 7, {
				type: "studio.request",
				requestId: "drop-one",
				runtimeEpoch: 7,
				operation: { kind: "session.drop" },
			}),
		);
		const [dropAccepted, stateChanged, interactionRequired] = await dropFrames;
		expect(dropAccepted!.body).toMatchObject({ status: "accepted" });
		expect((stateChanged!.body as { event: { kind: string } }).event.kind).toBe("state.changed");
		const interaction = (
			interactionRequired!.body as {
				event: { request: { interactionId: string; commandId: string } };
			}
		).event.request;
		const cancelled = receiveFrames(socket, 4);
		socket.write(
			encodeStudioFrame("drop-cancel", 7, {
				type: "studio.request",
				requestId: "drop-cancel",
				runtimeEpoch: 7,
				operation: {
					kind: "interaction.respond",
					interactionId: interaction.interactionId,
					commandId: interaction.commandId,
					decision: "cancel",
				},
			}),
		);
		const cancelledFrames = await cancelled;
		expect(cancelledFrames.map(frame => (frame.body as { type: string }).type)).toContain("studio.event");
		expect(cancelledFrames.map(frame => (frame.body as { requestId?: string }).requestId)).toContain("drop-cancel");
		expect(cancelledFrames.map(frame => (frame.body as { requestId?: string }).requestId)).toContain("drop-one");
		// The Runtime emits an interaction.resolved event on cancel so the Host
		// can clear its pending card (plan §1.2).
		expect(
			cancelledFrames.some(
				frame =>
					(frame.body as { event?: { kind?: string; outcome?: string } }).event?.kind === "interaction.resolved" &&
					(frame.body as { event?: { outcome?: string } }).event?.outcome === "cancelled",
			),
		).toBe(true);
	});

	test("rejects an unsupported protocol without authenticating", async () => {
		const fixture = await bridgeFixture();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(fakeRuntime()).catch(error => error as Error);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
		sendHello(socket, "challenge-version", [2]);
		await closed;
		await server.stop();
		expect(await started).toBeInstanceOf(Error);
	});

	test("closes an oversized frame before body allocation", async () => {
		const fixture = await bridgeFixture();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(fakeRuntime()).catch(error => error as Error);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32BE(1024 * 1024 + 1);
		socket.write(prefix);
		await closed;
		await server.stop();
		expect(await started).toBeInstanceOf(Error);
	});

	test("reconnects with a fresh challenge and the same process identity", async () => {
		const fixture = await bridgeFixture();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(fakeRuntime());
		await waitForTokenConsumption(fixture.tokenFile);
		const first = await connect(fixture.endpoint);
		const firstResponse = receiveFrame(first);
		sendHello(first, "challenge-first");
		expect(((await firstResponse).body as StudioHelloResponse).challengeProof).toBe(
			createChallengeProof(fixture.token, "challenge-first", "runtime-instance-test"),
		);
		const firstSnapshot = await exchangeSnapshot(first, "snapshot-first");
		await started;
		const firstClosed = new Promise<void>(resolve => first.once("close", () => resolve()));
		first.destroy();
		await firstClosed;

		const second = await connect(fixture.endpoint);
		const secondResponse = receiveFrame(second);
		sendHello(second, "challenge-second");
		const response = (await secondResponse).body as StudioHelloResponse;
		const secondSnapshot = await exchangeSnapshot(second, "snapshot-second");
		expect(response.runtimeInstanceId).toBe("runtime-instance-test");
		expect(response.runtimeEpoch).toBe(7);
		expect(response.challengeProof).toBe(
			createChallengeProof(fixture.token, "challenge-second", "runtime-instance-test"),
		);
		expect(secondSnapshot.snapshot).toEqual(firstSnapshot.snapshot);
	});

	test("a command accepted on an old socket never writes its receipt to a reconnected socket", async () => {
		const fixture = await bridgeFixture();
		const { runtime, session } = sessionControlRuntime();
		const control = session as {
			queuedMessageCount: number;
			followUpCalls: number;
			followUp(text: string): Promise<void>;
		};
		const release = Promise.withResolvers<void>();
		control.followUp = async () => {
			control.followUpCalls += 1;
			await release.promise;
			control.queuedMessageCount += 1;
		};
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(runtime);
		await waitForTokenConsumption(fixture.tokenFile);
		const first = await connect(fixture.endpoint);
		const firstHello = receiveFrame(first);
		sendHello(first, "challenge-old-command");
		await firstHello;
		await exchangeSnapshot(first, "snapshot-old-command");
		await started;

		const accepted = receiveFrame(first);
		first.write(
			encodeStudioFrame("old-enqueue", 7, {
				type: "studio.request",
				requestId: "old-enqueue",
				runtimeEpoch: 7,
				operation: { kind: "queue.enqueue", text: "delayed" },
			}),
		);
		expect((await accepted).body).toMatchObject({ requestId: "old-enqueue", status: "accepted" });
		const firstClosed = new Promise<void>(resolve => first.once("close", () => resolve()));
		first.destroy();
		await firstClosed;

		const second = await connect(fixture.endpoint);
		const secondHello = receiveFrame(second);
		sendHello(second, "challenge-new-command");
		await secondHello;
		await exchangeSnapshot(second, "snapshot-new-command");
		const collected = collectFramesFor(second, 200);
		release.resolve();
		const frames = await collected;
		expect(frames.some(frame => (frame.body as { type?: string }).type === "studio.event")).toBe(true);
		expect(
			frames.some(
				frame =>
					(frame.body as { type?: string }).type === "studio.receipt" &&
					(frame.body as { requestId?: string }).requestId === "old-enqueue",
			),
		).toBe(false);
	});

	test("rejects a snapshot request fenced to a stale Runtime epoch", async () => {
		const fixture = await bridgeFixture();
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(fakeRuntime()).catch(error => error as Error);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const hello = receiveFrame(socket);
		sendHello(socket, "challenge-stale");
		await hello;
		const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
		socket.write(
			encodeStudioFrame("snapshot-request:stale", 6, {
				type: "studio.request",
				requestId: "snapshot-stale",
				runtimeEpoch: 6,
				operation: { kind: "runtime.snapshot" },
			}),
		);
		await closed;
		await server.stop();
		expect(await started).toBeInstanceOf(Error);
	});

	test("permissions.mode.set persists on demand and overrides otherwise; snapshot reflects the mode", async () => {
		const fixture = await bridgeFixture();
		let currentMode = "yolo";
		let flushed = 0;
		const settings = {
			get: (key: string) => (key === "tools.approvalMode" ? currentMode : undefined),
			set: (key: string, value: unknown) => {
				if (key === "tools.approvalMode") currentMode = value as string;
			},
			clearOverride: () => {},
			override: (key: string, value: unknown) => {
				if (key === "tools.approvalMode") currentMode = value as string;
			},
			flush: async () => {
				flushed += 1;
			},
		};
		const session = {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			getPlanModeState: () => undefined,
			getGoalModeState: () => undefined,
			getVibeModeState: () => undefined,
			getAgentId: () => undefined,
			settings,
		};
		const runtime = {
			runtimeId: "runtime-instance-test",
			runtimeEpoch: 7,
			sessionId: "session-test",
			session,
			services: {
				pause: new StudioPauseService(new AgentPauseGate()),
				loop: fakeLoopService(),
				live: new StudioLiveService(),
				...fakeExtendedServices(session),
			},
		} as unknown as StudioHostRuntime;
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(runtime);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const hello = receiveFrame(socket);
		sendHello(socket, "challenge-permissions");
		await hello;
		await exchangeSnapshot(socket, "snapshot-permissions");
		await started;

		const persistFrames = receiveFrames(socket, 3);
		socket.write(
			encodeStudioFrame("permissions-persist", 7, {
				type: "studio.request",
				requestId: "perm-persist",
				runtimeEpoch: 7,
				operation: { kind: "permissions.mode.set", mode: "write", persist: true },
			}),
		);
		const [persistAccepted, stateEvent, persistCompleted] = await persistFrames;
		expect(persistAccepted!.body).toMatchObject({ status: "accepted" });
		expect((stateEvent!.body as { event: { snapshot: { approvalMode: string } } }).event.snapshot.approvalMode).toBe(
			"write",
		);
		expect(persistCompleted!.body).toMatchObject({
			status: "completed",
			result: { mode: "write", persisted: true },
		});
		expect(currentMode).toBe("write");
		expect(flushed).toBe(1);

		const overrideFrames = receiveFrames(socket, 3);
		socket.write(
			encodeStudioFrame("permissions-override", 7, {
				type: "studio.request",
				requestId: "perm-override",
				runtimeEpoch: 7,
				operation: { kind: "permissions.mode.set", mode: "always-ask", persist: false },
			}),
		);
		const [, overrideStateEvent, overrideCompleted] = await overrideFrames;
		expect(
			(overrideStateEvent!.body as { event: { snapshot: { approvalMode: string } } }).event.snapshot.approvalMode,
		).toBe("always-ask");
		expect(overrideCompleted!.body).toMatchObject({
			status: "completed",
			result: { mode: "always-ask", persisted: false },
		});
		expect(flushed).toBe(1); // non-persistent override never flushes

		// An invalid mode is a frame-level protocol violation: the server
		// closes the socket instead of answering a malformed request.
		const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
		socket.write(
			encodeStudioFrame("permissions-invalid", 7, {
				type: "studio.request",
				requestId: "perm-invalid",
				runtimeEpoch: 7,
				operation: { kind: "permissions.mode.set", mode: "root", persist: false },
			}),
		);
		await closed;
	});

	test("core.abort completes while core.prompt still holds the serial dispatch queue", async () => {
		const fixture = await bridgeFixture();
		const { runtime, session } = sessionControlRuntime();
		const control = session as {
			abortCalls: number;
			prompt(text: string): Promise<boolean>;
			abort(): Promise<void>;
		};
		const releasePrompt = Promise.withResolvers<void>();
		control.abortCalls = 0;
		control.prompt = async () => {
			await releasePrompt.promise;
			return true;
		};
		control.abort = async () => {
			control.abortCalls += 1;
		};
		const server = new StudioBridgeServer(fixture.endpoint, fixture.tokenFile);
		servers.push(server);
		const started = server.start(runtime);
		await waitForTokenConsumption(fixture.tokenFile);
		const socket = await connect(fixture.endpoint);
		const hello = receiveFrame(socket);
		sendHello(socket, "challenge-abort-during-prompt");
		await hello;
		await exchangeSnapshot(socket, "snapshot-abort-during-prompt");
		await started;

		const promptAccepted = receiveFrame(socket);
		socket.write(
			encodeStudioFrame("prompt-held", 7, {
				type: "studio.request",
				requestId: "prompt-held",
				runtimeEpoch: 7,
				operation: { kind: "core.prompt", text: "retry me" },
			}),
		);
		expect((await promptAccepted).body).toMatchObject({ requestId: "prompt-held", status: "accepted" });

		socket.write(
			encodeStudioFrame("abort-now", 7, {
				type: "studio.request",
				requestId: "abort-now",
				runtimeEpoch: 7,
				operation: { kind: "core.abort" },
			}),
		);
		const abortFrames = await collectFramesFor(socket, 400);
		expect(control.abortCalls).toBe(1);
		expect(
			abortFrames.some(
				frame =>
					(frame.body as { requestId?: string; status?: string }).requestId === "abort-now" &&
					(frame.body as { status?: string }).status === "completed",
			),
		).toBe(true);
		expect(
			abortFrames.some(
				frame =>
					(frame.body as { requestId?: string; status?: string }).requestId === "prompt-held" &&
					(frame.body as { status?: string }).status === "completed",
			),
		).toBe(false);

		releasePrompt.resolve();
		const promptDone = await collectFramesFor(socket, 200);
		expect(
			promptDone.some(
				frame =>
					(frame.body as { requestId?: string; status?: string }).requestId === "prompt-held" &&
					(frame.body as { status?: string }).status === "completed",
			),
		).toBe(true);
	});
});
