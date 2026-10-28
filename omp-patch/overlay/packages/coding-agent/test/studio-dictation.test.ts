import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import type { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";
import type { SttTarget, SttCallbacks } from "../src/stt";
import { StudioLiveAudioService } from "../src/studio/services/live-audio-service";

const directories: string[] = [];
afterEach(async () => {
	await Bun.sleep(20);
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(hangs = false) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-dictation-"));
	directories.push(directory);
	let target: SttTarget | undefined,
		callbacks: SttCallbacks | undefined,
		disposed = 0;
	let phase: "idle" | "recording" | "transcribing" = "idle";
	let change: (() => void) | undefined;
	let sessionId = "one";
	const session = {
		get sessionId() {
			return sessionId;
		},
		settings: Settings.isolated({ "stt.enabled": true }),
		resolveRoleModel: () => ({ provider: "test", id: "cloud", api: "openai-transcription" }),
		registerSessionChangeCallback: (fn: () => void) => {
			change = fn;
			return () => {};
		},
	} as unknown as AgentSession;
	const audio = new StudioLiveAudioService(session, {
		directory,
		socketDirectory: process.platform === "win32" ? undefined : directory,
		dictationFlushTimeoutMs: 40,
		createDictationController: createCapture => ({
			get state() {
				return phase;
			},
			async start(nextTarget, nextCallbacks) {
				target = nextTarget;
				callbacks = nextCallbacks;
				createCapture((_error, samples) => target!.setVolatileText(`partial ${samples[0]}`));
				phase = "recording";
				callbacks.onStateChange?.("recording");
			},
			async stop() {
				phase = "transcribing";
				if (hangs) await Promise.withResolvers<void>().promise;
				target!.commitVolatileText("final text");
				phase = "idle";
				callbacks!.onStateChange?.("idle");
			},
			dispose() {
				disposed++;
				phase = "idle";
			},
		}),
	});
	const prepared = await audio.dictation({ kind: "dictation.prepare", sessionId: "one" });
	const descriptor = JSON.parse(await fs.readFile(path.join(directory, "audio", prepared.audioId + ".json"), "utf8"));
	const socket = net.connect(descriptor.endpoint);
	socket.on("error", () => {});
	const ready = Promise.withResolvers<void>();
	socket.once("data", () => ready.resolve());
	socket.once("connect", () => socket.write(descriptor.token + "\n"));
	await ready.promise;
	await audio.dictation({ kind: "dictation.start", sessionId: "one", audioId: prepared.audioId! });
	return {
		audio,
		session,
		socket,
		id: prepared.audioId!,
		target: () => target!,
		changed: () => {
			sessionId = "two";
			change?.();
		},
		disposed: () => disposed,
	};
}

test("authenticated dictation previews text, flushes into draft-only output and excludes Live", async () => {
	const state = await setup();
	try {
		state.target().setVolatileText("partial");
		expect((await state.audio.dictation({ kind: "dictation.status", sessionId: "one" })).text).toBe("partial");
		await expect(state.audio.execute({ kind: "live.audio.prepare", sessionId: "one" })).rejects.toThrow("Stop");
		expect(() => state.target().submit()).toThrow("cannot submit");
		const final = await state.audio.dictation({ kind: "dictation.stop", sessionId: "one", audioId: state.id });
		expect(final).toMatchObject({ phase: "complete", text: "final text" });
		expect(state.disposed()).toBe(1);
	} finally {
		state.socket.destroy();
		state.audio.dispose();
	}
});

test("session changes discard late dictation and a failed flush releases capture without blocking", async () => {
	const state = await setup(true);
	try {
		const final = await state.audio.dictation({ kind: "dictation.stop", sessionId: "one", audioId: state.id });
		expect(final.phase).toBe("error");
		expect(final.error).toContain("timed out");
		expect(state.audio.running).toBe(false);
		state.changed();
		state.target().commitVolatileText("late");
		expect((await state.audio.dictation({ kind: "dictation.status", sessionId: "two" })).text).not.toContain("late");
		const retry = await state.audio.dictation({ kind: "dictation.prepare", sessionId: "two" });
		expect(retry.audioId).not.toBe(state.id);
	} finally {
		state.socket.destroy();
		state.audio.dispose();
	}
});
