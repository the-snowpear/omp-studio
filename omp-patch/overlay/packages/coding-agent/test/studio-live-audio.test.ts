import { expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import type { AgentSession } from "../src/session/agent-session";
import { StudioLiveAudioService } from "../src/studio/services/live-audio-service";
import { StudioLiveService } from "../src/studio/services/live-service";

async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error("Mock audio did not settle");
}
it("authenticates local PCM, uses the existing session, and releases on disconnect without reconnecting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-live-audio-"));
	const session = { sessionId: "one" } as AgentSession;
	let starts = 0,
		stops = 0,
		frames = 0;
	const sockets: Socket[] = [];
	const audio = new StudioLiveAudioService(session, {
		directory,
		createController: options => {
			expect(options.session).toBe(session);
			let stopped = false;
			let muted = false;
			let input: { stop(): void } | undefined;
			return {
				get muted() {
					return muted;
				},
				async start() {
					starts++;
					input = options.createAudioInput!((error, samples) => {
						expect(error).toBeNull();
						expect(samples[0]).toBeCloseTo(0.25);
						frames++;
					});
					options.callbacks.onPhase("listening");
					options.callbacks.onLevels(0.1, 0.2);
					for (let turn = 1; turn <= 45; turn++)
						options.callbacks.onTranscript({ role: "assistant", turn, text: "x".repeat(2100), final: true });
				},
				async stop() {
					if (stopped) return;
					stopped = true;
					stops++;
					input?.stop();
					options.callbacks.onTerminal();
				},
				toggleMute() {
					muted = !muted;
					options.callbacks.onPhase(muted ? "muted" : "listening");
				},
			};
		},
	});
	const control = new StudioLiveService(audio.factory);
	audio.bindControl(control);
	try {
		const prepared = await audio.execute({ kind: "live.audio.prepare", sessionId: "one", voice: "sol" });
		expect(starts).toBe(0);
		expect(prepared.phase).toBe("prepared");
		expect(JSON.stringify(prepared)).not.toContain(directory);
		const id = prepared.audioId!;
		const descriptor = JSON.parse(await readFile(join(directory, "audio", id + ".json"), "utf8"));
		await expect(audio.execute({ kind: "live.audio.start", sessionId: "one", audioId: id })).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
		expect(control.state().status).toBe("off");
		expect(starts).toBe(0);
		const denied = connect(descriptor.endpoint);
		sockets.push(denied);
		denied.on("error", () => {});
		await new Promise<void>(resolve => {
			denied.once("close", resolve);
			denied.once("connect", () => denied.write("0".repeat(64) + "\n"));
		});
		expect((await audio.execute({ kind: "live.audio.status", sessionId: "one" })).attached).toBe(false);
		const socket = connect(descriptor.endpoint);
		sockets.push(socket);
		socket.on("error", () => {});
		await new Promise<void>(resolve => {
			socket.once("data", data => {
				expect(data.toString()).toBe("OK\n");
				resolve();
			});
			socket.once("connect", () => socket.write(descriptor.token + "\n"));
		});
		await audio.execute({ kind: "live.audio.start", sessionId: "one", audioId: id });
		expect(starts).toBe(1);
		const frame = Buffer.alloc(8);
		frame.writeUInt32LE(4);
		frame.writeFloatLE(0.25, 4);
		socket.write(frame);
		await waitFor(() => frames === 1);
		const state = await audio.execute({ kind: "live.audio.status", sessionId: "one" });
		expect(state.transcripts).toHaveLength(40);
		expect(state.transcripts[0]!.text.length).toBe(2000);
		expect(JSON.stringify(state)).not.toContain(descriptor.token);
		const muted = await audio.execute({ kind: "live.audio.mute", sessionId: "one", audioId: id, muted: true });
		expect(muted.muted).toBe(true);
		await expect(
			audio.execute({ kind: "live.audio.release", sessionId: "wrong", audioId: id }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		socket.destroy();
		await waitFor(() => stops === 1);
		expect(control.state().status).toBe("off");
		expect((await audio.execute({ kind: "live.audio.status", sessionId: "one" })).phase).toBe("off");
		expect(starts).toBe(1);
		expect((await readdir(join(directory, "audio"))).filter(name => name.endsWith(".json"))).toEqual([]);
		const retry = await audio.execute({ kind: "live.audio.prepare", sessionId: "one" });
		expect(retry.audioId).not.toBe(id);
		expect(starts).toBe(1);
		await audio.execute({ kind: "live.audio.release", sessionId: "one", audioId: retry.audioId! });
	} finally {
		sockets.forEach(socket => socket.destroy());
		control.dispose();
		audio.dispose();
		await Bun.sleep(20);
		await rm(directory, { recursive: true, force: true });
	}
});

it("preparation expiry never opens a provider connection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "studio-live-expiry-"));
	const audio = new StudioLiveAudioService({ sessionId: "one" } as AgentSession, {
		directory,
		prepareTimeoutMs: 50,
		createController: () => {
			throw new Error("Expired input must not create a controller");
		},
	});
	try {
		const prepared = await audio.execute({ kind: "live.audio.prepare", sessionId: "one" });
		await Bun.sleep(80);
		expect((await audio.execute({ kind: "live.audio.status", sessionId: "one" })).phase).toBe("off");
		expect(() => audio.factory.create({ deviceId: prepared.audioId, onActive() {}, onTerminal() {} })).toThrow(
			"Attach this window",
		);
	} finally {
		audio.dispose();
		await Bun.sleep(10);
		await rm(directory, { recursive: true, force: true });
	}
});
