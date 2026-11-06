import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import type { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";
import { cfgSttLanguage, cfgSttSubmitTrigger } from "../src/stt/settings";
import * as downloader from "../src/stt/downloader";
import { sttClient, type SttStreamOptions } from "../src/stt/asr-client";
import type {
	DictationChannel,
	DictationConfiguration,
	DictationEvent,
	DictationInput,
	DictationInputMode,
} from "../src/studio/dictation-protocol";
import { StudioLiveAudioService } from "../src/studio/services/live-audio-service";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});
async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error("Dictation did not settle");
}
function control(input: DictationInput): Buffer {
	const body = Buffer.from(JSON.stringify(input));
	const frame = Buffer.alloc(4 + body.length);
	frame.writeUInt32LE((body.length | 0x80000000) >>> 0);
	body.copy(frame, 4);
	return frame;
}
function pcm(samples: number[]): Buffer {
	const frame = Buffer.alloc(4 + samples.length * 4);
	frame.writeUInt32LE(samples.length * 4);
	for (let i = 0; i < samples.length; i++) frame.writeFloatLE(samples[i]!, 4 + i * 4);
	return frame;
}
function configuration(result: unknown): DictationConfiguration {
	return result as DictationConfiguration;
}
async function setup(
	options: {
		text?: string;
		modelId?: string;
		warmup?: Promise<void>;
		flush?: Promise<string>;
		prepareTimeoutMs?: number;
	} = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-dictation-"));
	const socketDirectory = process.platform === "win32" ? undefined : await fs.mkdtemp("/tmp/omp-dct-");
	const settings = Settings.isolated({ "stt.enabled": true, "stt.language": "zh", "stt.submitTrigger": "say-submit" });
	settings.setModelRole("dictation", `local/${options.modelId ?? "whisper-base"}`);
	const models = [
		getBundledModel("local", "whisper-base"),
		getBundledModel("local", "whisper-small"),
		getBundledModel("local", "nemotron-streaming-en-0.6b"),
		getBundledModel("local", "parakeet-tdt-0.6b-v3"),
	];
	let change: (() => void) | undefined;
	let sessionId = "one";
	let streamOptions: SttStreamOptions | undefined;
	let cache = true;
	let auth = true;
	let allModels: Model<Api>[] = models;
	const session = {
		get sessionId() {
			return sessionId;
		},
		settings,
		modelRegistry: {
			getError: () => undefined,
			getAvailable: () => allModels,
			getAll: () => allModels,
			resolver: vi.fn(() => () => "secret-test-token"),
			hasConfiguredAuth: () => auth,
			hasCommandBackedApiKey: () => false,
			authStorage: { keys: { source: () => (auth ? { kind: "env", concrete: true } : undefined) } },
		},
		registerSessionChangeCallback: (fn: () => void) => {
			change = fn;
			return () => {};
		},
	} as unknown as AgentSession;
	const pushed: number[] = [];
	const cancelled = vi.fn();
	const stop = vi.fn(async () => (options.flush ? await options.flush : (options.text ?? "修复接口，提交。")));
	vi.spyOn(downloader, "isSttModelCached").mockImplementation(async () => cache);
	const warm = vi.spyOn(downloader, "downloadSttModel").mockImplementation(async (_key, progress) => {
		progress?.({ status: "progress", percent: 25, loaded: 250, total: 1000, repo: "test", label: "test" });
		await options.warmup;
	});
	const startStream = vi.spyOn(sttClient, "startStream").mockImplementation((_key, nextOptions) => {
		streamOptions = nextOptions;
		return {
			pushAudio: samples => {
				pushed.push(...samples);
			},
			stop,
			cancel: cancelled,
		};
	});
	vi.spyOn(KeybindingsManager, "create").mockReturnValue(
		KeybindingsManager.inMemory({ "app.stt.pushToTalk": ["ctrl+space"], "app.stt.toggle": ["f4"] }),
	);
	const audio = new StudioLiveAudioService(session, {
		directory,
		socketDirectory,
		dictationFlushTimeoutMs: 50,
		prepareTimeoutMs: options.prepareTimeoutMs,
	});
	const sockets: net.Socket[] = [];
	cleanups.push(async () => {
		sockets.forEach(socket => socket.destroy());
		audio.dispose();
		await Bun.sleep(20);
		await fs.rm(directory, { recursive: true, force: true });
		if (socketDirectory) await fs.rm(socketDirectory, { recursive: true, force: true });
	});
	async function open() {
		const inspected = configuration(await audio.dictation({ kind: "dictation.inspect", sessionId }));
		const channel = (await audio.dictation({
			kind: "dictation.open",
			sessionId,
			configurationId: inspected.configurationId,
		})) as DictationChannel;
		const descriptor = await Bun.file(path.join(directory, "audio", `${channel.audioId}.json`)).json();
		expect(descriptor.version).toBe(2);
		const socket = net.connect(descriptor.endpoint);
		sockets.push(socket);
		socket.on("error", () => {});
		const events: DictationEvent[] = [];
		let lines = "";
		socket.on("data", data => {
			lines += data.toString();
			for (;;) {
				const end = lines.indexOf("\n");
				if (end < 0) break;
				const line = lines.slice(0, end);
				lines = lines.slice(end + 1);
				if (line !== "OK") events.push(JSON.parse(line));
			}
		});
		socket.once("connect", () => socket.write(descriptor.token + "\n"));
		await waitFor(() => events.length > 0);
		expect(events[0]).toMatchObject({ kind: "state", sequence: 0, state: { phase: "prepared" } });
		return {
			socket,
			events,
			channel,
			descriptor,
			start: (mode: DictationInputMode = "click", id = channel.configuration.configurationId) =>
				socket.write(control({ kind: "start", mode, configurationId: id })),
			waitPhase: (phase: string) =>
				waitFor(() => events.some(event => event.kind === "state" && event.state.phase === phase)),
		};
	}
	return {
		audio,
		directory,
		settings,
		session,
		open,
		pushed,
		cancelled,
		stop,
		startStream,
		warm,
		stream: () => streamOptions!,
		changeSession: () => {
			sessionId = "two";
			change?.();
		},
		cache: (value: boolean) => {
			cache = value;
		},
		cloud: (model: Model<Api>, configured: boolean) => {
			allModels = [model];
			auth = configured;
			settings.setModelRole("dictation", `${model.provider}/${model.id}`);
		},
	};
}

test("receiver warms before ready, authenticated preparation survives descriptor expiry, and early cancel cannot revive capture", async () => {
	const warmup = Promise.withResolvers<void>();
	const state = await setup({ warmup: warmup.promise, prepareTimeoutMs: 200 });
	const capture = await state.open();
	capture.start();
	await capture.waitPhase("preparing");
	await Bun.sleep(240);
	expect(state.startStream).not.toHaveBeenCalled();
	expect(capture.socket.destroyed).toBe(false);
	expect(capture.events.some(event => event.kind === "state" && event.state.progress?.loaded === 250)).toBe(true);
	capture.socket.write(control({ kind: "cancel" }));
	await capture.waitPhase("cancelled");
	warmup.resolve();
	await Bun.sleep(20);
	expect(state.startStream).not.toHaveBeenCalled();
	expect(
		capture.events.filter(
			event => event.kind === "state" && ["complete", "cancelled", "error"].includes(event.state.phase),
		),
	).toHaveLength(1);
	expect(state.audio.running).toBe(false);
});

test("first and final PCM precede drain confirmation and temporary text never enters command metadata", async () => {
	const state = await setup();
	const capture = await state.open();
	capture.start("hold");
	await capture.waitPhase("ready");
	expect(state.pushed).toEqual([]);
	capture.socket.write(
		Buffer.concat([
			control({ kind: "recording" }),
			pcm([0.25, -0.5]),
			pcm([0.75]),
			control({ kind: "drain", requestId: "tail" }),
		]),
	);
	await waitFor(() => capture.events.some(event => event.kind === "drained"));
	expect(state.pushed).toEqual([0.25, -0.5, 0.75]);
	state.stream().onPartial?.("temporary secret");
	state.stream().onPartial?.("temporary secret");
	const metadata = await state.audio.dictation({ kind: "dictation.status", sessionId: "one" });
	expect(metadata).toMatchObject({ text: "" });
	expect(JSON.stringify(metadata)).not.toContain("temporary secret");
	capture.socket.write(control({ kind: "snapshot" }));
	await waitFor(() =>
		capture.events.some(event => event.kind === "state" && event.state.partialText === "temporary secret"),
	);
	capture.socket.write(control({ kind: "stop" }));
	await capture.waitPhase("complete");
	const terminal = capture.events.findLast(event => event.kind === "state" && event.state.phase === "complete");
	expect(terminal).toMatchObject({ state: { committedText: "修复接口", partialText: "", submit: true } });
	const texts = capture.events.filter(
		event =>
			event.kind === "state" && event.state.phase === "recording" && event.state.partialText === "temporary secret",
	);
	// One changed recording event plus the explicit snapshot; a phase transition
	// may legitimately retain partial text without being a duplicate update.
	expect(texts).toHaveLength(2);
	expect(capture.events.map(event => event.sequence)).toEqual(capture.events.map((_event, index) => index));
	expect(JSON.stringify(capture.events)).not.toContain(capture.descriptor.token);
	expect(JSON.stringify(capture.channel)).not.toContain(capture.descriptor.endpoint);
	expect(state.stop).toHaveBeenCalledTimes(1);
});

test("click and retry preserve spoken submit as draft; no speech produces a terminal notice", async () => {
	const state = await setup();
	for (const mode of ["click", "retry"] as const) {
		const capture = await state.open();
		capture.start(mode);
		await capture.waitPhase("ready");
		capture.socket.write(Buffer.concat([control({ kind: "recording" }), pcm([0.25]), control({ kind: "stop" })]));
		await capture.waitPhase("complete");
		expect(capture.events.findLast(event => event.kind === "state")).toMatchObject({
			state: { committedText: "修复接口，提交。", submit: false },
		});
	}
	state.stop.mockResolvedValue("");
	const silent = await state.open();
	silent.start();
	await silent.waitPhase("ready");
	silent.socket.write(Buffer.concat([control({ kind: "recording" }), control({ kind: "stop" })]));
	await silent.waitPhase("complete");
	expect(silent.events.findLast(event => event.kind === "state")).toMatchObject({
		state: { notice: "no-speech", committedText: "", submit: false },
	});
});

test("Live and concurrent opens are mutually exclusive and legacy startup cannot downgrade privacy", async () => {
	const state = await setup();
	const inspected = configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }));
	const results = await Promise.allSettled([
		state.audio.dictation({ kind: "dictation.open", sessionId: "one", configurationId: inspected.configurationId }),
		state.audio.dictation({ kind: "dictation.open", sessionId: "one", configurationId: inspected.configurationId }),
	]);
	expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
	expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
	await expect(state.audio.execute({ kind: "live.audio.prepare", sessionId: "one" })).rejects.toThrow("Stop");
	const opened = (results.find(row => row.status === "fulfilled") as PromiseFulfilledResult<DictationChannel>).value;
	const cancelled = await state.audio.dictation({
		kind: "dictation.cancel",
		sessionId: "one",
		audioId: opened.audioId,
	});
	expect(cancelled).toMatchObject({ text: "", phase: "off" });
	expect(state.audio.running).toBe(false);
	await Bun.sleep(20);
	expect(await Bun.file(path.join(state.directory, "audio", `${opened.audioId}.json`)).exists()).toBe(false);
	await expect(state.audio.dictation({ kind: "dictation.prepare", sessionId: "one" })).rejects.toThrow("version 2");
});

test("configuration changes during warmup release native worker capture and stop before recording does not transcribe", async () => {
	const warmup = Promise.withResolvers<void>();
	const state = await setup({ warmup: warmup.promise });
	const capture = await state.open();
	capture.start();
	await capture.waitPhase("preparing");
	cfgSttLanguage.override(state.settings, "en");
	warmup.resolve();
	await capture.waitPhase("error");
	expect(capture.events.findLast(event => event.kind === "state")).toMatchObject({
		state: { error: { code: "CONFIGURATION_CHANGED" } },
	});
	expect(state.cancelled).toHaveBeenCalled();
	expect(state.audio.running).toBe(false);
	const next = await state.open();
	next.start();
	await next.waitPhase("ready");
	next.socket.write(control({ kind: "stop" }));
	await next.waitPhase("cancelled");
	expect(state.stop).not.toHaveBeenCalled();
});

test("stale start and audio before recording are terminal failures, never silently discarded", async () => {
	const state = await setup();
	const stale = await state.open();
	stale.start("click", "old-configuration");
	await stale.waitPhase("error");
	expect(state.startStream).not.toHaveBeenCalled();
	expect(stale.events.findLast(event => event.kind === "state")).toMatchObject({
		state: { error: { code: "CONFIGURATION_CHANGED" } },
	});
	const earlyAudio = await state.open();
	earlyAudio.start();
	await earlyAudio.waitPhase("ready");
	earlyAudio.socket.write(pcm([0.25]));
	await earlyAudio.waitPhase("error");
	expect(state.pushed).toEqual([]);
	expect(earlyAudio.events.findLast(event => event.kind === "state")).toMatchObject({
		state: { error: { code: "RECEIVER_NOT_READY" } },
	});
	expect(state.audio.running).toBe(false);
});

test("failed flush and session change fence late native text and free the next capture", async () => {
	const flush = Promise.withResolvers<string>();
	const state = await setup({ flush: flush.promise });
	const capture = await state.open();
	capture.start();
	await capture.waitPhase("ready");
	capture.socket.write(Buffer.concat([control({ kind: "recording" }), pcm([0.25])]));
	await capture.waitPhase("recording");
	state.stream().onSegment?.("confirmed prefix", 0);
	state.stream().onPartial?.(" unconfirmed ending");
	capture.socket.write(control({ kind: "stop" }));
	await capture.waitPhase("error");
	expect(capture.events.findLast(event => event.kind === "state")).toMatchObject({
		state: {
			committedText: "confirmed prefix",
			partialText: " unconfirmed ending",
			submit: false,
			error: { code: "STT_FAILED" },
		},
	});
	flush.resolve("late secret");
	state.stream().onSegment?.("late secret", 1);
	await Bun.sleep(20);
	expect(JSON.stringify(capture.events)).not.toContain("late secret");
	expect(state.audio.running).toBe(false);
	const next = await state.open();
	next.start();
	await next.waitPhase("ready");
	state.changeSession();
	state.stream().onPartial?.("other owner's text");
	await Bun.sleep(20);
	expect(JSON.stringify(next.events)).not.toContain("other owner's text");
	expect(
		next.events.filter(
			event => event.kind === "state" && ["complete", "cancelled", "error"].includes(event.state.phase),
		),
	).toHaveLength(1);
});

test("inspection reports real language coverage, cache and credential sources without invoking the resolver", async () => {
	const state = await setup({ modelId: "nemotron-streaming-en-0.6b" });
	const englishOnly = configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }));
	expect(englishOnly).toMatchObject({
		hotkeys: { pushToTalk: ["ctrl+space"], toggle: ["f4"] },
		languageSupport: "unsupported",
		blockedReason: "language-unsupported",
		mode: "streaming",
	});
	state.settings.setModelRole("dictation", "local/parakeet-tdt-0.6b-v3");
	expect(configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }))).toMatchObject({
		languageSupport: "unsupported",
	});
	state.settings.setModelRole("dictation", "local/whisper-base");
	const initial = configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }));
	state.cache(false);
	const uncached = configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }));
	expect(uncached).toMatchObject({
		languageSupport: "supported",
		downloadRequired: true,
		configurationId: initial.configurationId,
		credentials: "local",
	});
	cfgSttSubmitTrigger.override(state.settings, "release");
	expect(
		configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" })).configurationId,
	).not.toBe(initial.configurationId);
	const cloud = {
		...getBundledModel("local", "whisper-base"),
		provider: "private",
		id: "custom-stt",
		api: "openai-transcriptions",
	} as Model<Api>;
	state.cloud(cloud, false);
	const missingCloud = configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }));
	expect(missingCloud).toMatchObject({
		cloud: true,
		mode: "batch",
		credentials: "missing",
		blockedReason: "credentials-missing",
		languageSupport: "unknown",
	});
	state.cloud(cloud, true);
	const configuredCloud = configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" }));
	expect(configuredCloud).toMatchObject({
		credentials: "configured",
		sources: { credentials: "env" },
		configurationId: missingCloud.configurationId,
	});
	state.cloud({ ...cloud, baseUrl: "https://other.example/transcriptions" }, true);
	expect(
		configuration(await state.audio.dictation({ kind: "dictation.inspect", sessionId: "one" })).configurationId,
	).not.toBe(configuredCloud.configurationId);
	expect(state.warm).not.toHaveBeenCalled();
	expect(state.session.modelRegistry.resolver).not.toHaveBeenCalled();
	expect(state.startStream).not.toHaveBeenCalled();
});
