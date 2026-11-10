import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNodeSessionTelemetryProbe, type SpawnFunction } from "../src/telemetry-probe.js";

test("cancelled archive probe kills its child and waits for close before releasing scratch ownership", async () => {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0, settled = false, spawned!: () => void;
  const started = new Promise<void>(resolve => { spawned = resolve; });
  child.kill = () => { killed++; return true; };
  const probe = createNodeSessionTelemetryProbe({ executablePath: () => "synthetic-test-executable", spawnProcess: (() => { spawned(); return child; }) as unknown as SpawnFunction });
  const controller = new AbortController();
  const request = probe.run({ sessionId: "test", sessionFile: "unused", allowedCwd: ".", transcriptRevision: "1", signal: controller.signal }).then(value => { settled = true; return value; });
  await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, 1); assert.equal(settled, false);
  child.emit("close", null);
  assert.equal((await request).ok, false);
  probe.dispose();
});
