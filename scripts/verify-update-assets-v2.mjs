import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRuntimeArchive, verifyUpdateManifest, verifySignedArtifact, RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest, createTrustedKeyVerifier, parseRuntimeSignatureManifest } from "@omp-studio/runtime-installer";
import { releaseKeys } from "./build-update-assets-v2.mjs";
import { containsPrivateMaterial } from "./p5-secret-scan.mjs";
import { MAC_TARGET_PLATFORM, legacyIndexName, releaseOutputDirectory, releaseTargetsDarwin } from "./release-assets.mjs";

function sameBytes(bytes, file) {
  return bytes.length === file.size && createHash("sha256").update(bytes).digest("hex") === file.sha256 && createHash("sha512").update(bytes).digest("base64") === file.sha512;
}

export async function verifyUpdateAssets(directory, keys, repo, platform) {
  const raw = JSON.parse(await readFile(join(directory, `updates-${platform}.json`), "utf8"));
  const envelope = verifyUpdateManifest(raw, keys, repo, platform);
  const expected = new Set([`updates-${platform}.json`, "release-notes.md"]);
  for (const kind of ["app", "runtime"]) {
    const component = envelope.manifest[kind];
    if (!component) continue;
    for (const file of [component.file, component.blockmap]) {
      expected.add(file.asset);
      const bytes = await readFile(join(directory, file.asset));
      if (!sameBytes(bytes, file)) throw new Error(`Release artifact mismatch: ${file.asset}`);
    }
  }
  // The macOS dmg is for people, not the updater; its digest is signed with the catalog.
  const firstInstall = raw.manifest?.firstInstall;
  if (firstInstall !== undefined) {
    const app = envelope.manifest.app;
    const release = app?.file.url.slice(0, app.file.url.lastIndexOf("/") + 1);
    if (!app || typeof firstInstall.asset !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.dmg$/.test(firstInstall.asset) || firstInstall.url !== `${release}${firstInstall.asset}`) throw new Error("Invalid first-install asset");
    if (!sameBytes(await readFile(join(directory, firstInstall.asset)), firstInstall)) throw new Error(`Release artifact mismatch: ${firstInstall.asset}`);
    expected.add(firstInstall.asset);
  } else if (platform.startsWith("darwin-") && envelope.manifest.app) {
    throw new Error("A macOS desktop release needs its first-install dmg");
  }
  const runtime = envelope.manifest.runtime;
  if (runtime) {
    const temp = await mkdtemp(join(tmpdir(), "omp-release-audit-"));
    try {
      await extractRuntimeArchive(join(directory, runtime.file.asset), temp);
      const verified = await verifySignedArtifact({ directory: temp, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: m => ["runtime-manifest.json", m.entrypoint], trustedKeys: keys });
      if (verified.manifest.runtimeVersion !== runtime.version || verified.manifest.platform !== platform || verified.manifest.channel !== runtime.channel) throw new Error("Runtime release identity mismatch");
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  const names = await readdir(directory);
  const legacy = legacyIndexName(platform);
  if (legacy !== undefined && names.includes(`${legacy}.json`)) {
    expected.add(`${legacy}.json`); expected.add(`${legacy}.sig.json`);
    const payload = await readFile(join(directory, `${legacy}.json`));
    const sig = parseRuntimeSignatureManifest(JSON.parse(await readFile(join(directory, `${legacy}.sig.json`), "utf8")));
    if (sig.payloadSha256 !== createHash("sha256").update(payload).digest("hex") || !createTrustedKeyVerifier(keys).verify(sig, payload)) throw new Error("Migration index signature invalid");
  }
  for (const name of names) {
    if (!expected.has(name)) throw new Error(`Unexpected public release file: ${name}`);
    if (name.endsWith(".json") && containsPrivateMaterial(await readFile(join(directory, name), "utf8"))) throw new Error(`Private material in ${name}`);
  }
  return envelope.manifest;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = resolve("."), platform = releaseTargetsDarwin() ? MAC_TARGET_PLATFORM : `win32-${process.env.OMP_TARGET_ARCH ?? "x64"}`;
  await verifyUpdateAssets(process.argv[2] ?? releaseOutputDirectory(root, platform), await releaseKeys(root), process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio", platform);
  console.log("Signed release assets verified");
}
