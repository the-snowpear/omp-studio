import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePlan } from "./release-plan.mjs";

test("a desktop release prepares each SSH platform once while respecting the selected Windows installer", () => {
  const plan = releasePlan({ arch: "arm64" });
  assert.deepEqual(plan.matrix.include, [{ arch: "arm64", os: "windows-11-arm" }]);
  assert.equal(plan.runtime_matrix.include.length, 6);
  assert.equal(new Set(plan.runtime_matrix.include.map(row => row.target)).size, 6);
});

test("Runtime-only releases prepare only the requested native platforms", () => {
  assert.deepEqual(releasePlan({ kind: "runtime", arch: "x64", includeLinux: false }).runtime_matrix.include.map(row => row.target), ["win32-x64"]);
  assert.deepEqual(releasePlan({ kind: "runtime", includeMacos: true }).runtime_matrix.include.map(row => row.target), ["win32-x64", "win32-arm64", "linux-x64", "darwin-arm64"]);
});

test("Linux ships with desktop releases by default, independently of Windows architecture", () => {
  const plan = releasePlan({ arch: "arm64", includeMacos: true });
  assert.deepEqual(plan.linux_matrix.include, [{ target: "linux-x64", os: "ubuntu-24.04", arch: "x64" }]);
  assert.equal(plan.desktop_platforms, "win32-arm64,darwin-arm64,linux-x64");
  assert.deepEqual(releasePlan({ includeLinux: false }).linux_matrix.include, []);
});

test("cache warming can select one platform without building the other five", () => {
  assert.deepEqual(releasePlan({ platforms: "linux-arm64" }).runtime_matrix.include, [{ target: "linux-arm64", os: "ubuntu-24.04-arm" }]);
});
