import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DesktopCapture } from "@oh-my-pi/pi-natives";
import { Settings } from "../src/config/settings";
import { projectToolMedia } from "../src/studio/services/conversation-media";
import { cfgComputerEnabled } from "../src/tools/settings";
import { StudioFeatureSettingsService } from "../src/studio/services/feature-settings-service";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioComputerWorkspaceService } from "../src/studio/services/computer-workspace-service";
import type { ComputerObserver } from "../src/studio/services/computer-observer";
import {
	computerRunPermits,
	emitComputerLifecycle,
	computerToolResultDelivered,
} from "../src/studio/computer-runtime-lifecycle";
import type {
	ComputerFrame,
	ComputerObservationLease,
	ComputerWorkspaceSnapshot,
} from "../src/studio/computer-workspace-protocol";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3WQAAAAASUVORK5CYII=",
	"base64",
);
const hash = (id: string): string => createHash("sha256").update(id).digest("hex");
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});
function session(id: string): AgentSession {
	return {
		sessionId: id,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "computer.enabled": true }),
		studioToolSession: { getEvalKernelOwnerId: () => `owner-${id}`, computerPreludeAvailable: () => true },
		getEvalPreludes: () => [],
		promptCustomMessage: async () => true,
	} as unknown as AgentSession;
}
function observer(capture?: () => Promise<DesktopCapture>): ComputerObserver & { reads: number; closed: number } {
	const value = {
		observationOnly: true,
		reads: 0,
		closed: 0,
		capabilities: {
			backend: "test",
			capture: true,
			input: true,
			ax: true,
			globalEscape: true,
			capturePermission: "granted",
			inputPermission: "granted",
			axPermission: "granted",
		},
		screenState: { screenLocked: false, displayAsleep: false },
		listDisplays: async () => {
			value.reads++;
			return [{ id: "test", name: "Test", width: 1, height: 1 }];
		},
		listWindows: async () => [],
		capture:
			capture ??
			(async () => ({
				data: png,
				width: 1,
				height: 1,
				coordinateWidth: 1,
				coordinateHeight: 1,
				sourceWidth: 1,
				sourceHeight: 1,
				target: "display:test",
				backend: "test",
				displays: [],
				screenLocked: false,
			})),
		observe: async () => {
			throw new Error("unused");
		},
		cancel() {},
		close: async () => {
			value.closed++;
		},
	};
	return value as unknown as ComputerObserver & { reads: number; closed: number };
}
async function harness(capture?: () => Promise<DesktopCapture>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "computer-workspace-"));
	disposals.push(() => fs.rm(directory, { recursive: true, force: true }));
	const root = session(crypto.randomUUID());
	const sessions = [root];
	const observers: Array<ComputerObserver & { reads: number; closed: number }> = [];
	let now = Date.now();
	const service = new StudioComputerWorkspaceService(root, {
		directory,
		ownedSessions: () => sessions,
		observer: () => {
			const item = observer(capture);
			observers.push(item);
			return item;
		},
		now: () => now,
	});
	disposals.push(() => service.dispose());
	return {
		service,
		root,
		sessions,
		directory,
		observers,
		tick: (ms: number) => {
			now += ms;
		},
	};
}

test("global defaults preserve session enable overrides and clearing a false inherited override stops", async () => {
	const h = await harness();
	cfgComputerEnabled.override(h.root.settings, true);
	const settings = new StudioFeatureSettingsService(h.root, h.service);
	await settings.execute({
		kind: "preferences.features.set",
		sessionId: h.root.sessionId,
		key: "computer.enabled",
		value: false,
		scope: "global",
	});
	expect(cfgComputerEnabled.get(h.root.settings)).toBe(true);
	let snapshot = (await h.service.query({
		kind: "computer.workspace.get",
		sessionId: h.root.sessionId,
	})) as ComputerWorkspaceSnapshot;
	expect(snapshot.control.status).toBe("allowed");
	await settings.execute({
		kind: "preferences.features.clearOverride",
		sessionId: h.root.sessionId,
		key: "computer.enabled",
	});
	expect(cfgComputerEnabled.get(h.root.settings)).toBe(false);
	snapshot = (await h.service.query({
		kind: "computer.workspace.get",
		sessionId: h.root.sessionId,
	})) as ComputerWorkspaceSnapshot;
	expect(snapshot.control.status).toBe("stopped");
});

test("two visible consumers share one observer and the last close removes only observation bytes", async () => {
	const h = await harness();
	const one = (await h.service.execute({
		kind: "computer.observe.open",
		sessionId: h.root.sessionId,
		consumerId: "main",
	})) as ComputerObservationLease;
	const two = (await h.service.execute({
		kind: "computer.observe.open",
		sessionId: h.root.sessionId,
		consumerId: "float",
	})) as ComputerObservationLease;
	expect(h.observers.length).toBe(1);
	const frame = (await h.service.execute({
		kind: "computer.frame.capture",
		sessionId: h.root.sessionId,
		leaseId: one.leaseId,
		targetId: "display:test",
	})) as ComputerFrame;
	const output = path.join(h.directory, "outputs", hash(h.root.sessionId), `${frame.frameId}.bin`);
	expect(await Bun.file(output).bytes()).toEqual(new Uint8Array(png));
	expect(await fs.readdir(path.join(h.directory, "jobs")).catch(() => [])).toEqual([]);
	await h.service.execute({ kind: "computer.observe.close", sessionId: h.root.sessionId, leaseId: one.leaseId });
	expect(h.observers[0].closed).toBe(0);
	expect(await Bun.file(output).exists()).toBe(true);
	await h.service.execute({ kind: "computer.observe.close", sessionId: h.root.sessionId, leaseId: two.leaseId });
	expect(h.observers[0].closed).toBe(1);
	expect(await Bun.file(output).exists()).toBe(false);
});

test("120-second leases expire, old native bindings cannot opt into passive capture, and status does not poll", async () => {
	const h = await harness();
	const lease = (await h.service.execute({
		kind: "computer.observe.open",
		sessionId: h.root.sessionId,
		consumerId: "main",
	})) as ComputerObservationLease;
	await h.service.query({ kind: "computer.workspace.get", sessionId: h.root.sessionId });
	await h.service.query({ kind: "computer.workspace.get", sessionId: h.root.sessionId });
	expect(h.observers[0].reads).toBe(1);
	h.tick(120_001);
	await expect(
		h.service.execute({
			kind: "computer.frame.capture",
			sessionId: h.root.sessionId,
			leaseId: lease.leaseId,
			targetId: "display:test",
		}),
	).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	expect(h.observers[0].closed).toBe(1);
	const stale = observer();
	Object.assign(stale, { observationOnly: undefined });
	const root = session(crypto.randomUUID());
	const service = new StudioComputerWorkspaceService(root, {
		directory: h.directory,
		ownedSessions: () => [root],
		observer: () => stale,
	});
	disposals.push(() => service.dispose());
	const snapshot = (await service.query({
		kind: "computer.workspace.get",
		sessionId: root.sessionId,
	})) as ComputerWorkspaceSnapshot;
	expect(snapshot.capabilities.observationOnly).toBe(false);
	await expect(
		service.execute({ kind: "computer.observe.open", sessionId: root.sessionId, consumerId: "main" }),
	).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
	expect(stale.reads).toBe(0);
});

test("releasing the last lease fences an in-flight capture and removes its candidate files", async () => {
	const started = Promise.withResolvers<void>();
	const pixels = Promise.withResolvers<DesktopCapture>();
	const h = await harness(async () => {
		started.resolve();
		return pixels.promise;
	});
	const lease = (await h.service.execute({
		kind: "computer.observe.open",
		sessionId: h.root.sessionId,
		consumerId: "main",
	})) as ComputerObservationLease;
	const capture = h.service.execute({
		kind: "computer.frame.capture",
		sessionId: h.root.sessionId,
		leaseId: lease.leaseId,
		targetId: "display:test",
	});
	await started.promise;
	const close = h.service.execute({
		kind: "computer.observe.close",
		sessionId: h.root.sessionId,
		leaseId: lease.leaseId,
	});
	await Promise.resolve();
	pixels.resolve(await observer().capture("display:test"));
	await expect(capture).rejects.toThrow();
	await close;
	const descriptors = path.join(h.directory, "computer-workspace", hash(h.root.sessionId));
	expect(await fs.readdir(descriptors).catch(() => [])).toEqual([]);
	expect(h.observers[0].closed).toBe(1);
});

test("stopping a root gates newly created descendants and service reconstruction without blocking another root", async () => {
	const h = await harness();
	const old = await computerRunPermits(h.root.sessionId, `owner-${h.root.sessionId}`);
	await h.service.execute({ kind: "computer.control.stop", sessionId: h.root.sessionId });
	expect(old[0].signal.aborted).toBe(true);
	const child = session(crypto.randomUUID());
	h.sessions.push(child);
	await expect(computerRunPermits(child.sessionId, `owner-${child.sessionId}`)).rejects.toMatchObject({
		code: "COMMAND_BLOCKED",
	});
	expect(await computerRunPermits("unrelated-root", "unrelated-owner")).toEqual([]);
	await h.service.dispose();
	const restored = new StudioComputerWorkspaceService(h.root, {
		directory: h.directory,
		ownedSessions: () => h.sessions,
	});
	disposals.push(() => restored.dispose());
	await expect(computerRunPermits(child.sessionId)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
});

test("failed runs retain generated frames and mark delivery only after a matching outer tool result", async () => {
	const h = await harness();
	const source = path.join(h.directory, "native-test.png");
	await Bun.write(source, png);
	const identity = { runId: crypto.randomUUID(), sessionId: h.root.sessionId, toolCallId: "outer-eval" };
	const frameId = crypto.randomUUID();
	const ready = Promise.withResolvers<ComputerFrame>();
	h.service.subscribe(event => {
		if (event.kind === "frame" && event.frame.frameId === frameId && event.frame.availability === "available")
			ready.resolve(event.frame);
	});
	emitComputerLifecycle({ kind: "run", identity, phase: "running", at: Date.now() });
	emitComputerLifecycle({
		kind: "frame",
		identity,
		at: Date.now(),
		screenshot: {
			frameId,
			path: source,
			width: 1,
			height: 1,
			coordinateWidth: 1,
			coordinateHeight: 1,
			target: "display:test",
		},
	});
	emitComputerLifecycle({ kind: "run", identity, phase: "failed", at: Date.now() });
	expect((await ready.promise).delivered).toBe(false);
	computerToolResultDelivered(h.root.sessionId, "other-tool", {
		content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
	});
	expect(
		((await h.service.query({ kind: "computer.frame.get", sessionId: h.root.sessionId, frameId })) as ComputerFrame)
			.delivered,
	).toBe(false);
	const result = { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }], details: {} };
	computerToolResultDelivered(h.root.sessionId, "outer-eval", result);
	expect(
		((await h.service.query({ kind: "computer.frame.get", sessionId: h.root.sessionId, frameId })) as ComputerFrame)
			.delivered,
	).toBe(true);
	expect(result.details).toHaveProperty("computerFrames");
	await h.service.dispose();
	expect(await Bun.file(source).exists()).toBe(true);
	expect(await Bun.file(path.join(h.directory, "jobs", hash(h.root.sessionId), `${frameId}.json`)).exists()).toBe(
		true,
	);
	const descriptorPath = path.join(h.directory, "computer-workspace", hash(h.root.sessionId), `${frameId}.json`);
	expect(await Bun.file(descriptorPath).json()).toMatchObject({ runFinished: true, frame: { delivered: true } });
	await Bun.write(
		descriptorPath.replace(/\.json$/u, ".artifact.json"),
		JSON.stringify({ kept: false, expired: true, scopeSessionId: h.root.sessionId, frameId }),
	);
	const restored = new StudioComputerWorkspaceService(h.root, {
		directory: h.directory,
		ownedSessions: () => [h.root],
		observer: () => observer(),
	});
	disposals.push(() => restored.dispose());
	expect(
		((await restored.query({ kind: "computer.frame.get", sessionId: h.root.sessionId, frameId })) as ComputerFrame)
			.availability,
	).toBe("expired");
	expect(
		(
			(await restored.query({
				kind: "computer.workspace.get",
				sessionId: h.root.sessionId,
			})) as ComputerWorkspaceSnapshot
		).frames,
	).toEqual([]);
});

test("outer tool images retain private frame references before asynchronous asset persistence", async () => {
	const h = await harness();
	const source = path.join(h.directory, "pending-native.png");
	await Bun.write(source, png);
	const identity = { runId: crypto.randomUUID(), sessionId: h.root.sessionId, toolCallId: "fast-outer-eval" };
	const frameId = crypto.randomUUID();
	const ready = Promise.withResolvers<ComputerFrame>();
	h.service.subscribe(event => {
		if (event.kind === "frame" && event.frame.frameId === frameId && event.frame.availability === "available")
			ready.resolve(event.frame);
	});
	emitComputerLifecycle({ kind: "run", identity, phase: "running", at: Date.now() });
	emitComputerLifecycle({
		kind: "frame",
		identity,
		at: Date.now(),
		screenshot: {
			frameId,
			sha256: createHash("sha256").update(png).digest("hex"),
			path: source,
			width: 1,
			height: 1,
			coordinateWidth: 1,
			coordinateHeight: 1,
			target: "display:test",
		},
	});
	const result = { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }], details: {} };
	// No await here: the outer result can arrive before the private file write finishes.
	computerToolResultDelivered(h.root.sessionId, identity.toolCallId, result);
	expect(result.content[0]).toHaveProperty("computerFrame.frameId", frameId);
	expect(projectToolMedia(result.content, result.details).data).toMatchObject({
		media: [{ computerFrame: { frameId } }],
	});
	expect((await ready.promise).delivered).toBe(true);
	emitComputerLifecycle({ kind: "run", identity, phase: "completed", at: Date.now() });
});
