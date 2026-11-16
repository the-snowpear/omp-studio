import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReleaseAvailable, releasePlan } from "./release-plan.mjs";

test("desktop releases always include both Windows architectures, macOS and Linux", () => {
  const plan = releasePlan({ arch: "arm64", includeMacos: false, includeLinux: false });
  assert.deepEqual(plan.matrix.include, [{ arch: "x64", os: "windows-latest" }, { arch: "arm64", os: "windows-11-arm" }]);
  assert.equal(plan.desktop_platforms, "win32-x64,win32-arm64,darwin-arm64,linux-x64");
  assert.deepEqual(plan.linux_matrix.include, [{ target: "linux-x64", os: "ubuntu-24.04", arch: "x64" }]);
  assert.equal(plan.runtime_matrix.include.length, 6);
  assert.equal(new Set(plan.runtime_matrix.include.map(row => row.target)).size, 6);
});

test("Runtime-only releases prepare only the requested native platforms", () => {
  assert.deepEqual(releasePlan({ kind: "runtime", arch: "x64", includeLinux: false }).runtime_matrix.include.map(row => row.target), ["win32-x64"]);
  assert.deepEqual(releasePlan({ kind: "runtime", includeMacos: true }).runtime_matrix.include.map(row => row.target), ["win32-x64", "win32-arm64", "linux-x64", "darwin-arm64"]);
});

test("Runtime-only releases can select Linux and macOS independently", () => {
  const plan = releasePlan({ kind: "runtime", arch: "arm64", includeMacos: true });
  assert.deepEqual(plan.linux_matrix.include, [{ target: "linux-x64", os: "ubuntu-24.04", arch: "x64" }]);
  assert.equal(plan.desktop_platforms, "win32-arm64,darwin-arm64,linux-x64");
  assert.deepEqual(releasePlan({ kind: "runtime", includeLinux: false }).linux_matrix.include, []);
});

test("cache warming can select one platform without building the other five", () => {
  assert.deepEqual(releasePlan({ platforms: "linux-arm64" }).runtime_matrix.include, [{ target: "linux-arm64", os: "ubuntu-24.04-arm" }]);
});

test("published desktop and Runtime tags stop before native release jobs start", async () => {
  const readApi = async () => JSON.stringify([[{ tag_name: "v0.2.1", draft: false }, { tag_name: "runtime-v18.19.0-studio.12", draft: false }]]);
  await assert.rejects(checkReleaseAvailable({ kind: "desktop", version: "0.2.1", repo: "owner/studio" }, readApi), /published release v0\.2\.1/u);
  await assert.rejects(checkReleaseAvailable({ kind: "runtime", refType: "tag", refName: "runtime-v18.19.0-studio.12", repo: "owner/studio" }, readApi), /published release runtime-v/u);
});

test("a new release or an unfinished draft can still be prepared", async () => {
  const readApi = async () => JSON.stringify([[{ tag_name: "v0.2.1", draft: false }, { tag_name: "v0.2.2", draft: true }]]);
  await checkReleaseAvailable({ kind: "desktop", version: "0.2.2", repo: "owner/studio" }, readApi);
  await checkReleaseAvailable({ kind: "desktop", version: "0.2.3", repo: "owner/studio" }, readApi);
});

test("desktop tag and channel mistakes stop before looking up release history", async () => {
  const readApi = async () => assert.fail("No GitHub request is needed for an invalid desktop release");
  await assert.rejects(checkReleaseAvailable({ kind: "desktop", version: "0.2.2", refType: "tag", refName: "v0.2.1" }, readApi), /tag mismatch/u);
  await assert.rejects(checkReleaseAvailable({ kind: "desktop", version: "0.2.2", channel: "canary" }, readApi), /must be stable/u);
});
