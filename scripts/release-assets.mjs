/**
 * Public release asset names and release-job layout, per update platform.
 * Windows names are the historical ones, byte for byte; macOS adds its own
 * without touching them. Shared by build/verify-update-assets-v2, the update
 * history collector, the release gate and the publisher.
 */
import { join } from "node:path";

import { MAC_TARGET_PLATFORM, macDmgFileName, macUpdateZipFileName } from "./mac-bundle.mjs";
import { runtimeOsOf } from "./target-platform.mjs";

export { MAC_TARGET_PLATFORM };

function archOf(platform) {
  return platform.slice(platform.indexOf("-") + 1);
}

/**
 * A release job builds macOS when it asks for it (OMP_TARGET_PLATFORM=darwin)
 * or runs on a Mac without saying otherwise; Windows otherwise, as before.
 */
export function releaseTargetsDarwin(env = process.env, hostPlatform = process.platform) {
  const requested = String(env.OMP_TARGET_PLATFORM ?? "").trim().toLowerCase();
  return requested === "darwin" || (requested === "" && hostPlatform === "darwin");
}

/** "windows-x64", "windows-arm64", "macos-arm64". */
export function assetPlatformLabel(platform) {
  return `${runtimeOsOf(platform) === "darwin" ? "macos" : "windows"}-${archOf(platform)}`;
}

export function runtimeArchiveAssetName(runtimeVersion, platform) {
  return `OMP-Studio-Runtime-${runtimeVersion}-${assetPlatformLabel(platform)}.zip`;
}

/** The desktop artifact the update catalog points at: the NSIS Setup, or the macOS update zip. */
export function appUpdateAssetName(appVersion, platform) {
  return runtimeOsOf(platform) === "darwin" ? macUpdateZipFileName(appVersion) : `OMP-Studio-Setup-${appVersion}-windows-${archOf(platform)}.exe`;
}

/** Where pack:win / pack:mac leave that artifact. */
export function packagedAppAssetPath(root, appVersion, platform) {
  return runtimeOsOf(platform) === "darwin"
    ? join(root, "outputs", "installer-mac", appUpdateAssetName(appVersion, platform))
    : join(root, "outputs", "installer", appUpdateAssetName(appVersion, platform));
}

/**
 * A first-install download published beside the catalog but not updated
 * through it: the macOS dmg. On Windows the catalog's Setup serves both.
 */
export function firstInstallAssetName(appVersion, platform) {
  return runtimeOsOf(platform) === "darwin" ? macDmgFileName(appVersion) : undefined;
}

export function packagedFirstInstallPath(root, appVersion, platform) {
  const name = firstInstallAssetName(appVersion, platform);
  return name === undefined ? undefined : join(root, "outputs", "installer-mac", name);
}

/** The v1 migration feed only ever existed for Windows. */
export function legacyIndexName(platform) {
  if (platform === "win32-x64") return "update-index";
  if (platform === "win32-arm64") return "update-index-win32-arm64";
  return undefined;
}

/** outputs/release/<arch> for Windows (unchanged), outputs/release/darwin-arm64 for macOS. */
export function releaseOutputDirectory(root, platform) {
  return join(root, "outputs", "release", runtimeOsOf(platform) === "darwin" ? platform : archOf(platform));
}

/** The workflow artifact carrying one platform's candidate to the publish job. */
export function releaseCandidateName(platform) {
  return `release-candidate-${runtimeOsOf(platform) === "darwin" ? platform : archOf(platform)}`;
}

/** Inverse of releaseCandidateName; undefined for anything else. */
export function platformOfReleaseCandidate(directoryName) {
  const match = /^release-candidate-(x64|arm64|darwin-arm64)$/u.exec(directoryName);
  if (!match) return undefined;
  return match[1] === "darwin-arm64" ? MAC_TARGET_PLATFORM : `win32-${match[1]}`;
}
