import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { nativeArtifactKey, nativeSourceFingerprint, nativeTargets } from "./native-artifact.mjs";

test("patched native output survives TS-only commits and invalidates on Rust, new seam files and toolchains", async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-native-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  const put = async (name, data) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), data);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Native artifact test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  };
  git("init", "-q");
  git("config", "core.autocrlf", "true");
  await put("crates/pi-natives/src/lib.rs", "pub fn sample() {}\n");
  await put("MODULE.bazel", "module(name = 'omp')\n");
  commit();
  const initial = nativeSourceFingerprint(root);
  await put("packages/coding-agent/src/studio/bridge.ts", "// new Studio bridge\n");
  commit();
  assert.equal(nativeSourceFingerprint(root), initial);
  await put("crates/pi-natives/src/lib.rs", "pub fn sample() {}\r\n");
  assert.equal(nativeSourceFingerprint(root), initial, "Windows and Linux must agree on identical native sources");

  await put("crates/pi-natives/src/lib.rs", "pub fn patched() {}\n");
  const patched = nativeSourceFingerprint(root);
  assert.notEqual(patched, initial);
  await put("crates/pi-natives/src/studio.rs", "// new, untracked seam file\n");
  const added = nativeSourceFingerprint(root);
  assert.notEqual(added, patched);
  commit();
  assert.equal(nativeSourceFingerprint(root), added, "applying and committing the same seam must agree");
  await rm(join(root, "crates/pi-natives/src/studio.rs"));
  assert.notEqual(nativeSourceFingerprint(root), added);
  await put("MODULE.bazel", "module(name = 'new-toolchain')\n");
  assert.notEqual(nativeSourceFingerprint(root), patched);
  assert.notEqual(nativeArtifactKey("win32-x64", root), nativeArtifactKey("win32-arm64", root));
  assert.deepEqual(nativeTargets("linux-x64"), ["linux-x64-baseline", "linux-x64-modern"]);
});
