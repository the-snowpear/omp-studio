import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import { MediaUploadManager } from "../src/media-upload.js";
test("private uploads enforce owner, chunk order and cancellation without publishing partial artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-upload-")); const library = new ArtifactLibrary({ profileDirectory: root }); const uploads = new MediaUploadManager(() => library);
  try {
    const { uploadId } = uploads.begin(1, { kind: "audio", mimeType: "audio/wav", name: "recording.wav", sessionId: "s" });
    await assert.rejects(() => uploads.chunk(2, { uploadId, sequence: 0, bytes: new Uint8Array([1]).buffer }), /window/u);
    await assert.rejects(() => uploads.chunk(1, { uploadId, sequence: 1, bytes: new Uint8Array([1]).buffer }), /order/u);
    await uploads.chunk(1, { uploadId, sequence: 0, bytes: new Uint8Array([1, 2, 3]).buffer });
    await uploads.chunk(1, { uploadId, sequence: 1, bytes: new Uint8Array([4, 5]).buffer });
    const saved = await uploads.finish(1, uploadId); assert.equal(saved.bytes, 5); assert.equal(saved.sessionId, "s");
    assert.deepEqual(await readFile((await library.resolve(saved.artifactId)).path), Buffer.from([1, 2, 3, 4, 5]));
    const cancelled = uploads.begin(1, { kind: "audio", mimeType: "audio/wav", name: "cancelled.wav" });
    await uploads.chunk(1, { uploadId: cancelled.uploadId, sequence: 0, bytes: new Uint8Array([6]).buffer });
    uploads.abort(1, cancelled.uploadId);
    await assert.rejects(() => uploads.finish(1, cancelled.uploadId), /unavailable/u);
    assert.equal((await library.list({})).total, 1);
  } finally { uploads.dispose(); await new Promise(resolve => setImmediate(resolve)); await rm(root, { recursive: true, force: true }); }
});
