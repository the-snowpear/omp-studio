/**
 * macOS (darwin-arm64) packaging policy, shared by pack-mac, audit-mac and
 * their tests.
 *
 * The electron-builder configuration is derived in code from
 * packaging/electron-builder.yml instead of living in a second file: the
 * Windows packaging input stays byte-for-byte unchanged, and the settings both
 * platforms share (appId, files, asar unpacking, extra resources) cannot drift.
 *
 * Signing is ad hoc (`codesign --sign -`) until a Developer ID is configured.
 * pack-mac signs through `macSignOptions` rather than electron-builder's own
 * identity lookup, which matches the qualifier "-" as a substring of the
 * keychain's identity names and could pick a real certificate on a developer
 * machine.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

export const MAC_TARGET_PLATFORM = "darwin-arm64";
export const MAC_ARCH = "arm64";
export const MAC_APP_ID = "com.ompstudio.desktop";
export const MAC_PRODUCT_NAME = "OMP Studio";
export const MAC_APP_BUNDLE = `${MAC_PRODUCT_NAME}.app`;
export const MAC_EXECUTABLE = MAC_PRODUCT_NAME;
/** Electron 44 drops macOS 12; CI can only exercise 15 and later. */
export const MAC_MINIMUM_SYSTEM_VERSION = "13.0";
export const MAC_CATEGORY = "public.app-category.developer-tools";
export const ADHOC_IDENTITY = "-";
/** electron-builder's unpacked app directory for an arm64 build, relative to the output directory. */
export const MAC_UNPACKED_DIRECTORY = "mac-arm64";

export function macArtifactBaseName(version) {
  return `OMP-Studio-${version}-macos-${MAC_ARCH}`;
}

/** First install: drag to /Applications. Not part of the update catalog. */
export function macDmgFileName(version) {
  return `${macArtifactBaseName(version)}.dmg`;
}

/** Update payload: the signed .app, zipped by ditto so symlinks and signature xattrs survive. */
export function macUpdateZipFileName(version) {
  return `${macArtifactBaseName(version)}.zip`;
}

/**
 * Purpose strings for macOS privacy prompts. Capturing audio without
 * NSMicrophoneUsageDescription gets the app killed by TCC; the rest cover what
 * the Runtime and its tools reach on the user's behalf, and TCC attributes
 * those requests to this app.
 */
export const MAC_USAGE_DESCRIPTIONS = Object.freeze({
  NSMicrophoneUsageDescription: "OMP Studio uses the microphone for voice input and Live conversations.",
  NSLocalNetworkUsageDescription: "OMP Studio connects to development servers and tools on your local network.",
  NSAppleEventsUsageDescription: "The OMP agent can control other apps when you ask it to automate a task.",
  NSDocumentsFolderUsageDescription: "OMP Studio reads and edits the projects you open from your Documents folder.",
  NSDesktopFolderUsageDescription: "OMP Studio reads and edits the projects you open from your Desktop folder.",
  NSDownloadsFolderUsageDescription: "OMP Studio reads and edits the projects you open from your Downloads folder.",
  NSRemovableVolumesUsageDescription: "OMP Studio reads and edits the projects you open from removable volumes.",
  NSNetworkVolumesUsageDescription: "OMP Studio reads and edits the projects you open from network volumes.",
});

/** Simplified Chinese prompts (zh_CN.lproj/InfoPlist.strings); same keys as MAC_USAGE_DESCRIPTIONS. */
export const MAC_USAGE_DESCRIPTIONS_ZH = Object.freeze({
  NSMicrophoneUsageDescription: "OMP Studio 使用麦克风进行语音输入和 Live 对话。",
  NSLocalNetworkUsageDescription: "OMP Studio 需要连接本地网络中的开发服务器和工具。",
  NSAppleEventsUsageDescription: "当你让 OMP 智能体自动化某项任务时，它可以控制其他应用。",
  NSDocumentsFolderUsageDescription: "OMP Studio 需要读取和编辑你从“文稿”文件夹打开的项目。",
  NSDesktopFolderUsageDescription: "OMP Studio 需要读取和编辑你从“桌面”文件夹打开的项目。",
  NSDownloadsFolderUsageDescription: "OMP Studio 需要读取和编辑你从“下载”文件夹打开的项目。",
  NSRemovableVolumesUsageDescription: "OMP Studio 需要读取和编辑你从可移除宗卷打开的项目。",
  NSNetworkVolumesUsageDescription: "OMP Studio 需要读取和编辑你从网络宗卷打开的项目。",
});

function stringsLiteral(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}

/** UTF-8 `.strings` text; CFBundle reads UTF-8 string tables. */
export function infoPlistStrings(table) {
  return `${Object.entries(table).map(([key, value]) => `${stringsLiteral(key)} = ${stringsLiteral(value)};`).join("\n")}\n`;
}

/** Windows-only native payloads that must not ride along in the macOS bundle. */
export const MAC_FILE_EXCLUSIONS = Object.freeze([
  "!**/node-pty/prebuilds/win32-*/**",
  "!**/node-pty/prebuilds/darwin-x64/**",
  "!**/node-pty/third_party/**",
  "!**/node-pty/deps/**",
  "!**/*.pdb",
]);

const WINDOWS_ONLY_KEYS = Object.freeze(["win", "nsis", "extraFiles", "artifactName", "publish", "forceCodeSigning"]);

function isWindowsIcon(pattern) {
  const from = typeof pattern === "string" ? pattern : pattern?.from;
  return typeof from === "string" && from.toLowerCase().endsWith(".ico");
}

/**
 * @param {Record<string, any>} base   parsed packaging/electron-builder.yml
 * @param {{ outputDirectory: string, iconPath: string, localizedResourcesDirectory: string, sign: unknown }} options
 */
export function deriveMacBuilderConfig(base, options) {
  if (!Array.isArray(base.extraFiles) || base.extraFiles.length === 0) {
    throw new Error("electron-builder.yml no longer lists the Runtime payload under extraFiles; update deriveMacBuilderConfig");
  }
  const shared = Object.fromEntries(Object.entries(base).filter(([key]) => !WINDOWS_ONLY_KEYS.includes(key)));
  const artifactName = "OMP-Studio-${version}-macos-${arch}.${ext}";
  return {
    ...shared,
    directories: { ...base.directories, output: options.outputDirectory },
    files: [...base.files, ...MAC_FILE_EXCLUSIONS],
    asarUnpack: base.asarUnpack.filter((pattern) => !isWindowsIcon(pattern)),
    extraResources: [
      ...base.extraResources.filter((entry) => !isWindowsIcon(entry)),
      // Windows ships the Runtime and its keys next to the exe. Inside a bundle
      // they may only live under Contents/Resources: anything else in Contents/
      // is unsealed and breaks the signature.
      ...base.extraFiles,
      { from: "apps/desktop/resources-darwin", to: "darwin", filter: ["trayTemplate.png", "trayTemplate@2x.png"] },
      { from: join(options.localizedResourcesDirectory, "zh_CN.lproj"), to: "zh_CN.lproj", filter: ["InfoPlist.strings"] },
    ],
    mac: {
      target: [{ target: "dmg", arch: [MAC_ARCH] }],
      icon: options.iconPath,
      category: MAC_CATEGORY,
      minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      artifactName,
      identity: ADHOC_IDENTITY,
      sign: options.sign,
      // Library validation rejects ad hoc frameworks, so the hardened runtime
      // waits for the Developer ID signature.
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
      extendInfo: { ...MAC_USAGE_DESCRIPTIONS },
    },
    dmg: {
      sign: false,
      writeUpdateInfo: false,
      artifactName,
    },
    // Updates come from the signed v2 catalogs; no app-update.yml in the bundle.
    publish: null,
  };
}

/**
 * Everything under Contents/Resources/runtime is the signed Runtime payload.
 * Its `omp` already carries its own signature and entitlements, and its bytes
 * are covered by checksums.json and the Ed25519 signature: re-signing it would
 * both drop the entitlements and break verification.
 */
export const RUNTIME_SIGN_IGNORE = /\/Contents\/Resources\/runtime\//u;

/**
 * @electron/osx-sign options. `hardenedRuntime` stays false for ad hoc
 * signatures; the Developer ID milestone flips it together with the identity.
 * An ad hoc signature cannot carry a secure timestamp, so it asks for none
 * instead of contacting Apple's timestamp service.
 */
export function macSignOptions({ app, version, identity = ADHOC_IDENTITY, entitlements, entitlementsInherit, hardenedRuntime = false }) {
  const timestamp = identity === ADHOC_IDENTITY ? { timestamp: "none" } : {};
  return {
    app,
    identity,
    identityValidation: false,
    platform: "darwin",
    type: "distribution",
    ...(version === undefined ? {} : { version }),
    preAutoEntitlements: false,
    strictVerify: true,
    ignore: (file) => RUNTIME_SIGN_IGNORE.test(file.replaceAll("\\", "/")),
    optionsForFile: (file) => ({
      hardenedRuntime,
      entitlements: file === app ? entitlements : entitlementsInherit,
      ...timestamp,
    }),
  };
}

/** `iconutil` input: every size macOS picks from, rendered from the 1024 px product icon. */
export const MAC_ICONSET = Object.freeze([
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]);

/**
 * electron-builder's own dependencies (js-yaml, plist, @electron/osx-sign),
 * resolved from app-builder-lib so the scripts parse and sign exactly as the
 * builder does, however npm hoists them.
 */
export const requireFromAppBuilder = createRequire(createRequire(import.meta.url).resolve("app-builder-lib/package.json"));

/** The YAML parser electron-builder itself reads packaging/electron-builder.yml with. */
export function parseBuilderYaml(text) {
  return requireFromAppBuilder("js-yaml").load(text);
}

/** The plist codec electron-builder writes Info.plist with. */
export function parsePlist(text) {
  return requireFromAppBuilder("plist").parse(text);
}

export function buildPlist(value) {
  return requireFromAppBuilder("plist").build(value);
}
