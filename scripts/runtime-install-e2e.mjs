// WP-002/WP-003 opt-in end-to-end check: installs a real generated Runtime
// artifact and activates it with the REAL default self-check runner (which
// executes the installed `omp.exe --smoke-test`). Not part of the unit test
// suite; run explicitly after `npm run omp:build:host` (or `npm run
// omp:artifact`) and `npm run build -w @omp-studio/runtime-installer`.
//
//   npm run omp:e2e:install [-- --artifact <path>]

import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./omp-tooling.mjs";

const { RuntimeInstaller } = await import(
  pathToFileURL(join(repositoryRoot, "packages", "runtime-installer", "dist", "src", "index.js")).href
);

const artifactsRoot = join(
  repositoryRoot,
  "packages",
  "runtime-installer",
  "dist",
  "artifacts",
  `${process.platform}-${process.arch}`,
);

function resolveArtifactDirectory() {
  const flagIndex = process.argv.indexOf("--artifact");
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (!value) throw new Error("--artifact requires a directory path");
    return resolve(value);
  }
  if (process.env.OMP_ARTIFACT_DIR) return resolve(process.env.OMP_ARTIFACT_DIR);
  return artifactsRoot;
}

async function findNewestVersion(artifactDirectory) {
  if (!existsSync(artifactDirectory)) return undefined;
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  return versions.length === 0 ? undefined : join(artifactDirectory, versions[versions.length - 1]);
}

const requestedArtifact = resolveArtifactDirectory();
const rollbackFlagIndex = process.argv.indexOf("--rollback-artifact");
const rollbackArtifact = rollbackFlagIndex === -1 ? undefined : process.argv[rollbackFlagIndex + 1];
if (rollbackFlagIndex !== -1 && !rollbackArtifact) throw new Error("--rollback-artifact requires a directory path");
const rollbackKeyIndex = process.argv.indexOf("--rollback-public-key");
const rollbackPublicKey = rollbackKeyIndex === -1 ? undefined : process.argv[rollbackKeyIndex + 1];
if (rollbackKeyIndex !== -1 && (!rollbackPublicKey || !rollbackArtifact)) throw new Error("--rollback-public-key requires a public key file and --rollback-artifact");
const artifactDirectory =
  (await findNewestVersion(requestedArtifact)) ?? requestedArtifact;
if (!existsSync(join(artifactDirectory, "runtime-manifest.json"))) {
  throw new Error(
    `No Runtime artifact found at ${artifactDirectory}; run "npm run omp:build:host" or "npm run omp:artifact" first`,
  );
}

const root = await mkdtemp(join(tmpdir(), "omp-studio-e2e-"));
try {
  const trustedKeyPath = process.env.OMP_RUNTIME_TRUSTED_PUBLIC_KEY;
  const trustedKeyId = process.env.OMP_RUNTIME_SIGNING_KEY_ID;
  if (!trustedKeyPath || !trustedKeyId) {
    throw new Error("OMP_RUNTIME_TRUSTED_PUBLIC_KEY and OMP_RUNTIME_SIGNING_KEY_ID are required for install E2E");
  }
  const trustedKeys = Object.create(null);
  trustedKeys[trustedKeyId] = await readFile(trustedKeyPath);
  if (rollbackPublicKey) {
    const signature = JSON.parse(await readFile(join(resolve(rollbackArtifact), "runtime-signature.json"), "utf8"));
    if (typeof signature.keyId !== "string" || signature.keyId.length === 0) throw new Error("Rollback artifact has no signing key id");
    const publicKey = await readFile(resolve(rollbackPublicKey));
    if (trustedKeys[signature.keyId] && !trustedKeys[signature.keyId].equals(publicKey)) throw new Error("Different public keys cannot share a signing key id");
    trustedKeys[signature.keyId] = publicKey;
  }
  const installer = new RuntimeInstaller(join(root, "installed"), { trustedKeys });
  let baselineVersion;
  if (rollbackArtifact) {
    const baseline = await installer.install(resolve(rollbackArtifact));
    await installer.activate(baseline.runtimeVersion);
    baselineVersion = baseline.runtimeVersion;
  }
  const manifest = await installer.install(artifactDirectory);
  const record = await installer.activate(manifest.runtimeVersion);
  const current = await installer.current();
  if (current?.runtimeVersion !== manifest.runtimeVersion) {
    throw new Error(`current.json points at ${current?.runtimeVersion}; expected ${manifest.runtimeVersion}`);
  }
  console.log(
    `E2E ok: installed and activated ${record.runtimeVersion} (entrypoint=${manifest.entrypoint}, platform=${manifest.platform})`,
  );
  if (baselineVersion) {
    await installer.rollback();
    if ((await installer.current())?.runtimeVersion !== baselineVersion) throw new Error("Rollback did not restore the baseline Runtime");
    await installer.activate(manifest.runtimeVersion);
    if ((await installer.current())?.runtimeVersion !== manifest.runtimeVersion) throw new Error("Reactivation after rollback failed");
    console.log("E2E rollback ok: " + baselineVersion + " -> " + manifest.runtimeVersion + " -> " + baselineVersion + " -> " + manifest.runtimeVersion);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
