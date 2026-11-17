// Prepare the Runtime used by the Windows production-preview launcher.
// Its artifact cache, installation and update journal live under outputs/;
// the installed application's Runtime and the user's profile stay separate.
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  createSmokeTestRunner,
  extractRuntimeArchive,
  parseRuntimeInstallationManifest,
  RUNTIME_ARTIFACT_LAYOUT,
  RuntimeInstaller,
  verifySignedArtifact,
} from "@omp-studio/runtime-installer";

import { overlayFiles, overlayHash, overlayRoot } from "./omp-overlay.mjs";
import { PATCHSET_VERSION_FILE, SEAM_EXCLUDED, readPatchsetVersionConstant } from "./omp-seam.mjs";
import { ompSourceDirectory, repositoryRoot, run } from "./omp-tooling.mjs";
import {
  computePatchHashes,
  deriveRuntimeVersion,
  PATCHES_DIRECTORY,
  readPatchSeries,
  readUpstreamPin,
  readUpstreamVersion,
  seriesDigest,
} from "./runtime-artifact.mjs";
import { ensureRuntimeSigningKeys } from "./runtime-signing-keys.mjs";
import { runtimeArchiveAssetName } from "./release-assets.mjs";
import { assertPeArchitecture, assertRuntimeManifestTarget } from "./windows-architecture.mjs";

const PREVIEW_DIRECTORY = join(repositoryRoot, "outputs", "production-preview");
const RELEASE_KEYS_DIRECTORY = join(repositoryRoot, "packaging", "keys");
const REPOSITORY = "the-snowpear/omp-studio";

/** Check the recorded source identity without rewriting an in-progress vendor tree. */
export async function productionPreviewIdentity() {
  const [upstream, series, upstreamVersion] = await Promise.all([
    readUpstreamPin(), readPatchSeries(), readUpstreamVersion(),
  ]);
  const head = run("git", ["-C", ompSourceDirectory, "rev-parse", "HEAD"], { capture: true });
  if (head !== upstream.commit || series.upstreamCommit !== upstream.commit) {
    throw new Error("Runtime source does not match the pinned upstream commit.");
  }
  const digest = seriesDigest({
    overlayHash: await overlayHash(),
    patchHashes: await computePatchHashes(PATCHES_DIRECTORY, series.patches),
  });
  if (digest !== series.patchsetDigest) {
    throw new Error("Runtime overlay or patches changed without updating series.json. Capture the changes with npm run omp:patches:regen before starting production preview.");
  }
  const bridgeSource = await readFile(join(overlayRoot, PATCHSET_VERSION_FILE), "utf8");
  if (readPatchsetVersionConstant(bridgeSource) !== series.patchsetVersion) {
    throw new Error("Runtime Bridge version does not match series.json. Complete the Runtime patch workflow before starting production preview.");
  }
  const ownedFiles = await overlayFiles();
  const ownedSet = new Set(ownedFiles);
  const untracked = run("git", ["-C", ompSourceDirectory, "ls-files", "--others", "--exclude-standard", "-z", "--", "packages/coding-agent/src/studio", "packages/coding-agent/test"], { capture: true, trim: false })
    .split("\0").filter(Boolean);
  const newOverlay = untracked.find(file =>
    (file.startsWith("packages/coding-agent/src/studio/") ||
      file.startsWith("packages/coding-agent/test/") && file.split("/").some(part => part.startsWith("studio-"))) &&
    !ownedSet.has(file));
  if (newOverlay) throw new Error(`Runtime vendor has a new uncaptured overlay file at ${newOverlay}. Capture it before starting production preview.`);
  for (const file of ownedFiles) {
    const source = await readFile(join(overlayRoot, file));
    const applied = await readFile(join(ompSourceDirectory, file)).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!applied || !source.equals(applied)) {
      throw new Error(`Runtime vendor overlay differs at ${file}. Preserve and capture any vendor edits, then apply the overlay before starting production preview.`);
    }
  }
  const expectedFiles = new Map();
  for (const patch of series.patches) {
    try {
      run("git", ["-C", ompSourceDirectory, "apply", "--check", "--reverse", join(PATCHES_DIRECTORY, patch)], { capture: true });
    } catch (error) {
      throw new Error(`Runtime vendor tree does not match ${patch}. Preserve and capture any vendor edits, then apply the patches before starting production preview.`, { cause: error });
    }
    const contents = await readFile(join(PATCHES_DIRECTORY, patch), "utf8");
    for (const block of contents.split(/(?=^diff --git )/mu)) {
      const paths = block.match(/^diff --git a\/(\S+) b\/(\S+)$/mu);
      const index = block.match(/^index [a-f0-9]+\.\.([a-f0-9]+)/mu);
      if (paths && index) expectedFiles.set(paths[2], index[1]);
    }
  }
  const paths = [...expectedFiles].filter(([, hash]) => !/^0+$/u.test(hash)).map(([path]) => path);
  const hashes = spawnSync("git", ["-C", ompSourceDirectory, "hash-object", "--stdin-paths"], {
    input: `${paths.join("\n")}\n`, encoding: "utf8", windowsHide: true,
  });
  if (hashes.status !== 0) throw new Error(`Cannot inspect Runtime vendor files: ${hashes.stderr}`);
  const actualHashes = hashes.stdout.trimEnd().split(/\r?\n/u);
  const changedFile = paths.find((path, index) => !actualHashes[index]?.startsWith(expectedFiles.get(path)));
  if (changedFile) throw new Error(`Runtime vendor source differs at ${changedFile}. Capture the changes before starting production preview.`);
  const modified = run("git", ["-C", ompSourceDirectory, "diff", "HEAD", "--name-only"], { capture: true })
    .split(/\r?\n/u).filter(Boolean);
  const extra = modified.find(path => !expectedFiles.has(path) && !SEAM_EXCLUDED.includes(path));
  if (extra) {
    throw new Error(`Runtime vendor source has an uncaptured change at ${extra}. Capture it before starting production preview.`);
  }
  return {
    runtimeVersion: deriveRuntimeVersion(upstreamVersion, series),
    upstreamVersion,
    upstreamCommit: upstream.commit,
    patchsetVersion: series.patchsetVersion,
    patchsetDigest: digest,
    platform: `${process.platform}-${process.arch}`,
  };
}

async function trustedKeys(previewDirectory) {
  const table = JSON.parse(await readFile(join(RELEASE_KEYS_DIRECTORY, "trusted-keys.json"), "utf8"));
  const keys = {};
  for (const [id, file] of Object.entries(table.keys)) keys[id] = await readFile(join(RELEASE_KEYS_DIRECTORY, file));
  const localDirectory = join(previewDirectory, "signing-keys");
  try {
    const id = (await readFile(join(localDirectory, "key-id.txt"), "utf8")).trim();
    const key = await readFile(join(localDirectory, "trusted-public.pem"));
    if (id && !keys[id]) keys[id] = key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return keys;
}

/** Only a signed artifact for this source identity may become the preview Runtime. */
export async function matchingPreviewArtifact(directory, identity, keys) {
  const verified = await verifySignedArtifact({
    directory,
    layout: RUNTIME_ARTIFACT_LAYOUT,
    parseManifest: parseRuntimeInstallationManifest,
    requireCovered: manifest => ["runtime-manifest.json", manifest.entrypoint],
    trustedKeys: keys,
  });
  const manifest = verified.manifest;
  assertRuntimeManifestTarget(manifest, identity.platform.slice("win32-".length), identity.runtimeVersion);
  if (manifest.upstreamVersion !== identity.upstreamVersion || manifest.upstreamCommit !== identity.upstreamCommit ||
      manifest.patchsetVersion !== identity.patchsetVersion || manifest.channel !== "stable") {
    throw new Error("Runtime artifact does not match the current source identity.");
  }
  assertPeArchitecture(join(directory, manifest.entrypoint), identity.platform.slice("win32-".length));
  const signature = JSON.parse(await readFile(join(directory, "runtime-signature.json"), "utf8"));
  return { directory, manifest, checksums: verified.checksums, keyId: signature.keyId, publicKey: keys[signature.keyId] };
}

async function matchingReleaseTags(identity) {
  const tags = run("git", ["-C", repositoryRoot, "tag", "--list", "v*", "--sort=-v:refname"], { capture: true })
    .split(/\r?\n/u).filter(Boolean);
  return tags.filter(tag => {
    try {
      const series = JSON.parse(run("git", ["-C", repositoryRoot, "show", `${tag}:omp-patch/patches/series.json`], { capture: true }));
      return series.upstreamCommit === identity.upstreamCommit && series.patchsetVersion === identity.patchsetVersion &&
        series.patchsetDigest === identity.patchsetDigest;
    } catch {
      return false;
    }
  });
}

async function candidateDirectories(identity, previewDirectory) {
  const cache = join(previewDirectory, "artifacts");
  let cached = [];
  try {
    cached = (await readdir(cache, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith("runtime-"))
      .map(entry => join(cache, entry.name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return cached;
}

async function findArtifact(identity, keys, previewDirectory) {
  for (const cached of await candidateDirectories(identity, previewDirectory)) {
    try {
      const recorded = JSON.parse(await readFile(join(cached, "source-identity.json"), "utf8"));
      if (JSON.stringify(recorded) !== JSON.stringify(identity)) continue;
      const directory = join(cached, identity.runtimeVersion);
      return await matchingPreviewArtifact(directory, identity, keys);
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`[preview] Cannot reuse ${cached}: ${error.message}`);
    }
  }
  return undefined;
}

async function releaseResponse(identity, tags, fetcher) {
  const asset = runtimeArchiveAssetName(identity.runtimeVersion, identity.platform);
  for (const tag of tags) {
    const response = await fetcher(`https://github.com/${REPOSITORY}/releases/download/${tag}/${asset}`, {
      headers: { "User-Agent": "OMP-Studio-production-preview" }, signal: AbortSignal.timeout(20 * 60_000),
    });
    if (response.ok) return response;
    if (response.status !== 404) throw new Error(`Runtime download returned HTTP ${response.status}`);
  }
  return undefined;
}

async function downloadArtifact(identity, keys, previewDirectory, tags, fetcher) {
  const response = await releaseResponse(identity, tags, fetcher);
  if (!response) return undefined;
  const cache = join(previewDirectory, "artifacts");
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, "runtime-"));
  const archive = join(temporary, "download.zip");
  const artifact = join(temporary, identity.runtimeVersion);
  console.log(`[preview] Downloading signed Runtime ${identity.runtimeVersion}...`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    await extractRuntimeArchive(archive, artifact);
    const verified = await matchingPreviewArtifact(artifact, identity, keys);
    await writeFile(join(temporary, "source-identity.json"), JSON.stringify(identity));
    return verified;
  } finally {
    await unlink(archive).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

async function buildArtifact(identity, previewDirectory, npmCli) {
  const keys = await ensureRuntimeSigningKeys(join(previewDirectory, "signing-keys"));
  const cache = join(previewDirectory, "artifacts");
  await mkdir(cache, { recursive: true });
  const directory = join(await mkdtemp(join(cache, "runtime-")), identity.runtimeVersion);
  console.log(`[preview] Building Runtime ${identity.runtimeVersion}; the first native build may take a while...`);
  run(process.execPath, [npmCli, "run", "omp:build:host", "--", "--skip-build"], {
    env: {
      ...process.env,
      OMP_ARTIFACT_DIR: directory,
      OMP_RUNTIME_CHANNEL: "stable",
      OMP_RUNTIME_SIGNING_KEY: keys.privateKeyPath,
      OMP_RUNTIME_SIGNING_KEY_ID: keys.keyId,
    },
  });
  const verified = await matchingPreviewArtifact(directory, identity, { [keys.keyId]: keys.publicKey });
  await writeFile(join(directory, "..", "source-identity.json"), JSON.stringify(identity));
  return verified;
}

/** Install and activate the exact artifact in a store belonging only to this preview. */
export async function activatePreviewArtifact(artifact, previewDirectory, selfCheck = createSmokeTestRunner({ timeoutMs: 240_000 })) {
  const checksum = artifact.checksums.files[artifact.manifest.entrypoint];
  const stateDirectory = join(previewDirectory, "state", `${artifact.manifest.runtimeVersion}-${checksum.slice(0, 16)}`);
  const runtimeRoot = join(stateDirectory, "runtimes");
  const installer = new RuntimeInstaller(runtimeRoot, { trustedKeys: { [artifact.keyId]: artifact.publicKey } });
  const current = await installer.currentManifest().catch(() => undefined);
  if (current?.manifest.runtimeVersion !== artifact.manifest.runtimeVersion || current.entrypointSha256 !== checksum) {
    console.log(`[preview] Installing and checking Runtime ${artifact.manifest.runtimeVersion}...`);
    await installer.install(artifact.directory);
    await installer.activate(artifact.manifest.runtimeVersion, { selfCheck });
  }
  const active = await installer.currentManifest();
  if (active?.manifest.runtimeVersion !== artifact.manifest.runtimeVersion || active.entrypointSha256 !== checksum) {
    throw new Error("The preview Runtime could not be activated for the current source.");
  }
  return stateDirectory;
}

/** Reproduce the packaged Runtime layout without staging any private keys. */
export async function stageProductionPreviewRuntime(runtime, electronDirectory) {
  await cp(runtime.directory, join(electronDirectory, "runtime", "versions", runtime.manifest.runtimeVersion), { recursive: true });
  const directory = join(electronDirectory, "runtime-keys");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "key-id.txt"), `${runtime.keyId}\n`);
  await writeFile(join(directory, "trusted-public.pem"), runtime.publicKey);
  const keyFiles = {};
  let index = 0;
  for (const [id, publicKey] of Object.entries(runtime.keys)) {
    const file = `key-${index++}.pem`;
    keyFiles[id] = file;
    await writeFile(join(directory, file), publicKey);
  }
  await writeFile(join(directory, "trusted-keys.json"), JSON.stringify({ schema: 1, activeKeyId: runtime.keyId, keys: keyFiles }, null, 2));
}

export async function prepareProductionPreviewRuntime({ npmCli, fetcher = fetch, previewDirectory = PREVIEW_DIRECTORY } = {}) {
  const identity = await productionPreviewIdentity();
  if (!identity.platform.startsWith("win32-")) throw new Error("Production preview Runtime preparation currently supports Windows.");
  console.log(`[preview] Required Runtime: ${identity.runtimeVersion} (${identity.platform})`);
  let keys = await trustedKeys(previewDirectory);
  let artifact = await findArtifact(identity, keys, previewDirectory);
  if (artifact) console.log(`[preview] Reusing signed Runtime from ${artifact.directory}`);
  if (!artifact) {
    const tags = await matchingReleaseTags(identity);
    const table = JSON.parse(await readFile(join(RELEASE_KEYS_DIRECTORY, "trusted-keys.json"), "utf8"));
    const releaseKeys = Object.fromEntries(Object.keys(table.keys).map(id => [id, keys[id]]));
    // An official artifact is reusable only when a release tag records the
    // same source digest. Locally built artifacts are cached with that digest.
    if (tags.length) {
      const localCandidates = [
        join(repositoryRoot, "packages", "runtime-installer", "dist", "artifacts", identity.platform, identity.runtimeVersion),
        join(repositoryRoot, "packaging", "runtime-payload", identity.runtimeVersion),
      ];
      for (const directory of localCandidates) {
        try { artifact = await matchingPreviewArtifact(directory, identity, releaseKeys); break; }
        catch (error) { if (error.code !== "ENOENT") console.warn(`[preview] Cannot reuse ${directory}: ${error.message}`); }
      }
    }
    try {
      if (!artifact && tags.length) artifact = await downloadArtifact(identity, releaseKeys, previewDirectory, tags, fetcher);
    } catch (error) {
      console.warn(`[preview] Could not reuse a published Runtime: ${error.message}`);
    }
  }
  if (!artifact) {
    artifact = await buildArtifact(identity, previewDirectory, npmCli);
    keys = await trustedKeys(previewDirectory);
  }
  const stateDirectory = await activatePreviewArtifact(artifact, previewDirectory);
  console.log(`[preview] Active Runtime ${identity.runtimeVersion}; isolated state: ${stateDirectory}`);
  return { ...artifact, keys, stateDirectory };
}
