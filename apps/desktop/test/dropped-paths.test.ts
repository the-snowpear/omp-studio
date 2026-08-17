import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveDroppedPath } from "../src/dropped-paths.js";

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-drop-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "export {}\n");
  await writeFile(join(root, "logo.png"), "png");
  return root;
}

describe("resolveDroppedPath", () => {
  test("maps files and folders inside the workspace to relative paths", async () => {
    const root = await makeWorkspace();
    const file = await resolveDroppedPath(root, join(root, "src", "a.ts"));
    assert.deepEqual(file, { ok: true, kind: "file", scope: "workspace", path: "src/a.ts", name: "a.ts" });
    const dir = await resolveDroppedPath(root, join(root, "src"));
    assert.deepEqual(dir, { ok: true, kind: "dir", scope: "workspace", path: "src", name: "src" });
    const image = await resolveDroppedPath(root, join(root, "logo.png"));
    assert.deepEqual(image, { ok: true, kind: "image", scope: "workspace", path: "logo.png", name: "logo.png" });
  });

  test("keeps the absolute path for files outside the workspace", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "omp-drop-out-"));
    await writeFile(join(outside, "notes.ts"), "export {}\n");
    const canonical = await realpath(join(outside, "notes.ts"));
    const result = await resolveDroppedPath(root, join(outside, "notes.ts"));
    assert.deepEqual(result, {
      ok: true,
      kind: "file",
      scope: "absolute",
      path: canonical.replaceAll("\\", "/"),
      name: "notes.ts",
    });
  });

  test("keeps the absolute path for folders outside the workspace", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "omp-drop-out-dir-"));
    await mkdir(join(outside, "assets"));
    const canonical = await realpath(join(outside, "assets"));
    const result = await resolveDroppedPath(root, join(outside, "assets"));
    assert.deepEqual(result, {
      ok: true,
      kind: "dir",
      scope: "absolute",
      path: canonical.replaceAll("\\", "/"),
      name: "assets",
    });
  });

  test("rejects missing paths", async () => {
    const root = await makeWorkspace();
    const result = await resolveDroppedPath(root, join(root, "nope.ts"));
    assert.deepEqual(result, { ok: false, reason: "missing" });
  });
});
