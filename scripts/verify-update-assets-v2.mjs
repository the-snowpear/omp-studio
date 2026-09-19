import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRuntimeArchive, verifyUpdateManifest, verifySignedArtifact, RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest, createTrustedKeyVerifier, parseRuntimeSignatureManifest } from "@omp-studio/runtime-installer";
import { releaseKeys } from "./build-update-assets-v2.mjs";
import { containsPrivateMaterial } from "./p5-secret-scan.mjs";

export async function verifyUpdateAssets(directory, keys, repo, platform) {
  const envelope = verifyUpdateManifest(JSON.parse(await readFile(join(directory, `updates-${platform}.json`), "utf8")), keys, repo, platform);
  const expected = new Set([`updates-${platform}.json`, "release-notes.md"]);
  for (const kind of ["app", "runtime"]) {
    const component = envelope.manifest[kind];
    if (!component) continue;
    for (const file of [component.file, component.blockmap]) {
      expected.add(file.asset);
      const bytes = await readFile(join(directory, file.asset));
      if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256 || createHash("sha512").update(bytes).digest("base64") !== file.sha512) throw new Error(`Release artifact mismatch: ${file.asset}`);
    }
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
  const legacy = platform === "win32-x64" ? "update-index" : `update-index-${platform}`;
  if (names.includes(`${legacy}.json`)) {
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
  const root = resolve("."), arch = process.env.OMP_TARGET_ARCH ?? "x64";
  await verifyUpdateAssets(process.argv[2] ?? join(root, "outputs/release", arch), await releaseKeys(root), process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio", `win32-${arch}`);
  console.log("Signed release assets verified");
}
