/**
 * macOS pack pipeline for OMP Studio (darwin-arm64, ad hoc signed).
 *
 *   npm run pack:mac
 *
 * Steps: optional Runtime host rebuild → workspace build → sandboxed preload →
 * signed Runtime payload + public keys → icon.icns and localized purpose
 * strings → electron-builder (.app signed ad hoc through @electron/osx-sign,
 * then the first-install .dmg) → update zip (ditto) → fail-closed audit
 * (scripts/audit-mac.mjs).
 *
 * Flags (as pack:win):
 *   --skip-host   reuse packages/runtime-installer/dist/artifacts/darwin-arm64
 *   --skip-build  skip `npm run build` (the preload is still bundled)
 *
 * packaging/electron-builder.yml is read, never written: the macOS
 * configuration is derived from it in scripts/mac-bundle.mjs.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";

import { auditMacOutput, defaultMacOutputDirectory, desktopVersion } from "./audit-mac.mjs";
import {
  MAC_APP_BUNDLE,
  MAC_ICONSET,
  MAC_TARGET_PLATFORM,
  MAC_UNPACKED_DIRECTORY,
  MAC_USAGE_DESCRIPTIONS_ZH,
  deriveMacBuilderConfig,
  infoPlistStrings,
  macSignOptions,
  macUpdateZipFileName,
  parseBuilderYaml,
  requireFromAppBuilder,
} from "./mac-bundle.mjs";
import { npmInvocation, repositoryRoot, run, toolingEnvironment } from "./omp-tooling.mjs";
import { bundlePreload } from "./preload-bundle.mjs";
import { assertNativeTargetBuild } from "./target-platform.mjs";

const require = createRequire(import.meta.url);

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

/** node-pty's npm tarball has shipped spawn-helper without its execute bit; every terminal then fails. */
function makeNodePtyHelpersExecutable() {
  for (const rel of [join("prebuilds", "darwin-arm64", "spawn-helper"), join("build", "Release", "spawn-helper")]) {
    const path = join(repositoryRoot, "node_modules", "node-pty", rel);
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}

/** icon.icns from the 1024 px product icon, and zh_CN purpose strings, outside the output tree. */
function stageBuildResources(directory) {
  rmSync(directory, { recursive: true, force: true });
  const iconset = join(directory, "icon.iconset");
  mkdirSync(iconset, { recursive: true });
  const source = join(repositoryRoot, "apps", "desktop", "resources", "icon.png");
  for (const [name, size] of MAC_ICONSET) {
    run("/usr/bin/sips", ["-z", String(size), String(size), source, "--out", join(iconset, name)], { capture: true });
  }
  const iconPath = join(directory, "icon.icns");
  run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", iconPath]);

  const localizedResourcesDirectory = join(directory, "localized");
  mkdirSync(join(localizedResourcesDirectory, "zh_CN.lproj"), { recursive: true });
  writeFileSync(join(localizedResourcesDirectory, "zh_CN.lproj", "InfoPlist.strings"), infoPlistStrings(MAC_USAGE_DESCRIPTIONS_ZH), "utf8");
  return { iconPath, localizedResourcesDirectory };
}

/**
 * electron-builder runs in this process, so its signing inputs are set here.
 * Ad hoc signing uses no secret: pull request builds sign too
 * (CSC_FOR_PULL_REQUEST), and certificate variables from the developer's
 * shell must not pull a keychain identity into the build.
 */
function prepareSigningEnvironment() {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  process.env.CSC_FOR_PULL_REQUEST = "true";
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "CSC_KEYCHAIN"]) delete process.env[name];
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("pack:mac builds the darwin-arm64 app on an Apple Silicon Mac.");
  }
  assertNativeTargetBuild(MAC_TARGET_PLATFORM);

  const skipHost = hasFlag("--skip-host") || process.env.OMP_PACK_SKIP_HOST === "1";
  const skipBuild = hasFlag("--skip-build") || process.env.OMP_PACK_SKIP_BUILD === "1";
  const npm = npmInvocation();
  const env = toolingEnvironment({
    OMP_TARGET_PLATFORM: "darwin",
    OMP_TARGET_ARCH: "arm64",
    OMP_INSTALLER_ARTIFACT_PLATFORM: MAC_TARGET_PLATFORM,
  });

  if (!skipHost) {
    console.log("[pack:mac] Building signed Runtime host artifact...");
    run(npm.command, [...npm.prefix, "run", "omp:build:host"], { env });
  } else {
    console.log("[pack:mac] Skipping host rebuild (OMP_PACK_SKIP_HOST / --skip-host)");
  }
  if (!skipBuild) {
    if (skipHost) {
      console.log("[pack:mac] Building workspace...");
      run(npm.command, [...npm.prefix, "run", "build"], { env });
    }
  } else {
    console.log("[pack:mac] Skipping workspace build");
  }

  console.log("[pack:mac] Bundling sandboxed preload...");
  bundlePreload();
  const rendererIndex = join(repositoryRoot, "apps", "renderer", "dist", "index.html");
  if (!existsSync(rendererIndex)) {
    throw new Error(`Renderer bundle missing at ${rendererIndex}. Run npm run build.`);
  }

  console.log("[pack:mac] Staging the signed Runtime and its public keys...");
  run(npm.command, [...npm.prefix, "run", "pack:mac:prepare"], { env });

  makeNodePtyHelpersExecutable();
  console.log("[pack:mac] Rendering icon.icns and localized purpose strings...");
  const outputDirectory = defaultMacOutputDirectory();
  const { iconPath, localizedResourcesDirectory } = stageBuildResources(join(repositoryRoot, "outputs", "installer-mac-resources"));

  const base = parseBuilderYaml(readFileSync(join(repositoryRoot, "packaging", "electron-builder.yml"), "utf8"));
  const { signAsync } = requireFromAppBuilder("@electron/osx-sign");
  const entitlements = join(repositoryRoot, "packaging", "mac", "entitlements.mac.plist");
  const entitlementsInherit = join(repositoryRoot, "packaging", "mac", "entitlements.mac.inherit.plist");
  const config = deriveMacBuilderConfig(base, {
    outputDirectory,
    iconPath,
    localizedResourcesDirectory,
    sign: async (options) => {
      await signAsync(macSignOptions({ app: options.app, version: options.version, entitlements, entitlementsInherit }));
    },
  });

  console.log("[pack:mac] electron-builder (.app, ad hoc signature, .dmg)...");
  prepareSigningEnvironment();
  const { Arch, Platform, build } = require("electron-builder");
  await build({ projectDir: repositoryRoot, targets: Platform.MAC.createTarget(["dmg"], Arch.arm64), config, publish: "never" });

  const version = desktopVersion();
  const appPath = join(outputDirectory, MAC_UNPACKED_DIRECTORY, MAC_APP_BUNDLE);
  const zipPath = join(outputDirectory, macUpdateZipFileName(version));
  console.log("[pack:mac] Update zip (ditto keeps symlinks and signature xattrs)...");
  rmSync(zipPath, { force: true });
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);

  const report = await auditMacOutput(outputDirectory, { version });
  console.log(`[pack:mac] Audit passed: ${report.appPath}`);
  for (const line of report.notes) console.log(`[pack:mac]   ${line}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
