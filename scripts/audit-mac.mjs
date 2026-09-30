/**
 * Fail-closed audit of the macOS pack output (pack:mac, darwin-arm64).
 *
 * Defends the bundle contracts:
 * - the .app, the first-install dmg and the ditto update zip exist and fit
 * - Info.plist carries the bundle id, version, minimum system and every
 *   privacy purpose string; the Chinese strings table has the same keys
 * - Contents/ holds only the standard bundle entries: anything else is
 *   unsealed and breaks the signature
 * - renderer + CSP, main entry, sandboxed preload and tray templates are packed
 * - exactly one Runtime: Mach-O arm64, 0755, darwin-arm64 manifest, and its
 *   Ed25519 signature and checksums still verify, i.e. it was not re-signed
 * - public Runtime keys only, no private key anywhere
 * - node-pty's native module and spawn-helper are arm64, the helper is
 *   executable, and no Windows prebuilds ride along
 * - codesign --verify --deep --strict passes for the .app and for the copy
 *   restored from the update zip, so symlinks and signature xattrs survived
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPublicRuntimeKeys, findPrivateKeyFiles } from "./audit-installer.mjs";
import {
  MAC_APP_BUNDLE,
  MAC_APP_ID,
  MAC_CATEGORY,
  MAC_EXECUTABLE,
  MAC_MINIMUM_SYSTEM_VERSION,
  MAC_TARGET_PLATFORM,
  MAC_UNPACKED_DIRECTORY,
  MAC_USAGE_DESCRIPTIONS,
  macDmgFileName,
  macUpdateZipFileName,
  parsePlist,
} from "./mac-bundle.mjs";
import { REPOSITORY_ROOT, SERIES_JSON_PATH, VENDOR_CODING_AGENT_PACKAGE_JSON, deriveRuntimeVersion } from "./runtime-artifact.mjs";
import { assertExecutableTarget, assertRuntimeManifestPlatform, machOArchitecture } from "./target-platform.mjs";

const require = createRequire(import.meta.url);

export const MAC_CONTENTS_ENTRIES = Object.freeze(["Info.plist", "PkgInfo", "MacOS", "Resources", "Frameworks", "_CodeSignature"]);
export const MAC_MAX_ARTIFACT_BYTES = 600 * 1024 * 1024;

export function defaultMacOutputDirectory() {
  return process.env.OMP_PACK_OUTPUT_DIR
    ? resolve(REPOSITORY_ROOT, process.env.OMP_PACK_OUTPUT_DIR)
    : join(REPOSITORY_ROOT, "outputs", "installer-mac");
}

export function desktopVersion() {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, "apps", "desktop", "package.json"), "utf8")).version;
}

/** Runs a command and returns stdout + stderr (codesign -d writes to stderr); throws on a non-zero exit. */
function defaultExec(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed with exit ${result.status}\n${output.trim()}`);
  return output;
}

/**
 * The packed Runtime against the keys packed beside it: proves its bytes are
 * the signed ones. Imported lazily: pack:mac loads this module before its own
 * build step has produced the runtime-installer package.
 */
async function verifyPackedRuntime(directory, keysDirectory) {
  const { RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest, verifySignedArtifact } = await import("@omp-studio/runtime-installer");
  const table = JSON.parse(readFileSync(join(keysDirectory, "trusted-keys.json"), "utf8"));
  const trustedKeys = {};
  for (const [id, name] of Object.entries(table.keys)) trustedKeys[id] = readFileSync(join(keysDirectory, name));
  await verifySignedArtifact({
    directory,
    layout: RUNTIME_ARTIFACT_LAYOUT,
    parseManifest: parseRuntimeInstallationManifest,
    requireCovered: (manifest) => ["runtime-manifest.json", manifest.entrypoint],
    trustedKeys,
  });
}

function requireFile(path, what) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${what} is missing: ${path}`);
  return path;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function expectedRuntimeVersion() {
  const series = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const vendorPkg = JSON.parse(readFileSync(VENDOR_CODING_AGENT_PACKAGE_JSON, "utf8"));
  return deriveRuntimeVersion(vendorPkg.version, series);
}

/**
 * @param {string} outputDir
 * @param {{
 *   version?: string,
 *   runtimeVersion?: string,
 *   exec?: (file: string, args: string[]) => string,
 *   modeOf?: (path: string) => number,
 *   verifyRuntime?: (directory: string, keysDirectory: string) => Promise<void>,
 *   tmpRoot?: string,
 * }} [options]
 */
export async function auditMacOutput(outputDir = defaultMacOutputDirectory(), options = {}) {
  const version = options.version ?? desktopVersion();
  const exec = options.exec ?? defaultExec;
  const modeOf = options.modeOf ?? ((path) => statSync(path).mode);
  const verifyRuntime = options.verifyRuntime ?? verifyPackedRuntime;
  const notes = [];

  const appPath = join(outputDir, MAC_UNPACKED_DIRECTORY, MAC_APP_BUNDLE);
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
    throw new Error(`${MAC_APP_BUNDLE} is missing under ${join(outputDir, MAC_UNPACKED_DIRECTORY)}. electron-builder did not finish.`);
  }
  const contents = join(appPath, "Contents");
  const unexpected = readdirSync(contents).filter((entry) => !MAC_CONTENTS_ENTRIES.includes(entry));
  if (unexpected.length > 0) {
    throw new Error(`Unsealed entries in ${MAC_APP_BUNDLE}/Contents/: ${unexpected.join(", ")}. Runtime and keys belong under Contents/Resources.`);
  }
  if (!existsSync(join(contents, "_CodeSignature"))) throw new Error(`${MAC_APP_BUNDLE} is not signed (no Contents/_CodeSignature).`);

  const infoPlist = parsePlist(readFileSync(requireFile(join(contents, "Info.plist"), "Info.plist"), "utf8"));
  const expectedInfo = {
    CFBundleIdentifier: MAC_APP_ID,
    CFBundleShortVersionString: version,
    CFBundleExecutable: MAC_EXECUTABLE,
    LSMinimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
    LSApplicationCategoryType: MAC_CATEGORY,
    ...MAC_USAGE_DESCRIPTIONS,
  };
  for (const [key, value] of Object.entries(expectedInfo)) {
    if (infoPlist[key] !== value) throw new Error(`Info.plist ${key} is ${JSON.stringify(infoPlist[key])}; expected ${JSON.stringify(value)}`);
  }
  const resources = join(contents, "Resources");
  const zhStrings = readFileSync(requireFile(join(resources, "zh_CN.lproj", "InfoPlist.strings"), "Chinese purpose strings"), "utf8");
  for (const key of Object.keys(MAC_USAGE_DESCRIPTIONS)) {
    if (!zhStrings.includes(`"${key}" = `)) throw new Error(`zh_CN.lproj/InfoPlist.strings has no ${key}`);
  }
  notes.push(`Info.plist ${MAC_APP_ID} ${version}, macOS ${MAC_MINIMUM_SYSTEM_VERSION}+, purpose strings (en, zh_CN)`);

  const mainExecutable = requireFile(join(contents, "MacOS", MAC_EXECUTABLE), "Main executable");
  if (machOArchitecture(readFileSync(mainExecutable)) !== "arm64") throw new Error(`${mainExecutable} is not an arm64 executable`);

  const rendererHtml = readFileSync(requireFile(join(resources, "renderer", "dist", "index.html"), "Renderer extraResources"), "utf8");
  if (!rendererHtml.includes("Content-Security-Policy")) throw new Error("Packaged renderer index.html has no Content-Security-Policy meta tag.");
  const asarPath = requireFile(join(resources, "app.asar"), "app.asar");
  const asar = require("@electron/asar");
  const pkg = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  if (pkg.main !== "./dist/src/main.js") throw new Error("Packaged app package.json main entrypoint must be './dist/src/main.js'.");
  const preloadUnpacked = join(resources, "app.asar.unpacked", "dist", "preload.cjs");
  let preloadPacked = false;
  try {
    preloadPacked = asar.extractFile(asarPath, "dist/preload.cjs").length > 0;
  } catch {
    preloadPacked = false;
  }
  if (!preloadPacked && !existsSync(preloadUnpacked)) throw new Error("Sandboxed preload dist/preload.cjs is not in the packaged app.");
  for (const name of ["trayTemplate.png", "trayTemplate@2x.png"]) requireFile(join(resources, "darwin", name), "Menu bar template image");
  notes.push("renderer + CSP, main entry, preload, tray templates");

  const leakedArtifacts = join(resources, "app.asar.unpacked", "node_modules", "@omp-studio", "runtime-installer", "dist", "artifacts");
  if (existsSync(leakedArtifacts)) throw new Error(`Runtime artifact cache leaked into asar.unpacked: ${leakedArtifacts}`);

  const runtimeVersion = options.runtimeVersion ?? expectedRuntimeVersion();
  const versionsRoot = join(resources, "runtime", "versions");
  if (!existsSync(versionsRoot)) throw new Error(`Runtime payload missing at ${versionsRoot}`);
  const versionDirs = readdirSync(versionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (versionDirs.length !== 1 || versionDirs[0].name !== runtimeVersion) {
    throw new Error(`The app must ship exactly Runtime ${runtimeVersion}; found ${versionDirs.map((entry) => entry.name).join(", ") || "(none)"}`);
  }
  const runtimeDirectory = join(versionsRoot, runtimeVersion);
  const omp = requireFile(join(runtimeDirectory, "omp"), "Runtime executable");
  const manifest = JSON.parse(readFileSync(requireFile(join(runtimeDirectory, "runtime-manifest.json"), "Runtime manifest"), "utf8"));
  assertRuntimeManifestPlatform(manifest, MAC_TARGET_PLATFORM, runtimeVersion);
  assertExecutableTarget(omp, MAC_TARGET_PLATFORM);
  if ((modeOf(omp) & 0o777) !== 0o755) throw new Error(`${omp} must be mode 0755, found 0${(modeOf(omp) & 0o777).toString(8)}`);
  const keysDirectory = join(resources, "runtime-keys");
  assertPublicRuntimeKeys(keysDirectory);
  await verifyRuntime(runtimeDirectory, keysDirectory);
  exec("/usr/bin/codesign", ["--verify", "--strict", omp]);
  notes.push(`runtime ${runtimeVersion} ${formatSize(statSync(omp).size)}: signature and checksums verify, own code signature intact`);

  const keyHits = findPrivateKeyFiles(appPath);
  if (keyHits.length > 0) throw new Error(`Refusing to ship a private signing key in the app:\n${keyHits.join("\n")}`);
  notes.push("runtime public key only");

  const ptyRoot = join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(ptyRoot)) throw new Error(`node-pty is not unpacked at ${ptyRoot}`);
  const prebuilds = join(ptyRoot, "prebuilds");
  const foreign = existsSync(prebuilds) ? readdirSync(prebuilds).filter((name) => name !== "darwin-arm64") : [];
  if (foreign.length > 0) throw new Error(`node-pty ships prebuilds for other platforms: ${foreign.join(", ")}`);
  // node-pty loads build/Release before prebuilds/<platform>-<arch>, and runs the spawn-helper beside it.
  const nativeDirectory = [join(ptyRoot, "build", "Release"), join(prebuilds, "darwin-arm64")].find((dir) => existsSync(join(dir, "pty.node")));
  if (nativeDirectory === undefined) throw new Error("node-pty has no pty.node for darwin-arm64");
  const spawnHelper = requireFile(join(nativeDirectory, "spawn-helper"), "node-pty spawn-helper");
  for (const binary of [join(nativeDirectory, "pty.node"), spawnHelper]) {
    if (machOArchitecture(readFileSync(binary)) !== "arm64") throw new Error(`${binary} is not arm64`);
  }
  if ((modeOf(spawnHelper) & 0o111) !== 0o111) throw new Error(`${spawnHelper} is not executable; every terminal would fail with posix_spawnp`);
  notes.push("node-pty arm64, spawn-helper executable");

  exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const signature = exec("/usr/bin/codesign", ["-dv", "--verbose=2", appPath]);
  notes.push(/Signature=adhoc/u.test(signature) ? "codesign --deep --strict (ad hoc)" : "codesign --deep --strict");

  const dmgPath = requireFile(join(outputDir, macDmgFileName(version)), "First-install dmg");
  const zipPath = requireFile(join(outputDir, macUpdateZipFileName(version)), "Update zip");
  for (const artifact of [dmgPath, zipPath]) {
    const size = statSync(artifact).size;
    if (size > MAC_MAX_ARTIFACT_BYTES) throw new Error(`${artifact} is ${formatSize(size)}; a Runtime artifact cache probably leaked into the bundle`);
  }
  exec("/usr/bin/hdiutil", ["verify", dmgPath]);

  const restored = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "omp-mac-zip-"));
  try {
    exec("/usr/bin/ditto", ["-x", "-k", zipPath, restored]);
    const restoredApp = join(restored, MAC_APP_BUNDLE);
    if (!existsSync(restoredApp)) throw new Error(`The update zip does not contain ${MAC_APP_BUNDLE} at its root`);
    exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", restoredApp]);
    const restoredOmp = join(restoredApp, "Contents", "Resources", "runtime", "versions", runtimeVersion, "omp");
    if ((modeOf(restoredOmp) & 0o777) !== 0o755) throw new Error("The update zip lost the Runtime's execute bits");
  } finally {
    rmSync(restored, { recursive: true, force: true });
  }
  notes.push(`dmg ${formatSize(statSync(dmgPath).size)}, update zip ${formatSize(statSync(zipPath).size)} (restores and verifies)`);

  return { appPath, dmgPath, zipPath, notes };
}

const invoked = process.argv[1];
if (invoked !== undefined && fileURLToPath(import.meta.url).toLowerCase() === invoked.toLowerCase()) {
  try {
    const report = await auditMacOutput();
    console.log(`macOS audit passed: ${report.appPath}`);
    for (const line of report.notes) console.log(`  ${line}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
