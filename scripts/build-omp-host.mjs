import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findBun, ompSourceDirectory, run, toolingEnvironment } from "./omp-tooling.mjs";
import {
  MANAGED_ENTRYPOINT,
  PATCHES_DIRECTORY,
  defaultArtifactDirectory,
  deriveRuntimeVersion,
  generateRuntimeArtifact,
  probeRuntimeIdentity,
  readPatchSeries,
  readUpstreamPin,
  readUpstreamVersion,
} from "./runtime-artifact.mjs";

const bun = findBun();
const env = toolingEnvironment({
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
});

run(bun, ["--cwd=packages/natives", "run", "build"], { cwd: ompSourceDirectory, env });
run(bun, ["--cwd=packages/coding-agent", "run", "build"], { cwd: ompSourceDirectory, env });

const executable = join(
  ompSourceDirectory,
  "packages",
  "coding-agent",
  "dist",
  process.platform === "win32" ? "omp.exe" : "omp",
);
if (!existsSync(executable) || !statSync(executable).isFile()) {
  throw new Error(`Expected host executable was not produced: ${executable}`);
}

run(executable, ["--version"], { cwd: ompSourceDirectory, env });
run(executable, ["--smoke-test"], { cwd: ompSourceDirectory, env });
console.log(`Built and verified ${executable}`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run(npm, ["run", "build"]);
const runtimeIdentity = await probeRuntimeIdentity({ binaryPath: executable });
console.log(`Probed Runtime identity ${runtimeIdentity.runtimeVersion}`);

const artifactPlatform = `${process.platform}-${process.arch}`;
const upstream = await readUpstreamPin();
const series = await readPatchSeries();
const upstreamVersion = await readUpstreamVersion();
const runtimeVersion = deriveRuntimeVersion(upstreamVersion, series);
const artifactDirectory =
  process.env.OMP_ARTIFACT_DIR ?? defaultArtifactDirectory(artifactPlatform, runtimeVersion);
if (!process.env.OMP_RUNTIME_SIGNING_KEY || !process.env.OMP_RUNTIME_SIGNING_KEY_ID) {
  throw new Error("OMP_RUNTIME_SIGNING_KEY and OMP_RUNTIME_SIGNING_KEY_ID are required to package a Runtime artifact");
}
const signingKey = await readFile(process.env.OMP_RUNTIME_SIGNING_KEY);

const { manifestPath, checksumsPath, signaturePath, manifest } = await generateRuntimeArtifact({
  upstream,
  series,
  upstreamVersion,
  binaryPath: executable,
  patchesDirectory: PATCHES_DIRECTORY,
  platform: artifactPlatform,
  entrypoint: MANAGED_ENTRYPOINT,
  channel: process.env.OMP_RUNTIME_CHANNEL ?? "stable",
  signingKey,
  keyId: process.env.OMP_RUNTIME_SIGNING_KEY_ID,
  outDirectory: artifactDirectory,
  runtimeIdentity,
});
console.log(`Generated ${manifestPath} (runtimeVersion=${manifest.runtimeVersion})`);
console.log(`Generated ${checksumsPath}`);
console.log(`Generated ${signaturePath}`);
