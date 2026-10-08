import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerComputerCaptureIpc } from "../src/computer-observation.js";
import type { ComputerCaptureResult } from "../src/computer-observation-shared.js";
import type { TerminalSender } from "../src/terminal-ipc.js";

test("computer captures reject foreign and hidden readers without consuming the owner's file, then deliver only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-computer-ipc-"));
  let handler: ((event: { sender: TerminalSender }, payload?: unknown) => unknown) | undefined;
  let visible = true;
  const sender: TerminalSender = { id: 4, isDestroyed: () => false, getURL: () => "file:///studio/index.html", send() {}, once() {} };
  const ipc = registerComputerCaptureIpc({ directory: () => directory, isVisible: () => visible, isTrustedSender: value => value.id === sender.id, ipcMain: { handle(_channel, listener) { handler = listener; }, removeHandler() {} } });
  const captureId = randomUUID(); const request = { captureId, sessionId: "owner", targetId: "screen-1" };
  const metadata = join(directory, "computer", captureId + ".json"); const payload = join(directory, "computer", captureId + ".png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0O8AAAAASUVORK5CYII=", "base64");
  const read = async (value: unknown, reader = sender) => await handler!({ sender: reader }, value) as ComputerCaptureResult;
  try {
    await mkdir(join(directory, "computer"));
    await writeFile(metadata, JSON.stringify({ ...request, width: 1, height: 1, expiresAt: Date.now() + 30000 })); await writeFile(payload, png);
    assert.equal((await read(request, { ...sender, id: 5 })).ok, false);
    visible = false; assert.equal((await read(request)).ok, false); visible = true;
    assert.equal((await read({ ...request, sessionId: "other" })).ok, false);
    assert.deepEqual(await readFile(payload), png);
    const concurrent = await Promise.all([read(request), read(request)]);
    assert.equal(concurrent.filter(value => value.ok).length, 1);
    const delivered = concurrent.find(value => value.ok); assert.ok(delivered?.ok); assert.deepEqual(Buffer.from(delivered.data), png);
    assert.equal((await read(request)).ok, false);
    await assert.rejects(readFile(payload), { code: "ENOENT" });
    await assert.rejects(readFile(metadata), { code: "ENOENT" });
    await writeFile(metadata, JSON.stringify({ ...request, width: 4096, height: 4096, expiresAt: Date.now() + 30000 })); await writeFile(payload, png);
    assert.equal((await read(request)).ok, false, "PNG dimensions must agree with the bounded descriptor");
    assert.equal((await read({ ...request, captureId: "../" + captureId })).ok, false);
    ipc.dispose(); assert.equal((await read(request)).ok, false);
  } finally {
    ipc.dispose();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + "\\") || resolve(directory).startsWith(resolve(tmpdir()) + "/"));
    await rm(directory, { recursive: true, force: true });
  }
});
