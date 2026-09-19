import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildUpdateAssetsV2, buildMigrationIndex } from "./build-update-assets-v2.mjs";
import { verifyUpdateAssets } from "./verify-update-assets-v2.mjs";
import { parseUpdateIndex } from "../apps/desktop/dist/src/update-index.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "test", keys = { test: publicKey.export({ type: "spki", format: "pem" }) };
const hash = b => createHash("sha256").update(b).digest("hex");
async function fixture(channel = "stable", runtimeVersion = "18.0.0-studio.1") {
  const root = await mkdtemp(join(tmpdir(), "omp-v2-release-")), runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir);
  const exe = Buffer.from("signed-runtime"), manifest = Buffer.from(JSON.stringify({ runtimeVersion, upstreamVersion: "18.0.0", upstreamCommit: "a".repeat(40), patchsetVersion: "studio.1", studioProtocol: { min: 1, max: 1 }, profile: "full-parity-v1", capabilityHash: "fixture", commandManifestHash: "fixture", platform: "win32-x64", entrypoint: "omp.exe", channel }));
  const sums = Buffer.from(JSON.stringify({ algorithm: "sha256", files: { "omp.exe": hash(exe), "runtime-manifest.json": hash(manifest) } }));
  const payload = Buffer.concat([manifest, Buffer.from("\0"), sums]);
  for (const [name, bytes] of [["omp.exe", exe], ["runtime-manifest.json", manifest], ["checksums.json", sums], ["runtime-signature.json", JSON.stringify({ algorithm: "ed25519", keyId, payloadSha256: hash(payload), signature: sign(null, payload, signingKey).toString("base64url") })]]) await writeFile(join(runtimeDir, name), bytes);
  const setupPath = join(root, "OMP-Studio-Setup-1.0.0-windows-x64.exe"); await writeFile(setupPath, "setup-fixture");
  return { root, runtimeDir, setupPath, arch: "x64", appVersion: "1.0.0", repo: "owner/repo", keys, signingKey, keyId };
}
test("v2 desktop publishes only documented artifacts and verifies every byte", async () => {
  const options = await fixture(); const { out, manifest } = await buildUpdateAssetsV2(options);
  assert.equal((await readdir(out)).length, 6);
  assert.equal((await verifyUpdateAssets(out, keys, "owner/repo", "win32-x64")).app.version, "1.0.0");
  await writeFile(join(out, manifest.runtime.file.asset), "tampered");
  await assert.rejects(() => verifyUpdateAssets(out, keys, "owner/repo", "win32-x64"), /mismatch/);
});
test("Runtime-only release has no installer and uses independent tag/sequence", async () => {
  const options = await fixture("canary");
  const first = await buildUpdateAssetsV2({ ...options, runtimeOnly: true });
  assert.equal(first.manifest.app, undefined);
  assert.ok(first.manifest.runtime.file.url.includes("/runtime-v18.0.0-studio.1/"));
  const previous = JSON.parse(await readFile(join(first.out, "updates-win32-x64.json"), "utf8"));
  const second = await buildUpdateAssetsV2({ ...options, runtimeOnly: true, previous: [previous], out: join(options.root, "second") });
  assert.equal(second.manifest.runtime.sequence, 2);
  assert.equal(first.manifest.runtime.file.sha256, second.manifest.runtime.file.sha256);
});
test("legacy migration feed is readable by v1 and remains immutable after first migration", async () => {
  const options = await fixture(), result = await buildUpdateAssetsV2(options);
  const old = { schema: 1, sequence: 5, generatedAt: "2026-09-17T00:00:00Z", repo: "owner/repo", app: { version: "0.1.5", setup: result.manifest.app.file }, runtime: { runtimeVersion: "18.0.0-studio.1", channel: "stable", platform: "win32-x64", entrypoint: "omp.exe", minAppVersion: "0.1.5", studioProtocol: { min: 1, max: 1 }, files: ["omp.exe", "runtime-manifest.json", "checksums.json", "runtime-signature.json"].map(name => ({ name, url: `https://github.com/owner/repo/releases/download/v0.1.5/${name}`, size: 1, sha256: "a".repeat(64) })) } };
  const bytes = Buffer.from(JSON.stringify(old)), previousPath = join(options.root, "update-index.json");
  await writeFile(previousPath, bytes);
  await writeFile(join(options.root, "update-index.sig.json"), JSON.stringify({ algorithm: "ed25519", keyId, payloadSha256: hash(bytes), signature: sign(null, bytes, signingKey).toString("base64url") }));
  await buildMigrationIndex({ previousPath, out: result.out, arch: "x64", manifest: result.manifest, keys, signingKey, keyId });
  const migrated = await readFile(join(result.out, "update-index.json"));
  assert.equal(parseUpdateIndex(JSON.parse(migrated)).app.version, "1.0.0");
  const next = join(options.root, "later"); await mkdir(next);
  await buildMigrationIndex({ previousPath: join(result.out, "update-index.json"), out: next, arch: "x64", manifest: { ...result.manifest, app: { ...result.manifest.app, version: "2.0.0" } }, keys, signingKey, keyId });
  assert.deepEqual(await readFile(join(next, "update-index.json")), migrated);
});

test("a desktop cannot promote an older seed over an independent Runtime release", async () => {
  const newer = await fixture("stable", "18.0.0-studio.2");
  const published = await buildUpdateAssetsV2({ ...newer, runtimeOnly: true });
  const previous = JSON.parse(await readFile(join(published.out, "updates-win32-x64.json"), "utf8"));
  const older = await fixture();
  await assert.rejects(() => buildUpdateAssetsV2({ ...older, previous: [previous] }), /would hide newer published Runtime/);
  // A new desktop may reuse the latest signed Runtime; channel history is independent.
  const reused = await buildUpdateAssetsV2({ ...newer, previous: [previous], out: join(newer.root, "desktop") });
  assert.equal(reused.manifest.runtime.version, previous.manifest.runtime.version);
  const canary = await fixture("canary", "19.0.0-studio.1");
  const canaryRelease = await buildUpdateAssetsV2({ ...canary, runtimeOnly: true });
  const canaryEnvelope = JSON.parse(await readFile(join(canaryRelease.out, "updates-win32-x64.json"), "utf8"));
  await buildUpdateAssetsV2({ ...older, previous: [canaryEnvelope] });
});
