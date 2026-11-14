/** Native Linux x64 AppImage + deb, including the signed Runtime and Electron PTY. */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { auditLinuxOutput, defaultLinuxOutputDirectory } from "./audit-linux.mjs";
import { deriveLinuxBuilderConfig, LINUX_TARGET_PLATFORM } from "./linux-bundle.mjs";
import { parseBuilderYaml } from "./mac-bundle.mjs";
import { npmInvocation, repositoryRoot, run } from "./omp-tooling.mjs";
import { bundlePreload } from "./preload-bundle.mjs";
import { assertLockedElectronVersion } from "./release-cache.mjs";
import { assertNativeTargetBuild } from "./target-platform.mjs";

const require = createRequire(import.meta.url);

async function main() {
  assertNativeTargetBuild(LINUX_TARGET_PLATFORM);
  assertLockedElectronVersion();
  const skipHost = process.argv.includes("--skip-host") || process.env.OMP_PACK_SKIP_HOST === "1";
  const skipBuild = process.argv.includes("--skip-build") || process.env.OMP_PACK_SKIP_BUILD === "1";
  const npm = npmInvocation();
  const env = { ...process.env, OMP_TARGET_PLATFORM: "linux", OMP_TARGET_ARCH: "x64", OMP_INSTALLER_ARTIFACT_PLATFORM: LINUX_TARGET_PLATFORM };
  if (!skipHost) run(npm.command, [...npm.prefix, "run", "omp:build:host"], { env });
  else if (!skipBuild) run(npm.command, [...npm.prefix, "run", "build"], { env });
  bundlePreload();
  run(npm.command, [...npm.prefix, "run", "pack:linux:prepare"], { env });
  for (const directory of ["build/Release", "prebuilds/linux-x64"]) {
    const helper = join(repositoryRoot, "node_modules/node-pty", directory, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  const config = deriveLinuxBuilderConfig(parseBuilderYaml(readFileSync(join(repositoryRoot, "packaging/electron-builder.yml"), "utf8")), { outputDirectory: defaultLinuxOutputDirectory() });
  const { Arch, Platform, build } = require("electron-builder");
  await build({ projectDir: repositoryRoot, targets: Platform.LINUX.createTarget(["AppImage", "deb"], Arch.x64), config, publish: "never" });
  const report = await auditLinuxOutput();
  console.log(`[pack:linux] Audit passed: ${report.appPath}`);
  for (const note of report.notes) console.log(`[pack:linux] ${note}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
