import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  appUpdateAssetName,
  assertReleaseNoteAssets,
  assertReleaseNotePlatforms,
  firstInstallAssetName,
  legacyIndexName,
  packagedAppAssetPath,
  platformOfReleaseCandidate,
  releaseCandidateName,
  releaseOutputDirectory,
  releaseTargetsDarwin,
  resolveReleasePlatform,
  runtimeArchiveAssetName,
} from "./release-assets.mjs";

test("curated release notes cannot advertise an unbuilt platform", () => {
  const note = "[Mac](https://github.com/owner/repo/releases/download/v0.1.10/OMP-Studio-0.1.10-macos-arm64.dmg)";
  assert.throws(() => assertReleaseNoteAssets(note, "owner/repo", "v0.1.10", ["windows.exe"]), /unavailable asset/u);
  assert.doesNotThrow(() => assertReleaseNoteAssets(note, "owner/repo", "v0.1.10", ["OMP-Studio-0.1.10-macos-arm64.dmg"]));
  assert.doesNotThrow(() => assertReleaseNoteAssets(note, "owner/repo", "v0.1.11", []));
});

test("release preparation rejects incomplete platforms advertised by curated notes", () => {
  const repo = "owner/repo", tag = "v0.2.0", version = "0.2.0";
  const notes = [
    "https://github.com/owner/repo/releases/download/v0.2.0/OMP-Studio-Setup-0.2.0-windows-x64.exe",
    "https://github.com/owner/repo/releases/download/v0.2.0/OMP-Studio-Setup-0.2.0-windows-arm64.exe",
    "https://github.com/owner/repo/releases/download/v0.2.0/OMP-Studio-0.2.0-macos-arm64.dmg",
  ].join("\n");
  assert.throws(() => assertReleaseNotePlatforms(notes, repo, tag, version, ["win32-x64"]), /unselected desktop asset: .*windows-arm64\.exe/u);
  assert.throws(() => assertReleaseNotePlatforms(notes, repo, tag, version, ["win32-x64", "win32-arm64"]), /unselected desktop asset: .*macos-arm64\.dmg/u);
  assert.doesNotThrow(() => assertReleaseNotePlatforms(notes, repo, tag, version, ["win32-x64", "win32-arm64", "darwin-arm64"]));
});

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
  assert.equal(platformOfReleaseCandidate("release-candidate-linux-arm64"), undefined);
});

test("Linux uses its own signed AppImage/deb candidate and never Windows names", () => {
  assert.equal(runtimeArchiveAssetName("18.19.0-studio.1", "linux-x64"), "OMP-Studio-Runtime-18.19.0-studio.1-linux-x64.zip");
  assert.equal(appUpdateAssetName("0.2.2", "linux-x64"), "OMP-Studio-0.2.2-linux-x64.AppImage");
  assert.equal(firstInstallAssetName("0.2.2", "linux-x64"), "OMP-Studio-0.2.2-linux-x64.deb");
  assert.equal(packagedAppAssetPath("/r", "0.2.2", "linux-x64"), join("/r", "outputs/installer-linux/OMP-Studio-0.2.2-linux-x64.AppImage"));
  assert.equal(releaseOutputDirectory("/r", "linux-x64"), join("/r", "outputs/release/linux-x64"));
  assert.equal(platformOfReleaseCandidate(releaseCandidateName("linux-x64")), "linux-x64");
  assert.equal(legacyIndexName("linux-x64"), undefined);
  assert.equal(resolveReleasePlatform({}, { platform: "linux", arch: "x64" }), "linux-x64");
  assert.equal(resolveReleasePlatform({ OMP_TARGET_PLATFORM: "win32", OMP_TARGET_ARCH: "arm64" }, { platform: "linux", arch: "x64" }), "win32-arm64");
  assert.throws(() => appUpdateAssetName("0.2.2", "linux-arm64"), /Unsupported desktop/u);
});

test("a release job targets macOS when asked, or on a Mac by default", () => {
  assert.equal(releaseTargetsDarwin({ OMP_TARGET_PLATFORM: "darwin" }, "linux"), true);
  assert.equal(releaseTargetsDarwin({}, "darwin"), true);
  assert.equal(releaseTargetsDarwin({ OMP_TARGET_PLATFORM: "win32" }, "darwin"), false);
  assert.equal(releaseTargetsDarwin({}, "win32"), false);
  assert.equal(releaseTargetsDarwin({ OMP_TARGET_ARCH: "arm64" }, "win32"), false);
});
