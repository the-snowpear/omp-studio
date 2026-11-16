import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertLockedElectronVersion, dependencyFingerprint, releaseWarmPlan } from "./release-cache.mjs";

test("packaging rejects a stale installed Electron instead of shipping the older dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-locked-electron-"));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/electron": { version: "43.8.8" } } }));
  const installed = join(root, "node_modules", "electron");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ version: "43.4.0" }));
  assert.throws(() => assertLockedElectronVersion(root), /Electron dependency is 43\.4\.0; package-lock requires 43\.8\.8/u);
  await writeFile(join(installed, "package.json"), JSON.stringify({ version: "43.8.8" }));
  assert.equal(assertLockedElectronVersion(root), "43.8.8");
});

const fixture = () => ({
  packages: {
    "": { version: "0.1.14" },
    "apps/desktop": { version: "0.1.14", dependencies: { electron: "^43.4.0", "@omp-studio/client": "0.1.14" } },
    "packages/client": { version: "0.1.14" },
    "node_modules/@omp-studio/client": { resolved: "packages/client", link: true },
    "node_modules/electron": { version: "43.4.0", integrity: "electron-43.4.0" },
    "node_modules/node-pty": { version: "1.1.0", integrity: "pty-1.1.0" },
  },
});

test("a Studio-only version bump keeps dependency downloads and Electron native output reusable", () => {
  const before = fixture(), after = fixture();
  after.packages[""].version = "0.1.15";
  after.packages["apps/desktop"].version = "0.1.15";
  after.packages["apps/desktop"].dependencies["@omp-studio/client"] = "0.1.15";
  after.packages["packages/client"].version = "0.1.15";
  assert.equal(dependencyFingerprint(before), dependencyFingerprint(after));
});

test("Electron, native dependency bytes and nested dependency changes invalidate native output", () => {
  const original = dependencyFingerprint(fixture());
  for (const [name, patch] of [
    ["node_modules/electron", { version: "44.0.0", integrity: "electron-44" }],
    ["node_modules/node-pty", { version: "1.1.0", integrity: "different-pty-bytes" }],
    ["apps/desktop/node_modules/node-addon-api", { version: "8.0.0", integrity: "new-native-headers" }],
  ]) {
    const changed = fixture(); changed.packages[name] = patch;
    assert.notEqual(dependencyFingerprint(changed), original);
  }
});

test("warming follows native and desktop inputs instead of every Studio change", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-release-warm-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Release test", "-c", "user.email=release-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const lockfile = fixture();
  await put("package-lock.json", JSON.stringify(lockfile));
  const baseline = commit();

  lockfile.packages[""].version = "0.1.15";
  lockfile.packages["apps/desktop"].version = "0.1.15";
  await put("package-lock.json", JSON.stringify(lockfile));
  await put("omp-patch/overlay/bridge.ts", "export const locale = 'en';");
  await put("omp-patch/patches/series.json", JSON.stringify({ patchsetVersion: "studio.2", patchsetDigest: "changed-overlay" }));
  await put("README.md", "Updated release notes");
  const studioOnly = commit();
  assert.deepEqual(releaseWarmPlan(baseline, root), { native: false, desktop: false });

  lockfile.packages["node_modules/electron"].version = "44.0.0";
  await put("package-lock.json", JSON.stringify(lockfile));
  const electronChange = commit();
  assert.deepEqual(releaseWarmPlan(studioOnly, root), { native: false, desktop: true });

  await put("omp-patch/vendor/oh-my-pi/Cargo.toml", "[workspace]\nmembers = []\n");
  const nativeChange = commit();
  assert.deepEqual(releaseWarmPlan(electronChange, root), { native: true, desktop: false });

  await put("omp-patch/patches/0001-studio-cli-entry.patch", "updated seam");
  commit();
  assert.deepEqual(releaseWarmPlan(nativeChange, root), { native: true, desktop: false });
  assert.deepEqual(releaseWarmPlan(undefined, root), { native: true, desktop: true });
});
