import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { ArtifactLibrary, liveAudioSocketName } from "@omp-studio/studio-host";
import type { DictationCaptureState, DictationChannel, DictationConfiguration, DictationInput } from "@omp-studio/studio-protocol";
import { RuntimeMediaFiles } from "../src/runtime-media-files.js";
import { DesktopDictationAudio, DictationAudioError, registerDictationAudioIpc } from "../src/dictation-audio.js";
import { DICTATION_AUDIO_CHANNELS, DICTATION_MAX_PCM_BYTES, type DictationDesktopEvent, type DictationAudioResult } from "../src/dictation-audio-shared.js";
import type { TerminalIpcMain, TerminalSender } from "../src/terminal-ipc.js";

const configuration: DictationConfiguration = {
  protocolVersion: 2, configurationId: "dictation-config", available: true, enabled: true,
  model: "test-transcriber", language: "zh", submitTrigger: "never", mode: "batch",
  languageSupport: "supported", cloud: false, credentials: "local", downloadRequired: false,
  sources: { enabled: "global", language: "global", submitTrigger: "global" },
};
const state = (phase: DictationCaptureState["phase"], committedText = "", partialText = ""): DictationCaptureState => ({ phase, committedText, partialText, submit: false });
const owner = { sessionId: "session", draftId: "main-draft" };
const code = (expected: string) => (error: unknown) => error instanceof DictationAudioError && error.code === expected;
async function until(predicate: () => boolean): Promise<void> {
  const expires = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > expires) throw new Error("Socket behavior did not complete"); await new Promise(resolve => setTimeout(resolve, 2)); }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "studio-dictation-"));
  const socketDirectory = process.platform === "win32" ? directory : await mkdtemp(join("/tmp", "omp-da-"));
  await mkdir(join(directory, "audio"));
  const files = new RuntimeMediaFiles(new ArtifactLibrary({ profileDirectory: directory }));
  const manager = new DesktopDictationAudio({ directory: () => directory, files: () => files, socketDirectory: async () => socketDirectory });
  const events: DictationDesktopEvent[] = [];
  manager.onEvent((_windowId, event) => events.push(event));
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => { manager.dispose(); for (const cleanup of cleanups) await cleanup(); await rm(directory, { recursive: true, force: true }); if (socketDirectory !== directory) await rm(socketDirectory, { recursive: true, force: true }); });

  async function channel(options: { autoReady?: boolean; autoDrain?: boolean; rejectAuth?: boolean; completeOnStop?: boolean; collectPcm?: boolean } = {}) {
    const audioId = randomUUID(), token = randomBytes(32).toString("hex");
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${audioId}` : join(socketDirectory, liveAudioSocketName(audioId));
    const peers: Socket[] = [];
    const controls: DictationInput[] = [], pcm: Buffer[] = [];
    let frames = 0, pcmBytes = 0, authenticated = false, sequence = -1;
    const publish = (value: Record<string, unknown>) => { const peer = peers[0]; if (peer && !peer.destroyed) peer.write(JSON.stringify({ ...value, audioId, sequence: ++sequence }) + "\n"); };
    const publishState = (value: DictationCaptureState) => publish({ kind: "state", state: value });
    const server = createServer(socket => {
      peers.push(socket); socket.on("error", () => {});
      let pending = Buffer.alloc(0);
      socket.on("data", data => {
        pending = Buffer.concat([pending, data]);
        if (!authenticated) {
          const end = pending.indexOf(10); if (end < 0) return;
          assert.equal(pending.subarray(0, end).toString(), token);
          pending = pending.subarray(end + 1);
          if (options.rejectAuth) { socket.end("NO\n"); return; }
          authenticated = true;
          // Coalesced OK + initial state exercises handshake buffering, not a mock success.
          socket.write("OK\n" + JSON.stringify({ kind: "state", audioId, sequence: ++sequence, state: state("prepared") }) + "\n");
        }
        while (pending.length >= 4) {
          const tag = pending.readUInt32LE(), length = tag & 0x7fffffff;
          if (pending.length < length + 4) break;
          const content = pending.subarray(4, length + 4); pending = pending.subarray(length + 4);
          if (tag & 0x80000000) {
            const input = JSON.parse(content.toString("utf8")) as DictationInput; controls.push(input);
            if (input.kind === "start" && options.autoReady !== false) publishState(state("ready"));
            if (input.kind === "drain" && options.autoDrain !== false) publish({ kind: "drained", requestId: input.requestId });
            if (input.kind === "stop" && options.completeOnStop) publishState(state("complete", "中文 API 尾句"));
            if (input.kind === "cancel") socket.end();
          } else {
            frames++; pcmBytes += content.length;
            if (options.collectPcm !== false) pcm.push(Buffer.from(content));
          }
        }
      });
    });
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    const expiresAt = Date.now() + 30000;
    const descriptor = { version: 2, audioId, endpoint, token, sessionId: owner.sessionId, expiresAt };
    const path = join(directory, "audio", audioId + ".json");
    await writeFile(path, JSON.stringify(descriptor));
    cleanups.push(async () => { peers.forEach(peer => peer.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); });
    const publicChannel: DictationChannel = { protocolVersion: 2, audioId, sessionId: owner.sessionId, expiresAt, configuration };
    return { channel: publicChannel, peers, controls, pcm, publish, publishState,
      get authenticated() { return authenticated; }, get frames() { return frames; }, get pcmBytes() { return pcmBytes; },
      rewriteDescriptor: async (patch: object) => writeFile(path, JSON.stringify({ ...descriptor, ...patch })),
      ackDrain() { const drain = [...controls].reverse().find(input => input.kind === "drain"); assert.ok(drain?.kind === "drain"); publish({ kind: "drained", requestId: drain.requestId }); },
    };
  }
  async function start(runtime: Awaited<ReturnType<typeof channel>>) {
    await manager.attach(7, { channel: runtime.channel, owner });
    await manager.control(7, { audioId: runtime.channel.audioId, input: { kind: "start", mode: "click", configurationId: configuration.configurationId } });
    await until(() => manager.recovery(7)?.state.phase === "ready");
    await manager.control(7, { audioId: runtime.channel.audioId, input: { kind: "recording" } });
  }
  return { manager, events, channel, start };
}

test("authenticated socket waits ready, delivers first/final PCM, and stops only after consumed drain ACK", async t => {
  const f = await fixture(t), runtime = await f.channel({ autoReady: false, autoDrain: false, completeOnStop: true });
  const audioId = runtime.channel.audioId;
  await f.manager.attach(7, { channel: runtime.channel, owner });
  assert.ok(runtime.authenticated);
  await assert.rejects(f.manager.append(7, { audioId, sequence: 0, bytes: new Float32Array([0.5]).buffer }), code("not-ready"));
  await f.manager.control(7, { audioId, input: { kind: "start", mode: "click", configurationId: configuration.configurationId } });
  runtime.publishState(state("ready")); await until(() => f.manager.recovery(7)?.state.phase === "ready");
  await f.manager.control(7, { audioId, input: { kind: "recording" } });
  const first = f.manager.append(7, { audioId, sequence: 0, bytes: new Float32Array([-1, 0.25]).buffer });
  const tail = f.manager.append(7, { audioId, sequence: 1, bytes: new Float32Array([0.75, 1]).buffer });
  const drain = f.manager.drain(7, { audioId });
  await Promise.all([first, tail]);
  await until(() => runtime.controls.some(input => input.kind === "drain"));
  assert.deepEqual(runtime.pcm.flatMap(bytes => [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)]), [-1, 0.25, 0.75, 1]);
  await assert.rejects(f.manager.control(7, { audioId, input: { kind: "stop" } }), code("not-drained"));
  runtime.ackDrain(); await drain;
  await f.manager.control(7, { audioId, input: { kind: "stop" } });
  await until(() => f.manager.recovery(7)?.state.phase === "complete");
  assert.equal(f.manager.recovery(7)?.state.committedText, "中文 API 尾句");
  assert.equal(f.manager.recovery(7)?.bytes, 8, "success remains recoverable until renderer draft ACK");
  f.manager.release(7, { audioId }); assert.equal(f.manager.recovery(7), null);
});

test("disconnect retains text and audio; retry preserves prior text until ready and replays one PCM16 cache", async t => {
  const f = await fixture(t), original = await f.channel(); await f.start(original);
  await f.manager.append(7, { audioId: original.channel.audioId, sequence: 0, bytes: new Float32Array([-1, 0.5, 1]).buffer });
  original.publishState(state("recording", "已经识别", "尾词"));
  await until(() => f.manager.recovery(7)?.state.committedText === "已经识别");
  original.peers[0]!.destroy(); await until(() => f.manager.recovery(7)?.retained === true);
  assert.equal(f.manager.recovery(7)?.bytes, 6); assert.equal(f.manager.recovery(7)?.state.partialText, "尾词");
  assert.equal(f.manager.recovery(7)?.state.error?.code, "runtime-disconnected");
  assert.equal(f.manager.recovery(8), null);
  await assert.rejects(f.manager.attach(7, { channel: (await f.channel()).channel, owner }), code("recovery-pending"));
  const retry = await f.channel({ autoReady: false, completeOnStop: true });
  await f.manager.attach(7, { channel: retry.channel, owner, recoveryId: original.channel.audioId });
  assert.equal(f.manager.recovery(7)?.state.committedText, "已经识别");
  await f.manager.control(7, { audioId: retry.channel.audioId, input: { kind: "start", mode: "retry", configurationId: configuration.configurationId } });
  retry.publishState(state("preparing"));
  await until(() => f.manager.recovery(7)?.state.phase === "preparing");
  assert.equal(f.manager.recovery(7)?.state.committedText, "已经识别");
  await assert.rejects(f.manager.replay(7, { audioId: retry.channel.audioId }), code("retry-not-ready"));
  retry.publishState(state("ready")); await until(() => f.manager.recovery(7)?.state.phase === "ready");
  await assert.rejects(f.manager.append(7, { audioId: retry.channel.audioId, sequence: 1, bytes: new Float32Array([1]).buffer }), code("capture-stopped"));
  await f.manager.replay(7, { audioId: retry.channel.audioId });
  await until(() => f.manager.recovery(7)?.state.phase === "complete");
  assert.equal(f.manager.recovery(7)?.bytes, 6, "replay does not cache another recording");
  assert.deepEqual(retry.controls.map(input => input.kind).filter(kind => kind !== "cancel"), ["start", "recording", "drain", "stop"]);
  const values = new Float32Array(retry.pcm[0]!.buffer, retry.pcm[0]!.byteOffset, 3);
  assert.equal(values[0], -1); assert.equal(values[2], 1); assert.ok(Math.abs(values[1]! - 0.5) < 0.00004);
  f.manager.release(7, { audioId: retry.channel.audioId }); assert.equal(f.manager.recovery(7), null);
});

test("failed retry leaves the original recognized text and the same audio available", async t => {
  const f = await fixture(t), original = await f.channel(); await f.start(original);
  const audioId = original.channel.audioId;
  await f.manager.append(7, { audioId, sequence: 0, bytes: new Float32Array([0.5]).buffer });
  original.publishState(state("recording", "已有文字", "尚未确认"));
  await until(() => f.manager.recovery(7)?.state.committedText === "已有文字");
  f.manager.retain(7, { audioId });
  const retry = await f.channel({ autoReady: false });
  await f.manager.attach(7, { channel: retry.channel, owner, recoveryId: audioId });
  await f.manager.control(7, { audioId: retry.channel.audioId, input: { kind: "start", mode: "retry", configurationId: configuration.configurationId } });
  retry.publishState({ ...state("error"), error: { code: "credentials-missing", message: "Configure credentials." } });
  await until(() => f.manager.recovery(7)?.retained === true);
  assert.equal(f.manager.recovery(7)?.state.committedText, "已有文字");
  assert.equal(f.manager.recovery(7)?.state.partialText, "尚未确认");
  assert.equal(f.manager.recovery(7)?.state.error?.code, "credentials-missing");
  assert.equal(f.manager.recovery(7)?.bytes, 2);
});

test("hiding retains immediately, accepts only bounded prior tail, and fences late old socket events", async t => {
  const f = await fixture(t), old = await f.channel(); await f.start(old);
  const audioId = old.channel.audioId;
  await f.manager.append(7, { audioId, sequence: 0, bytes: new Float32Array([0.25]).buffer });
  old.publishState(state("recording", "原草稿")); await until(() => f.manager.recovery(7)?.state.committedText === "原草稿");
  f.manager.setVisible(7, false);
  assert.ok(f.events.some(event => event.kind === "retained"));
  old.publishState(state("complete", "迟到结果"));
  await f.manager.append(7, { audioId, sequence: 1, bytes: new Float32Array(3200).buffer });
  await assert.rejects(f.manager.append(7, { audioId, sequence: 2, bytes: new Float32Array([1]).buffer }), code("capture-stopped"));
  await f.manager.drain(7, { audioId });
  assert.equal(f.manager.recovery(7)?.bytes, 6402);
  assert.equal(f.manager.recovery(7)?.state.committedText, "原草稿");
  await assert.rejects(f.manager.attach(7, { channel: (await f.channel()).channel, owner, recoveryId: audioId }), code("window-hidden"));
  f.manager.setVisible(7, true);
  const retry = await f.channel();
  await f.manager.attach(7, { channel: retry.channel, owner, recoveryId: audioId });
  old.publishState(state("complete", "旧捕获不能污染"));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.manager.recovery(7)?.state.committedText, "原草稿");
  f.manager.disposeWindow(7); assert.equal(f.manager.recovery(7), null);
});

test("owner/session fences refuse cross-window recovery and different-draft retry", async t => {
  const f = await fixture(t), runtime = await f.channel(); await f.start(runtime);
  const audioId = runtime.channel.audioId;
  await assert.rejects(f.manager.append(8, { audioId, sequence: 0, bytes: new Float32Array([1]).buffer }), code("owner-mismatch"));
  assert.throws(() => f.manager.release(8, { audioId }), code("owner-mismatch"));
  f.manager.retain(7, { audioId });
  const retry = await f.channel();
  await assert.rejects(f.manager.attach(7, { channel: retry.channel, owner: { ...owner, draftId: "btw" }, recoveryId: audioId }), code("recovery-mismatch"));
  await assert.rejects(f.manager.attach(8, { channel: retry.channel, owner, recoveryId: audioId }), code("owner-mismatch"));
  f.manager.release(7, { audioId });
  await runtime.rewriteDescriptor({ sessionId: "foreign" });
  await assert.rejects(f.manager.attach(7, { channel: runtime.channel, owner }), code("channel-expired"));
  assert.equal(f.manager.recovery(7)?.owner.draftId, owner.draftId);
});

test("real authentication refusal and descriptor endpoint substitution return distinct faults", async t => {
  const f = await fixture(t), refused = await f.channel({ rejectAuth: true });
  await assert.rejects(f.manager.attach(7, { channel: refused.channel, owner }), code("authentication-failed"));
  assert.equal(f.manager.recovery(7)?.state.error?.code, "authentication-failed");
  f.manager.release(7, { audioId: refused.channel.audioId });
  const substituted = await f.channel(); await substituted.rewriteDescriptor({ endpoint: "foreign-private-socket" });
  await assert.rejects(f.manager.attach(7, { channel: substituted.channel, owner }), code("invalid-endpoint"));
  assert.equal(substituted.peers.length, 0);
});

test("ten-minute cap ACKs bounded in-flight tail without caching it and completes normally after drain", async t => {
  const f = await fixture(t), runtime = await f.channel({ collectPcm: false, completeOnStop: true }); await f.start(runtime);
  const audioId = runtime.channel.audioId, bytes = new Float32Array(3200).fill(0.25).buffer;
  for (let sequence = 0; sequence < DICTATION_MAX_PCM_BYTES / 6400; sequence++) await f.manager.append(7, { audioId, sequence, bytes });
  assert.equal(f.manager.recovery(7)?.bytes, DICTATION_MAX_PCM_BYTES);
  assert.equal(f.manager.recovery(7)?.durationMs, 600000);
  assert.equal(f.events.filter(event => event.kind === "limit").length, 1);
  await f.manager.append(7, { audioId, sequence: 3000, bytes });
  await assert.rejects(f.manager.append(7, { audioId, sequence: 3001, bytes }), code("audio-limit"));
  assert.equal(f.manager.recovery(7)?.bytes, DICTATION_MAX_PCM_BYTES);
  assert.equal(f.manager.recovery(7)?.retained, false, "expected limit tail is not a failure");
  await f.manager.drain(7, { audioId });
  await assert.rejects(f.manager.append(7, { audioId, sequence: 3001, bytes: new Float32Array([1]).buffer }), code("audio-limit"));
  await f.manager.control(7, { audioId, input: { kind: "stop" } });
  await until(() => f.manager.recovery(7)?.state.phase === "complete");
  assert.equal(runtime.pcmBytes, DICTATION_MAX_PCM_BYTES * 2, "limit tail is acknowledged but not forwarded");
  assert.equal(f.manager.recovery(7)?.state.committedText, "中文 API 尾句");
  assert.equal(f.manager.recovery(7)?.state.error, undefined);
  f.manager.release(7, { audioId }); assert.equal(f.manager.recovery(7), null);
});

test("receive ordering and bounded partial lines retain the original audio instead of accepting corrupt events", async t => {
  const f = await fixture(t), runtime = await f.channel(); await f.start(runtime);
  await f.manager.append(7, { audioId: runtime.channel.audioId, sequence: 0, bytes: new Float32Array([1]).buffer });
  runtime.peers[0]!.write(JSON.stringify({ kind: "state", audioId: runtime.channel.audioId, sequence: 20, state: state("complete", "bad") }) + "\n");
  await until(() => f.manager.recovery(7)?.retained === true);
  assert.equal(f.manager.recovery(7)?.state.error?.code, "event-sequence");
  assert.equal(f.manager.recovery(7)?.bytes, 2);
  f.manager.release(7, { audioId: runtime.channel.audioId });
  const oversized = await f.channel(); await f.start(oversized);
  oversized.peers[0]!.write("x".repeat(256 * 1024 + 1));
  await until(() => f.manager.recovery(7)?.retained === true);
  assert.equal(f.manager.recovery(7)?.state.error?.code, "event-too-large");
});

class Sender extends EventEmitter implements TerminalSender {
  destroyed = false;
  readonly received: Array<{ channel: string; payload: unknown }> = [];
  constructor(readonly id: number) { super(); }
  isDestroyed() { return this.destroyed; }
  getURL() { return "http://trusted.local"; }
  send(channel: string, payload: unknown) { this.received.push({ channel, payload }); }
}

test("fixed IPC preserves on navigation/hidden and clears on window destruction; recovery never crosses windows", async t => {
  const f = await fixture(t);
  const handlers = new Map<string, (event: { sender: TerminalSender }, payload?: unknown) => unknown>();
  const ipcMain: TerminalIpcMain = { handle(channel, listener) { handlers.set(channel, listener); }, removeHandler(channel) { handlers.delete(channel); } };
  const a = new Sender(7), b = new Sender(8); let visible = true;
  const registration = registerDictationAudioIpc({ ipcMain, manager: f.manager, isTrustedSender: () => true, isVisible: () => visible });
  t.after(() => registration.dispose());
  const invoke = (sender: Sender, channel: string, input?: unknown) => handlers.get(channel)!({ sender }, input) as Promise<DictationAudioResult>;
  const runtime = await f.channel();
  assert.equal((await invoke(a, DICTATION_AUDIO_CHANNELS.attach, { channel: runtime.channel, owner })).ok, true);
  await f.manager.control(7, { audioId: runtime.channel.audioId, input: { kind: "start", mode: "click", configurationId: configuration.configurationId } });
  await until(() => f.manager.recovery(7)?.state.phase === "ready");
  await f.manager.control(7, { audioId: runtime.channel.audioId, input: { kind: "recording" } });
  assert.equal((await invoke(b, DICTATION_AUDIO_CHANNELS.recovery)).recovery, null);
  visible = false;
  assert.equal((await invoke(a, DICTATION_AUDIO_CHANNELS.recovery)).recovery?.retained, true);
  assert.ok(a.received.some(event => (event.payload as DictationDesktopEvent).kind === "retained"));
  visible = true; a.emit("did-navigate");
  assert.ok((await invoke(a, DICTATION_AUDIO_CHANNELS.recovery)).recovery);
  f.manager.release(7, { audioId: runtime.channel.audioId });
  const next = await f.channel();
  assert.equal((await invoke(a, DICTATION_AUDIO_CHANNELS.attach, { channel: next.channel, owner })).ok, true);
  a.emit("did-navigate");
  assert.equal(f.manager.recovery(7)?.retained, true, "navigation retention remains armed after renderer remount");
  a.destroyed = true; a.emit("destroyed"); assert.equal(f.manager.recovery(7), null);
  assert.equal(handlers.has(DICTATION_AUDIO_CHANNELS.event), false);
});
