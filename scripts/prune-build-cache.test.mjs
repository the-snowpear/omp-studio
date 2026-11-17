import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneBuildCache } from "./prune-build-cache.mjs";
import { obsoleteReleaseCaches } from "./prune-release-caches.mjs";

test("Bazel cache pruning retains recently used blobs within its byte budget", async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-bazel-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cas = join(root, "cas");
  await mkdir(cas);
  await writeFile(join(cas, "old"), "123456");
  await writeFile(join(cas, "recent"), "12345");
  await utimes(join(cas, "old"), 100, 100);
  await utimes(join(cas, "recent"), 200, 200);
  assert.equal(await pruneBuildCache(root, 8), 5);
  assert.deepEqual(await readdir(cas), ["recent"]);
});

test("release cache maintenance removes superseded/tag copies while keeping current main and unrelated CI caches", () => {
  const cache = (id, key, ref = "refs/heads/main") => ({ id, key, ref, created_at: `2026-11-${String(id).padStart(2, "0")}` });
  const rows = [
    cache(1, "v1-release-rust-natives-Darwin-x64-old"),
    cache(2, "bazel-native-v1-darwin-x64-old"),
    cache(3, "bazel-native-v1-darwin-x64-new"),
    cache(4, "npm-v1-Windows-ARM64-node24-old"),
    cache(5, "npm-v1-Windows-ARM64-node24-current"),
    cache(6, "npm-v1-Windows-ARM64-node24-tag", "refs/tags/v0.2.2"),
    cache(7, "source-tests-rust-ci"),
    cache(8, "electron-native-v1-macOS-ARM64-current"),
    cache(9, "bun-v1-Linux-X64-new", "refs/heads/topic"),
    cache(10, "desktop-tools-v1-Windows-X64-absolute-workspace-path"),
    cache(11, "desktop-tools-v2-Windows-X64-relative-workspace-path"),
  ];
  assert.deepEqual(obsoleteReleaseCaches(rows).map(row => row.id).sort((a, b) => a - b), [1, 2, 4, 6, 9, 10]);
});
