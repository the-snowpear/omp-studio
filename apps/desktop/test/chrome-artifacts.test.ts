import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import { artifactResponse } from "../src/chrome-artifacts.js";

test("private artifact media streams handle ranges, HEAD, and invalid identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-artifact-http-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: directory });
    const row = await library.registerBytes({ kind: "audio", name: "audio.wav", mimeType: "audio/wav" }, Buffer.from("0123456789"));
    const url = "omp-artifact://library/" + row.artifactId;
    const allowed = await artifactResponse(new Request(url, { headers: { Origin: "null" } }), library, "null");
    assert.equal(allowed.headers.get("access-control-allow-origin"), "null"); await allowed.body?.cancel();
    assert.equal((await artifactResponse(new Request(url, { headers: { Origin: "https://untrusted.example" } }), library, "null")).status, 403);
    const range = await artifactResponse(new Request(url, { headers: { Range: "bytes=2-5" } }), library);
    assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await range.text(), "2345");
    const suffix = await artifactResponse(new Request(url, { headers: { Range: "bytes=-3" } }), library);
    assert.equal(await suffix.text(), "789");
    const head = await artifactResponse(new Request(url, { method: "HEAD" }), library);
    assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
    assert.equal((await artifactResponse(new Request(url, { headers: { Range: "bytes=10-" } }), library)).status, 416);
    assert.equal((await artifactResponse(new Request(url + "?path=other"), library)).status, 400);
    assert.equal((await artifactResponse(new Request("omp-artifact://library/invalid"), library)).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
