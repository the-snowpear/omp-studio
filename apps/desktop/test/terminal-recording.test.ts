import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import { TerminalRecordingManager } from "../src/terminal-recording.js";
import { parseRecordingInput } from "../src/terminal-shared.js";

test("records output and resize in the owning window, and finalizes into managed artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-recording-"));
  const library = new ArtifactLibrary({ profileDirectory: directory }); let now = 1000;
  const manager = new TerminalRecordingManager(() => library, () => now);
  try {
    assert.throws(() => manager.start(1, { id: "terminal1" }, { cols: 80, rows: 24, name: "pipes", backend: "pipes" }));
    manager.start(1, { id: "terminal1", workspaceId: "workspace", sessionId: "session" }, { cols: 80, rows: 24, name: "shell", backend: "pty" });
    manager.output(2, "terminal1", "wrong-window"); now = 1100; manager.output(1, "terminal1", "hello\r\n");
    now = 1200; manager.resize(1, "terminal1", 100, 30); now = 1300;
    const status = await manager.stop(1, "terminal1"); assert.equal(status.state, "saved"); assert.ok(status.artifactId);
    const saved = await library.resolve(status.artifactId);
    assert.equal(saved.record.kind, "recording"); assert.equal(saved.record.sessionId, "session");
    const lines = (await readFile(saved.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines[0].studiocast, 1); assert.equal(lines[0].cols, 80);
    assert.deepEqual(lines.slice(1), [[100, { t: "output", data: "hello\r\n" }], [200, { t: "resize", cols: 100, rows: 30 }]]);
    assert.deepEqual(await manager.stop(1, "terminal1"), status);
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test("slow storage saves a bounded prefix and exposes the automatic stop", async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; }); let bytes = 0;
  const library = { register: async (_meta: unknown, stream: AsyncIterable<Uint8Array>) => { await gate; for await (const chunk of stream) bytes += chunk.length; return { artifactId: "saved" }; } } as unknown as ArtifactLibrary;
  const manager = new TerminalRecordingManager(() => library);
  manager.start(1, { id: "terminal1" }, { cols: 80, rows: 24, name: "shell", backend: "pty" });
  for (let i = 0; i < 100; i++) manager.output(1, "terminal1", "x".repeat(64000));
  assert.equal(manager.status(1, "terminal1").state, "saving"); assert.match(manager.status(1, "terminal1").notice!, /limit|keep up/u);
  finish(); const status = await manager.stop(1, "terminal1"); assert.equal(status.state, "saved"); assert.ok(bytes <= 1024 * 1024);
  await manager.dispose();
});
test("recording IPC scope rejects unknown fields and control characters", () => {
  assert.deepEqual(parseRecordingInput({ id: "terminal1", sessionId: "s" }), { id: "terminal1", sessionId: "s" });
  assert.throws(() => parseRecordingInput({ id: "terminal1", path: "private" }));
  assert.throws(() => parseRecordingInput({ id: "terminal1", sessionId: "s\0" }));
});
