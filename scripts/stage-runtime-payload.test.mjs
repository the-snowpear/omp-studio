import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageRuntimePayload } from "./stage-runtime-payload.mjs";

test("staging a downloaded macOS Runtime restores 0755 without modifying signed bytes or the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-stage-runtime-"));
  try {
    const source = join(root, "source"), destination = join(root, "payload");
    await mkdir(source);
    await writeFile(join(source, "omp"), "signed-runtime-bytes");
    await chmod(join(source, "omp"), 0o644);
    await writeFile(join(source, "runtime-signature.json"), "signature");
    await stageRuntimePayload(source, destination, "darwin-arm64");
    assert.equal(await readFile(join(destination, "omp"), "utf8"), "signed-runtime-bytes");
    assert.equal(await readFile(join(destination, "runtime-signature.json"), "utf8"), "signature");
    if (process.platform !== "win32") {
      assert.equal((await stat(join(destination, "omp"))).mode & 0o777, 0o755);
      assert.equal((await stat(join(source, "omp"))).mode & 0o777, 0o644);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
