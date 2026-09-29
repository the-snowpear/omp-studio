import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  appUpdateAssetName,
  firstInstallAssetName,
  legacyIndexName,
  packagedAppAssetPath,
  platformOfReleaseCandidate,
  releaseCandidateName,
  releaseOutputDirectory,
  releaseTargetsDarwin,
  runtimeArchiveAssetName,
} from "./release-assets.mjs";

test("Windows release names and layout stay exactly as published before", () => {
  for (const arch of ["x64", "arm64"]) {
    const platform = `win32-${arch}`;
    assert.equal(runtimeArchiveAssetName("18.2.5-studio.13", platform), `OMP-Studio-Runtime-18.2.5-studio.13-windows-${arch}.zip`);
    assert.equal(appUpdateAssetName("0.2.0", platform), `OMP-Studio-Setup-0.2.0-windows-${arch}.exe`);
    assert.equal(packagedAppAssetPath("/r", "0.2.0", platform), join("/r", "outputs", "installer", `OMP-Studio-Setup-0.2.0-windows-${arch}.exe`));
    assert.equal(firstInstallAssetName("0.2.0", platform), undefined);
    assert.equal(releaseOutputDirectory("/r", platform), join("/r", "outputs", "release", arch));
    assert.equal(releaseCandidateName(platform), `release-candidate-${arch}`);
    assert.equal(platformOfReleaseCandidate(`release-candidate-${arch}`), platform);
  }
  assert.equal(legacyIndexName("win32-x64"), "update-index");
  assert.equal(legacyIndexName("win32-arm64"), "update-index-win32-arm64");
});

test("macOS release names: update zip, first-install dmg, no v1 index", () => {
  const platform = "darwin-arm64";
  assert.equal(runtimeArchiveAssetName("18.2.5-studio.13", platform), "OMP-Studio-Runtime-18.2.5-studio.13-macos-arm64.zip");
  assert.equal(appUpdateAssetName("0.2.0", platform), "OMP-Studio-0.2.0-macos-arm64.zip");
  assert.equal(packagedAppAssetPath("/r", "0.2.0", platform), join("/r", "outputs", "installer-mac", "OMP-Studio-0.2.0-macos-arm64.zip"));
  assert.equal(firstInstallAssetName("0.2.0", platform), "OMP-Studio-0.2.0-macos-arm64.dmg");
  assert.equal(legacyIndexName(platform), undefined);
  assert.equal(releaseOutputDirectory("/r", platform), join("/r", "outputs", "release", "darwin-arm64"), "never collides with win32-arm64");
  assert.equal(releaseCandidateName(platform), "release-candidate-darwin-arm64");
  assert.equal(platformOfReleaseCandidate("release-candidate-darwin-arm64"), platform);
  assert.equal(platformOfReleaseCandidate("release-candidate-darwin-x64"), undefined);
  assert.equal(platformOfReleaseCandidate("release-candidate-linux-x64"), undefined);
});

test("a release job targets macOS when asked, or on a Mac by default", () => {
  assert.equal(releaseTargetsDarwin({ OMP_TARGET_PLATFORM: "darwin" }, "linux"), true);
  assert.equal(releaseTargetsDarwin({}, "darwin"), true);
  assert.equal(releaseTargetsDarwin({ OMP_TARGET_PLATFORM: "win32" }, "darwin"), false);
  assert.equal(releaseTargetsDarwin({}, "win32"), false);
  assert.equal(releaseTargetsDarwin({ OMP_TARGET_ARCH: "arm64" }, "win32"), false);
});
