/**
 * Public release asset names and release-job layout, per update platform.
 * Windows names are the historical ones, byte for byte; macOS adds its own
 * without touching them. Shared by build/verify-update-assets-v2, the update
 * history collector, the release gate and the publisher.
 */
import { join } from "node:path";

import { MAC_TARGET_PLATFORM, macDmgFileName, macUpdateZipFileName } from "./mac-bundle.mjs";
import { LINUX_TARGET_PLATFORM, linuxAppImageName, linuxDebName } from "./linux-bundle.mjs";
import { runtimeOsOf, UPDATE_PLATFORMS } from "./target-platform.mjs";

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

export function resolveReleasePlatform(env = process.env, host = { platform: process.platform, arch: process.arch }) {
  const platform = `${String(env.OMP_TARGET_PLATFORM ?? host.platform).trim().toLowerCase()}-${env.OMP_TARGET_ARCH ?? host.arch}`;
  if (!UPDATE_PLATFORMS.includes(platform)) throw new Error(`Unsupported desktop release platform: ${platform}`);
  return platform;
}

/** Public labels preserve the historical Windows and macOS names. */
export function assetPlatformLabel(platform) {
  const os = runtimeOsOf(platform);
  return `${os === "darwin" ? "macos" : os === "win32" ? "windows" : "linux"}-${archOf(platform)}`;
}

export function runtimeArchiveAssetName(runtimeVersion, platform) {
  return `OMP-Studio-Runtime-${runtimeVersion}-${assetPlatformLabel(platform)}.zip`;
}

/** The desktop artifact the update catalog points at: the NSIS Setup, or the macOS update zip. */
export function appUpdateAssetName(appVersion, platform) {
  if (!UPDATE_PLATFORMS.includes(platform)) throw new Error(`Unsupported desktop release platform: ${platform}`);
  if (platform === LINUX_TARGET_PLATFORM) return linuxAppImageName(appVersion);
  return runtimeOsOf(platform) === "darwin" ? macUpdateZipFileName(appVersion) : `OMP-Studio-Setup-${appVersion}-windows-${archOf(platform)}.exe`;
}

function installerDirectory(platform) {
  const os = runtimeOsOf(platform);
  return os === "darwin" ? "installer-mac" : os === "linux" ? "installer-linux" : "installer";
}

/** Where the native pack command leaves the artifact. */
export function packagedAppAssetPath(root, appVersion, platform) {
  return join(root, "outputs", installerDirectory(platform), appUpdateAssetName(appVersion, platform));
}

/**
 * A first-install download published beside the catalog but not updated
 * through it: the macOS dmg. On Windows the catalog's Setup serves both.
 */
export function firstInstallAssetName(appVersion, platform) {
  if (platform === LINUX_TARGET_PLATFORM) return linuxDebName(appVersion);
  return runtimeOsOf(platform) === "darwin" ? macDmgFileName(appVersion) : undefined;
}

export function packagedFirstInstallPath(root, appVersion, platform) {
  const name = firstInstallAssetName(appVersion, platform);
  return name === undefined ? undefined : join(root, "outputs", installerDirectory(platform), name);
}

/** The v1 migration feed only ever existed for Windows. */
export function legacyIndexName(platform) {
  if (platform === "win32-x64") return "update-index";
  if (platform === "win32-arm64") return "update-index-win32-arm64";
  return undefined;
}

/** outputs/release/<arch> for Windows (unchanged), outputs/release/darwin-arm64 for macOS. */
export function releaseOutputDirectory(root, platform) {
  return join(root, "outputs", "release", runtimeOsOf(platform) === "win32" ? archOf(platform) : platform);
}

/** The workflow artifact carrying one platform's candidate to the publish job. */
export function releaseCandidateName(platform) {
  return `release-candidate-${runtimeOsOf(platform) === "win32" ? archOf(platform) : platform}`;
}

/** Inverse of releaseCandidateName; undefined for anything else. */
export function platformOfReleaseCandidate(directoryName) {
  const match = /^release-candidate-(x64|arm64|darwin-arm64|linux-x64)$/u.exec(directoryName);
  if (!match) return undefined;
  return match[1].includes("-") ? match[1] : `win32-${match[1]}`;
}

function* releaseNoteAssetNames(notes, repo, tag) {
  for (const match of notes.matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/releases\/download\/([^/\s]+)\/([^\s)<>]+)/gu)) {
    if (match[1] === repo && match[2] === tag) yield match[3];
  }
}

/** Reject unselected desktop downloads before any expensive native builds. */
export function assertReleaseNotePlatforms(notes, repo, tag, appVersion, platforms) {
  const selected = new Set(platforms);
  const unavailable = new Set(UPDATE_PLATFORMS.filter(platform => !selected.has(platform)).flatMap(platform => {
    const update = appUpdateAssetName(appVersion, platform);
    return [update, `${update}.blockmap`, firstInstallAssetName(appVersion, platform)].filter(Boolean);
  }));
  for (const name of releaseNoteAssetNames(notes, repo, tag)) {
    if (unavailable.has(name)) throw new Error(`Release notes advertise an unselected desktop asset: ${name}. Select every documented platform before starting the release.`);
  }
}

/** Curated download links may only advertise files present in this release. */
export function assertReleaseNoteAssets(notes, repo, tag, assets) {
  const names = new Set(assets);
  for (const name of releaseNoteAssetNames(notes, repo, tag)) {
    if (!names.has(name)) throw new Error(`Release notes advertise an unavailable asset: ${name}`);
  }
}
