import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppPayloadInstaller } from "@omp-studio/runtime-installer";
import { registerPayloadHealthIpc } from "../src/payload-health.js";
import { PAYLOAD_HEALTH_CHANNEL } from "../src/payload-health-shared.js";

function fixture(noteBootSuccess: () => Promise<void>) {
  type Sender = { isDestroyed(): boolean; getURL(): string };
  const handlers = new Map<string, (event: { sender: Sender }, status?: unknown) => unknown>();
  const sender = { isDestroyed: () => false, getURL: () => "file:///renderer/index.html" };
  const gate = registerPayloadHealthIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: (channel) => { handlers.delete(channel); } },
    isTrustedSender: (candidate) => candidate === sender,
    noteBootSuccess,
  });
  return { gate, handlers, report: (status: unknown, from = sender) => handlers.get(PAYLOAD_HEALTH_CHANNEL)!({ sender: from }, status) };
}

test("load and bootstrap alone preserve attempts; explicit workbench health resets persisted attempts once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "payload-health-"));
  try {
    const path = join(directory, "current.json");
    await writeFile(path, JSON.stringify({ payloadVersion: "0.1.4", activatedAt: new Date().toISOString(), bootAttempts: 1 }));
    const installer = new AppPayloadInstaller(directory, { trustedKeys: {} });
    let calls = 0;
    const { gate, report } = fixture(async () => { calls++; await installer.noteBootSuccess("0.1.4"); });
    await gate.didFinishLoad();
    assert.equal(JSON.parse(await readFile(path, "utf8")).bootAttempts, 1);
    await Promise.all([report("ready"), report("ready"), gate.didFinishLoad()]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).bootAttempts, 0);
    assert.equal(calls, 1);
    gate.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("early ready waits for load; renderer failure permanently blocks this boot confirmation", async () => {
  let calls = 0;
  const { gate, report } = fixture(async () => { calls++; });
  await report("ready");
  assert.equal(calls, 0);
  await report("failed");
  await gate.didFinishLoad();
  await report("ready");
  assert.equal(calls, 0);
});

test("malformed, untrusted, destroyed, disposed and crashed renderers cannot confirm", async () => {
  let calls = 0;
  const { gate, report, handlers } = fixture(async () => { calls++; });
  await gate.didFinishLoad();
  assert.equal(await report({ status: "ready" }), false);
  assert.equal(await report("ready", { isDestroyed: () => false, getURL: () => "file:///renderer/index.html" }), false);
  assert.equal(await report("ready", { isDestroyed: () => true, getURL: () => "file:///renderer/index.html" }), false);
  gate.failed();
  await report("ready");
  gate.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(calls, 0);
});
