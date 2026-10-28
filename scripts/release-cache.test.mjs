import assert from "node:assert/strict";
import { test } from "node:test";
import { dependencyFingerprint } from "./release-cache.mjs";

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
