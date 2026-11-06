import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFileDigests, readFileDigestsInWorker } from "../src/file-digests.js";

test("worker verification preserves complete file digests, prefixes and the final partial block", async context => {
  const directory = await mkdtemp(join(tmpdir(), "omp-file-digests-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "runtime.bin");
  const content = Buffer.from("Runtime 字节\n".repeat(180_001) + "final bytes");
  const prefixes = ["win32\0", "darwin\0", ""];
  await writeFile(file, content);
  const expected = {
    digests: prefixes.map(prefix => createHash("sha256").update(prefix).update(content).digest("hex")),
    bytes: content.length,
  };
  assert.deepEqual(await readFileDigestsInWorker(file, prefixes), expected);
  assert.deepEqual(await readFileDigests(file, prefixes), expected);
  content[content.length - 1] = content[content.length - 1]! ^ 1;
  await writeFile(file, content);
  const changed = await readFileDigestsInWorker(file, prefixes);
  assert.notDeepEqual(changed.digests, expected.digests);
  assert.equal(changed.bytes, expected.bytes);
  await rm(file); // The returned result must not leave a file handle held by the Worker.
});

test("worker read failures propagate and a later verification can still succeed", async context => {
  const directory = await mkdtemp(join(tmpdir(), "omp-file-digests-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "runtime.bin");
  await assert.rejects(readFileDigestsInWorker(file, [""]), { code: "ENOENT" });
  await writeFile(file, "");
  assert.deepEqual(await readFileDigestsInWorker(file, [""]), {
    digests: [createHash("sha256").digest("hex")], bytes: 0,
  });
});
