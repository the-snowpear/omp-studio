import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyOverlay, assertForkApplied, captureOverlay, overlayFiles, overlayHash } from "./omp-overlay.mjs";

async function put(root, name, content) {
  const file = join(root, ...name.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

test("a clean git-applied seam with a new source file can build before or after staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-seam-new-file-"));
  const overlay = join(directory, "overlay"), vendor = join(directory, "vendor"), patches = join(directory, "patches");
  const git = (...args) => execFileSync("git", ["-C", vendor, ...args], { encoding: "utf8", windowsHide: true });
  try {
    await put(vendor, "existing.ts", "export const value = 1;\n");
    await put(overlay, "studio/bridge.ts", "export {};\n");
    git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture");
    await put(vendor, "existing.ts", "export const value = 2;\n");
    await put(vendor, "new-model.ts", "export type Model = string;\n");
    git("add", "-N", "new-model.ts");
    const patch = git("diff", "HEAD");
    await put(patches, "0004-studio-extensibility.patch", patch);
    git("restore", "--staged", "new-model.ts");
    git("restore", "existing.ts");
    await rm(join(vendor, "new-model.ts"));
    git("apply", join(patches, "0004-studio-extensibility.patch"));
    await applyOverlay(vendor, overlay);
    await assertForkApplied(vendor, overlay, patches);
    git("add", "existing.ts", "new-model.ts");
    await assertForkApplied(vendor, overlay, patches);
    git("restore", "--staged", "new-model.ts");
    await rm(join(vendor, "new-model.ts"));
    await assert.rejects(() => assertForkApplied(vendor, overlay, patches), /Seam patch/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
