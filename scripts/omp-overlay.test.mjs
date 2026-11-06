import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureOverlay, overlayFiles, overlayHash } from "./omp-overlay.mjs";

async function put(root, name, content) {
  const file = join(root, ...name.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

test("regen collects new Studio modules, prompts and tests without importing upstream-owned namespaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-overlay-discovery-"));
  const overlay = join(directory, "overlay"), vendor = join(directory, "vendor");
  const existing = "packages/coding-agent/src/studio/bridge.ts";
  const module = "packages/coding-agent/src/studio/services/computer-workspace.ts";
  const prompt = "packages/coding-agent/src/studio/services/computer-continue.md";
  const regression = "packages/coding-agent/test/studio-computer-workspace.test.ts";
  try {
    await put(overlay, existing, "export const version = 1;");
    const before = await overlayHash(overlay);
    await put(vendor, existing, "export const version = 2;");
    await put(vendor, module, "export const ready = true;");
    await put(vendor, prompt, "Continue the computer task.");
    await put(vendor, regression, "export const regression = true;");
    await put(vendor, "packages/coding-agent/src/tools/computer.ts", "upstream seam only");
    await put(vendor, "packages/coding-agent/test/tools/computer.test.ts", "upstream test");
    const result = await captureOverlay(vendor, overlay);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(await overlayFiles(overlay), [existing, module, prompt, regression].sort());
    assert.equal(await readFile(join(overlay, module), "utf8"), "export const ready = true;");
    assert.notEqual(await overlayHash(overlay), before);
    assert.deepEqual((await captureOverlay(vendor, overlay)).changed, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing vendor sources are reported without deleting the stored overlay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-overlay-missing-"));
  const overlay = join(directory, "overlay"), vendor = join(directory, "vendor");
  const file = "packages/coding-agent/src/studio/kept.ts";
  try {
    await mkdir(vendor);
    await put(overlay, file, "keep the source");
    const result = await captureOverlay(vendor, overlay);
    assert.deepEqual(result.missing, [file]);
    assert.equal(await readFile(join(overlay, file), "utf8"), "keep the source");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
