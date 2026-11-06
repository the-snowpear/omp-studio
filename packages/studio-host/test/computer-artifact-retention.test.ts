import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactLibrary } from "../src/artifact-library.js";

test("explicitly retained Computer evidence survives deletion of only its originating session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-computer-artifacts-"));
  const library = new ArtifactLibrary({ profileDirectory: directory });
  try {
    const [saved, temporary] = await Promise.all([
      library.registerBytes({ kind: "image", name: "saved.png", mimeType: "image/png", sessionId: "a", runId: "computer-saved" }, Uint8Array.of(1)),
      library.registerBytes({ kind: "image", name: "temporary.png", mimeType: "image/png", sessionId: "a", runId: "computer-temporary" }, Uint8Array.of(2)),
    ]);
    await library.retain(saved.artifactId);
    await library.finishSession("a", true);
    assert.equal((await library.resolve(saved.artifactId)).record.sessionId, undefined);
    await assert.rejects(library.resolve(temporary.artifactId));
    assert.equal((await library.list()).total, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an expired run cannot register a late image and leaves no staged payload behind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-computer-discard-"));
  const library = new ArtifactLibrary({ profileDirectory: directory });
  let release: () => void = () => {};
  let began: () => void = () => {};
  const started = new Promise<void>(resolve => { began = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const registration = library.register({ kind: "image", name: "late.png", mimeType: "image/png", sessionId: "a", runId: "computer-late" }, (async function* () { began(); await paused; yield Uint8Array.of(1, 2, 3); })());
  const rejected = assert.rejects(registration, /explicitly removed/);
  try {
    await started;
    await library.discardRun("computer-late");
    release(); await rejected;
    assert.equal((await library.list()).total, 0);
    const payloads = await readdir(directory, { recursive: true });
    assert.deepEqual(payloads.filter(file => file.endsWith(".partial") || file.endsWith(".png")), []);
  } finally { release(); await rejected; await rm(directory, { recursive: true, force: true }); }
});
