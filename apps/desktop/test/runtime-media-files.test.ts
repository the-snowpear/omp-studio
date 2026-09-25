import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import { RuntimeMediaFiles } from "../src/runtime-media-files.js";

test("media input grants are independent and outputs promote once without resurrection after deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-media-files-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: root }); const bridge = new RuntimeMediaFiles(library); const directory = join(root, "private");
    const image = await library.registerBytes({ kind: "image", name: "input.png", mimeType: "image/png" }, Buffer.from("test-image"));
    const one = await bridge.stage(directory, image.artifactId); const two = await bridge.stage(directory, image.artifactId);
    assert.notEqual(one.transferId, two.transferId); assert.equal(one.artifactId, image.artifactId);
    assert.equal(await readFile(join(directory, "inputs", one.transferId + ".bin"), "utf8"), "test-image");
    await bridge.releaseInputs(directory, [one]); assert.equal(await readFile(join(directory, "inputs", two.transferId + ".bin"), "utf8"), "test-image");
    const artifactId = randomUUID(); const jobId = randomUUID(); const bytes = Buffer.from("generated");
    await mkdir(join(directory, "outputs", createHash("sha256").update("s").digest("hex")), { recursive: true }); await writeFile(join(directory, "outputs", createHash("sha256").update("s").digest("hex"), artifactId + ".bin"), bytes);
    const output = { artifactId, kind: "image" as const, name: "output.png", mimeType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const [first, duplicate] = await Promise.all([bridge.promote(directory, "s", "w", jobId, output), bridge.promote(directory, "s", "w", jobId, output)]);
    assert.equal(first.artifactId, duplicate.artifactId); assert.equal((await library.list({})).total, 2);
    await library.remove(first.artifactId);
    await assert.rejects(() => bridge.promote(directory, "s", "w", jobId, output), /explicitly removed/u);
    assert.equal((await library.list({})).total, 1);
    await assert.rejects(() => bridge.stage(directory, "../../private"), /identifier/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session deletion promotes unread outputs by default and cascades private files only when selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-media-delete-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: root }), bridge = new RuntimeMediaFiles(library), directory = join(root, "private");
    for (const cascade of [false, true]) {
      const sessionId = String(cascade), key = createHash("sha256").update(sessionId).digest("hex"), jobId = randomUUID(), artifactId = randomUUID();
      const bytes = Buffer.from("private-output"), asset = { artifactId, kind: "image", name: "output.png", mimeType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const outputs = join(directory, "outputs", key), jobs = join(directory, "jobs", key);
      await mkdir(outputs, { recursive: true }); await mkdir(jobs, { recursive: true });
      await writeFile(join(outputs, artifactId + ".bin"), bytes); await writeFile(join(jobs, jobId + ".json"), JSON.stringify({ job: { id: jobId, sessionId }, outputs: [asset] }));
      await bridge.finishSession(directory, sessionId, cascade); await library.finishSession(sessionId, cascade);
      await assert.rejects(readFile(join(outputs, artifactId + ".bin")), { code: "ENOENT" });
      await assert.rejects(readFile(join(jobs, jobId + ".json")), { code: "ENOENT" });
      assert.equal(JSON.parse(await readFile(join(directory, "deleted-sessions", key + ".json"), "utf8")).cascade, cascade);
    }
    const retained = await library.list({}); assert.equal(retained.total, 1); assert.equal(retained.artifacts[0]!.sessionId, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
