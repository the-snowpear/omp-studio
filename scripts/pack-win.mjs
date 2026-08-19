/**
 * Windows NSIS pack pipeline for OMP Studio.
 *
 *   npm run pack:win
 *
 * Steps: optional host rebuild → workspace build → sandboxed preload →
 * public Runtime key copy → electron-builder → fail-closed audit of the
 * unpacked tree and the Setup exe (no private key, renderer, omp.exe).
 *
 * Flags:
 *   --skip-host   reuse packages/runtime-installer/dist/artifacts (still
 *                 fails if the signed tree is missing)
 *   --skip-build  skip `npm run build` (preload is still bundled)
 *
 * Env: CSC_IDENTITY_AUTO_DISCOVERY=false so an unsigned 0.1.0 preview does
 * not pick a random machine certificate.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { npmInvocation, repositoryRoot, run, toolingEnvironment } from "./omp-tooling.mjs";
import { auditInstallerOutput } from "./audit-installer.mjs";
import { buildInstallerHost } from "./build-installer-host.mjs";

const esbuildCli = join(repositoryRoot, "node_modules", "esbuild", "bin", "esbuild");
const electronBuilderCli = join(repositoryRoot, "node_modules", "electron-builder", "cli.js");

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function bundlePreload() {
  if (!existsSync(esbuildCli)) {
    throw new Error("esbuild is missing. Run npm install.");
  }
  run(process.execPath, [
    esbuildCli,
    "apps/desktop/src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=apps/desktop/dist/preload.cjs",
  ]);
  if (!existsSync(join(repositoryRoot, "apps", "desktop", "dist", "preload.cjs"))) {
    throw new Error("Sandboxed preload was not emitted at apps/desktop/dist/preload.cjs");
  }
}

function disableNodePtySpectreMitigation() {
  const ptyRoot = join(repositoryRoot, "node_modules", "node-pty");
  if (!existsSync(ptyRoot)) {
    throw new Error("node-pty is missing. Run npm install.");
  }
  // VS 2022 Community often lacks Spectre-mitigated libs (MSB8040). node-pty's
  // gyp hard-codes Spectre; Directory.Build.targets wins after the vcxproj.
  writeFileSync(
    join(ptyRoot, "Directory.Build.targets"),
    `<Project>
  <PropertyGroup>
    <SpectreMitigation>false</SpectreMitigation>
  </PropertyGroup>
</Project>
`,
    "utf8",
  );
  for (const rel of ["binding.gyp", join("deps", "winpty", "src", "winpty.gyp")]) {
    const path = join(ptyRoot, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const next = text.replaceAll("'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'");
    if (next !== text) writeFileSync(path, next);
  }
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Windows NSIS packaging is the only installer target.");
  }
  if (!existsSync(electronBuilderCli)) {
    throw new Error("electron-builder is missing. Run npm install.");
  }

  const skipHost = hasFlag("--skip-host") || process.env.OMP_PACK_SKIP_HOST === "1";
  const skipBuild = hasFlag("--skip-build") || process.env.OMP_PACK_SKIP_BUILD === "1";
  const npm = npmInvocation();
  const env = toolingEnvironment({
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CSC_LINK: "",
    WIN_CSC_LINK: "",
  });

  if (!skipHost) {
    console.log("[pack:win] Building signed Runtime host artifact...");
    run(npm.command, [...npm.prefix, "run", "omp:build:host"], { env });
  } else {
    console.log("[pack:win] Skipping host rebuild (OMP_PACK_SKIP_HOST / --skip-host)");
  }

  if (!skipBuild) {
    if (skipHost) {
      console.log("[pack:win] Building workspace...");
      run(npm.command, [...npm.prefix, "run", "build"], { env });
    }
  } else {
    console.log("[pack:win] Skipping workspace build");
  }

  console.log("[pack:win] Bundling sandboxed preload...");
  bundlePreload();

  const rendererIndex = join(repositoryRoot, "apps", "renderer", "dist", "index.html");
  if (!existsSync(rendererIndex)) {
    throw new Error(`Renderer bundle missing at ${rendererIndex}. Run npm run build.`);
  }

  console.log("[pack:win] Preparing installer public Runtime key...");
  run(npm.command, [...npm.prefix, "run", "pack:win:prepare"], { env });

  console.log("[pack:win] Building HTML installer UI host...");
  await buildInstallerHost();

  console.log("[pack:win] Disabling node-pty Spectre mitigation for Electron rebuild...");
  disableNodePtySpectreMitigation();

  console.log("[pack:win] electron-builder NSIS...");
  run(
    process.execPath,
    [electronBuilderCli, "--config", "packaging/electron-builder.yml", "--win", "nsis", "--publish", "never"],
    { env },
  );

  const report = auditInstallerOutput(join(repositoryRoot, "outputs", "installer"));
  console.log(`[pack:win] Audit passed: ${report.installerExe}`);
  for (const line of report.notes) {
    console.log(`[pack:win]   ${line}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
