import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { bundleRemoteHost, copyRemoteHostBundle } from "./bundle-remote-host.mjs";

test("the shipped remote archive Worker can read an archive without source packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-worker-bundle-")), output = join(root, "bundle"), sessionsRoot = join(root, "sessions");
  await bundleRemoteHost(output); await mkdir(sessionsRoot);
  const manifest = JSON.parse(await readFile(join(output, "host.json"), "utf8"));
  const artifact = manifest.files[0];
  assert.ok((await readFile(join(output, "host.mjs"), "utf8")).includes(artifact.name));
  await writeFile(join(sessionsRoot, "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "test", cwd: root }) + "\n" + JSON.stringify({ type: "message", id: "message", parentId: null, message: { role: "user", content: "standalone worker" } }) + "\n");
  const packaged = join(root, "signed-environment-payload");
  await copyRemoteHostBundle(output, packaged);
  const worker = new Worker(join(packaged, artifact.name), { workerData: { sessionsRoot, archiveRoot: join(root, "archive"), cursorSecret: Buffer.alloc(32, 1) } });
  try {
    const response = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    worker.postMessage({ id: 1, cwd: root, method: "readPage", args: [{ sessionId: "test" }] });
    const reply = await response;
    assert.equal(reply.error, undefined); assert.equal(reply.value.sessionId, "test"); assert.equal(reply.value.items.length, 1);
  } finally { await worker.terminate(); }
});
