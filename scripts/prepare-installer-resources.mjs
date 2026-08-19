// Stage the current signed Runtime + public verification key for NSIS.
// Never copies the private signing key. Never packs leftover artifact versions.
// Invoked before electron-builder.

import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  REPOSITORY_ROOT,
  deriveRuntimeVersion,
  readPatchSeries,
  readUpstreamVersion,
} from "./runtime-artifact.mjs";
import {
  RUNTIME_KEY_ID_FILE,
  RUNTIME_PRIVATE_KEY_FILE,
  RUNTIME_PUBLIC_KEY_FILE,
  defaultRuntimeKeysDirectory,
  readRuntimeSigningKeys,
} from "./runtime-signing-keys.mjs";

const PLATFORM = process.env.OMP_INSTALLER_ARTIFACT_PLATFORM ?? `${process.platform}-${process.arch}`;
const ARTIFACT_PLATFORM_DIR = resolve(
  process.env.OMP_ARTIFACT_DIR ?? join(REPOSITORY_ROOT, "packages", "runtime-installer", "dist", "artifacts", PLATFORM),
);
export const KEYS_OUT_DIR = join(REPOSITORY_ROOT, "packaging", "runtime-keys");
export const RUNTIME_PAYLOAD_DIR = join(REPOSITORY_ROOT, "packaging", "runtime-payload");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCurrentArtifact() {
  const series = await readPatchSeries();
  const upstreamVersion = await readUpstreamVersion();
  const runtimeVersion = deriveRuntimeVersion(upstreamVersion, series);
  const nested = join(ARTIFACT_PLATFORM_DIR, runtimeVersion);
  if (await exists(join(nested, "runtime-manifest.json"))) {
    return { runtimeVersion, source: nested };
  }
  if (await exists(join(ARTIFACT_PLATFORM_DIR, "runtime-manifest.json"))) {
    const manifest = JSON.parse(await readFile(join(ARTIFACT_PLATFORM_DIR, "runtime-manifest.json"), "utf8"));
    if (manifest.runtimeVersion !== runtimeVersion) {
      throw new Error(
        `Artifact runtimeVersion ${manifest.runtimeVersion} does not match series ${runtimeVersion}`,
      );
    }
    return { runtimeVersion, source: ARTIFACT_PLATFORM_DIR };
  }
  throw new Error(
    `No signed Runtime ${runtimeVersion} under ${ARTIFACT_PLATFORM_DIR}. Run npm run omp:build:host first.`,
  );
}

async function stagePublicKey() {
  let keyId;
  let publicKey;
  const envPath = process.env.OMP_RUNTIME_TRUSTED_PUBLIC_KEY?.trim();
  const envId = process.env.OMP_RUNTIME_SIGNING_KEY_ID?.trim();
  if (envPath !== undefined && envPath.length > 0 && envId !== undefined && envId.length > 0) {
    keyId = envId;
    publicKey = await readFile(envPath);
  } else {
    const local = await readRuntimeSigningKeys(defaultRuntimeKeysDirectory());
    keyId = local.keyId;
    publicKey = local.publicKey;
  }
  if (keyId.trim().length === 0 || publicKey.length === 0) {
    throw new Error("Runtime public verification key is empty");
  }

  await rm(KEYS_OUT_DIR, { recursive: true, force: true });
  await mkdir(KEYS_OUT_DIR, { recursive: true });
  await writeFile(join(KEYS_OUT_DIR, RUNTIME_KEY_ID_FILE), `${keyId.trim()}\n`, { encoding: "utf8" });
  await writeFile(join(KEYS_OUT_DIR, RUNTIME_PUBLIC_KEY_FILE), publicKey);
  if (await exists(join(KEYS_OUT_DIR, RUNTIME_PRIVATE_KEY_FILE))) {
    throw new Error("refusing to pack Runtime private signing key");
  }
  return join(KEYS_OUT_DIR, RUNTIME_PUBLIC_KEY_FILE);
}

async function main() {
  const { runtimeVersion, source } = await resolveCurrentArtifact();
  const destination = join(RUNTIME_PAYLOAD_DIR, runtimeVersion);
  await rm(RUNTIME_PAYLOAD_DIR, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  if (await exists(join(destination, RUNTIME_PRIVATE_KEY_FILE))) {
    throw new Error("refusing to pack Runtime private signing key inside the artifact tree");
  }

  const publicKeyPath = await stagePublicKey();
  console.log(`Installer live Runtime artifact: ${source}`);
  console.log(`Installer staged Runtime: ${destination}`);
  console.log(`Installer public key: ${publicKeyPath}`);
}

await main();
