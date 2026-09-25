import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import { RuntimeMediaFiles } from "../src/runtime-media-files.js";
import { DesktopLiveAudio } from "../src/live-audio.js";

test("PCM IPC is window-owned, ordered, bounded, and disconnected on window cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-live-main-")); const audioId = randomUUID(), token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\omp-studio-audio-${audioId}` : join(directory, "audio", audioId + ".sock");
  const peers: Socket[] = []; const frames: Buffer[] = [];
  const server = createServer(socket => {
    peers.push(socket); let pending = Buffer.alloc(0); let authenticated = false;
    socket.on("data", data => {
      pending = Buffer.concat([pending, data]);
      if (!authenticated && pending.length >= 65) { assert.equal(pending.subarray(0, 65).toString(), token + "\n"); pending = pending.subarray(65); authenticated = true; socket.write("OK\n"); }
      if (authenticated && pending.length >= 8) { frames.push(pending); pending = Buffer.alloc(0); }
    });
  });
  const files = new RuntimeMediaFiles(new ArtifactLibrary({ profileDirectory: directory })); const manager = new DesktopLiveAudio({ directory: () => directory, files: () => files });
  try {
    await mkdir(join(directory, "audio"));
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    await writeFile(join(directory, "audio", audioId + ".json"), JSON.stringify({ version: 1, audioId, token, endpoint, sessionId: "s", expiresAt: Date.now() + 30000 }));
    await manager.attach(7, { audioId, sessionId: "s" });
    const bytes = new Float32Array([0.5]).buffer;
    await assert.rejects(() => manager.chunk(8, { audioId, sequence: 0, bytes }), /this window/u);
    await assert.rejects(() => manager.chunk(7, { audioId, sequence: 1, bytes }), /out-of-order/u);
    await assert.rejects(() => manager.chunk(7, { audioId, sequence: 0, bytes: new Float32Array([NaN]).buffer }), /samples/u);
    await manager.chunk(7, { audioId, sequence: 0, bytes });
    for (let i = 0; i < 100 && !frames.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(frames[0]?.readUInt32LE(), 4); assert.equal(frames[0]?.readFloatLE(4), 0.5);
    manager.disposeWindow(7); await assert.rejects(() => manager.chunk(7, { audioId, sequence: 1, bytes }), /this window/u);
    await assert.rejects(() => manager.attach(7, { audioId, sessionId: "foreign" }), /expired/u);
  } finally { manager.dispose(); peers.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
