import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import type { ComputerFrame } from "@omp-studio/studio-protocol";
import { ComputerFrameStore, registerComputerFrameIpc } from "../src/computer-frames.js";
import { COMPUTER_FRAME_CHANNELS, type ComputerFrameReadResult } from "../src/computer-frames-shared.js";
import type { TerminalSender } from "../src/terminal-ipc.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0O8AAAAASUVORK5CYII=", "base64");
const key = (value: string) => createHash("sha256").update(value).digest("hex");

function pngWithMetadata(): Buffer {
  const text = Buffer.concat([Buffer.from([67, 111, 109, 109, 101, 110, 116, 0]), Buffer.alloc(256 * 1024, 65)]);
  const payload = Buffer.concat([Buffer.from("tEXt"), text]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(text.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((~crc) >>> 0);
  return Buffer.concat([PNG.subarray(0, -12), length, payload, checksum, PNG.subarray(-12)]);
}

async function setup(options: { maxAgeMs?: number; maxStoredBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omp-computer-frames-"));
  const library = new ArtifactLibrary({ profileDirectory: directory });
  let now = Date.now();
  const store = new ComputerFrameStore({ directory: () => directory, library: () => library, now: () => now, ...options });
  async function stage(source: ComputerFrame["source"], scopeSessionId = "scope-a", payload: Buffer = PNG, runFinished = true) {
    const frameId = randomUUID();
    const frame: ComputerFrame = { frameId, sessionId: scopeSessionId + ":child", source, capturedAt: now, targetId: "window:1", width: 1, height: 1, coordinateWidth: 1, coordinateHeight: 1, screenLocked: false, delivered: source === "execution", availability: "available", ...(source === "observation" ? { expiresAt: now + 120000 } : {}) };
    const folder = join(directory, "computer-workspace", key(scopeSessionId));
    const outputs = join(directory, "outputs", key(frame.sessionId));
    await mkdir(folder, { recursive: true }); await mkdir(outputs, { recursive: true });
    const descriptor = join(folder, frameId + ".json");
    const file = join(outputs, frameId + ".bin");
    await writeFile(file, payload);
    await writeFile(descriptor, JSON.stringify({ version: 1, scopeSessionId, frame, bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex"), runFinished }));
    return { input: { scopeSessionId, frameId, origin: "local" as const }, frame, file, descriptor };
  }
  return { directory, library, store, stage, advance: (ms: number) => { now += ms; }, close: async () => { store.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test("observation frames can be read by several surfaces without being consumed or added to artifacts", async () => {
  const env = await setup();
  try {
    const frame = await env.stage("observation");
    const results = await Promise.all([env.store.read(frame.input), env.store.read(frame.input)]);
    for (const result of results) { assert.ok(result.ok); assert.deepEqual(Buffer.from(result.data), PNG); }
    assert.equal((await env.library.list()).total, 0);
    assert.deepEqual(await readFile(frame.file), PNG);
    await assert.rejects(env.store.read({ ...frame.input, scopeSessionId: "other-scope" }));
    await assert.rejects(env.store.read({ ...frame.input, origin: "ssh:remote" }));
  } finally { await env.close(); }
});

test("explicit save survives observer expiry and deletion of the originating session", async () => {
  const env = await setup();
  try {
    const frame = await env.stage("observation");
    const saved = await env.store.save(frame.input); assert.ok(saved.ok);
    env.advance(130000);
    await env.library.finishSession(frame.frame.sessionId, true);
    await env.store.sweep();
    const read = await env.store.read(frame.input); assert.ok(read.ok);
    assert.equal(read.artifactId, saved.artifactId);
    assert.deepEqual(Buffer.from(read.data), PNG);
    assert.equal((await env.library.list()).total, 1);
  } finally { await env.close(); }
});

test("execution images over the old inline budget remain privately readable", async () => {
  const env = await setup();
  try {
    // PNG permits ancillary data; delivery must not impose the conversation JSON/base64 budget.
    const payload = pngWithMetadata();
    const frame = await env.stage("execution", "large-frame", payload);
    const read = await env.store.read(frame.input); assert.ok(read.ok);
    assert.deepEqual(Buffer.from(read.data), payload);
    assert.ok(read.artifactId);
    const again = await env.store.read(frame.input); assert.ok(again.ok);
    assert.equal(again.artifactId, read.artifactId);
    assert.equal((await env.library.list()).total, 1);
  } finally { await env.close(); }
});

test("execution frames stay staged until their run finishes; observation is never automatically promoted", async () => {
  const env = await setup();
  try {
    const running = await env.stage("execution", "running", PNG, false);
    const completed = await env.stage("execution", "completed");
    await env.stage("observation", "observing");
    const read = await env.store.read(running.input); assert.ok(read.ok); assert.equal(read.artifactId, undefined);
    await env.store.sweep();
    assert.equal((await env.library.list()).total, 1);
    assert.deepEqual(await readFile(running.file), PNG);
    const after = await env.store.read(completed.input); assert.ok(after.ok); assert.ok(after.artifactId);
  } finally { await env.close(); }
});

test("automatic retention removes only managed Computer copies, never explicit saves or unrelated files", async () => {
  const env = await setup({ maxAgeMs: 1000 });
  try {
    const expired = await env.stage("execution", "expire");
    const kept = await env.stage("execution", "keep");
    await env.store.save(kept.input);
    const original = join(env.directory, "native-original.png"); await writeFile(original, PNG);
    env.advance(2000); await env.store.sweep();
    await assert.rejects(env.store.read(expired.input));
    assert.ok((await env.store.read(kept.input)).ok);
    assert.deepEqual(await readFile(original), PNG);
  } finally { await env.close(); }
});

test("corrupted payloads cannot be read or promoted as valid evidence", async () => {
  const env = await setup();
  try {
    const frame = await env.stage("execution");
    await writeFile(frame.file, Buffer.alloc(PNG.length));
    await assert.rejects(env.store.read(frame.input));
    assert.equal((await env.library.list()).total, 0);
  } finally { await env.close(); }
});

test("private frame IPC refuses hidden/foreign readers and a late image after its window closes", async () => {
  const env = await setup();
  const handlers = new Map<string, (event: { sender: TerminalSender }, raw?: unknown) => unknown>();
  let visible = true;
  const sender: TerminalSender = { id: 7, isDestroyed: () => false, getURL: () => "file:///studio/index.html", send() {}, once() {}, off() {} };
  const ipc = registerComputerFrameIpc({ store: env.store, isTrustedSender: value => value.id === sender.id, isVisible: () => visible, ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
  try {
    const frame = await env.stage("observation");
    const invoke = async (reader = sender) => await handlers.get(COMPUTER_FRAME_CHANNELS.read)!({ sender: reader }, frame.input) as ComputerFrameReadResult;
    assert.equal((await invoke({ ...sender, id: 8 })).ok, false);
    visible = false; assert.equal((await invoke()).ok, false);
    visible = true;
    const late = invoke(); visible = false; assert.equal((await late).ok, false);
    visible = true; assert.equal((await invoke()).ok, true);
  } finally { ipc.dispose(); await env.close(); }
});
