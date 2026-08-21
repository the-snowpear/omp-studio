import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertForkApplied, overlayRoot } from "./omp-overlay.mjs";
import { PATCHSET_VERSION_FILE, readPatchsetVersionConstant } from "./omp-seam.mjs";
import { findBun, npmInvocation, ompSourceDirectory, run, toolingEnvironment } from "./omp-tooling.mjs";
import { readRuntimeSigningKeys } from "./runtime-signing-keys.mjs";
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

/** Fail fast when the Runtime would report a version the series does not expect. */
async function assertPatchsetVersionInSync() {
  const expected = (await readPatchSeries()).patchsetVersion;
  for (const root of [overlayRoot, ompSourceDirectory]) {
    const path = join(root, ...PATCHSET_VERSION_FILE.split("/"));
    const found = readPatchsetVersionConstant(await readFile(path, "utf8"));
    if (found !== expected) {
      throw new Error(
        `PATCHSET_VERSION is ${found} in ${path} but series.json says ${expected}. Run npm run omp:patches:regen.`,
      );
    }
  }
}


const bun = findBun();
const env = toolingEnvironment({
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
});

// Building a vendor tree without the fork applied yields an omp.exe with no
// studio-host mode. That only surfaces much later, as an opaque identity probe
// failure after a full Rust build, so check the cheap precondition first.
await assertForkApplied();
// Same reasoning for the version the Runtime will report: packaging refuses to
// sign an artifact whose probed identity disagrees with series.json, and that
// check lands only after the native build. `npm run omp:patches:regen` keeps the
// two in sync; this catches a hand-edited constant before the build starts.
await assertPatchsetVersionInSync();

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

const npm = npmInvocation();
run(npm.command, [...npm.prefix, "run", "build"]);
const runtimeIdentity = await probeRuntimeIdentity({ binaryPath: executable });
console.log(`Probed Runtime identity ${runtimeIdentity.runtimeVersion}`);

const artifactPlatform = `${process.platform}-${process.arch}`;
const upstream = await readUpstreamPin();
const series = await readPatchSeries();
const upstreamVersion = await readUpstreamVersion();
const runtimeVersion = deriveRuntimeVersion(upstreamVersion, series);
const artifactDirectory =
  process.env.OMP_ARTIFACT_DIR ?? defaultArtifactDirectory(artifactPlatform, runtimeVersion);
const envKeyPath = process.env.OMP_RUNTIME_SIGNING_KEY?.trim();
const envKeyId = process.env.OMP_RUNTIME_SIGNING_KEY_ID?.trim();
let signingKey;
let keyId;
if (envKeyPath && envKeyId) {
  signingKey = await readFile(envKeyPath);
  keyId = envKeyId;
} else {
  try {
    const local = await readRuntimeSigningKeys();
    signingKey = local.privateKey;
    keyId = local.keyId;
  } catch {
    throw new Error(
      "OMP_RUNTIME_SIGNING_KEY and OMP_RUNTIME_SIGNING_KEY_ID are required to package a Runtime artifact. Run npm run omp:keys to create a local signing key.",
    );
  }
}

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
  keyId,
  outDirectory: artifactDirectory,
  runtimeIdentity,
});
console.log(`Generated ${manifestPath} (runtimeVersion=${manifest.runtimeVersion})`);
console.log(`Generated ${checksumsPath}`);
console.log(`Generated ${signaturePath}`);
