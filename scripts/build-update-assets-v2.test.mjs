import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildUpdateAssetsV2, buildMigrationIndex } from "./build-update-assets-v2.mjs";
import { verifyUpdateAssets } from "./verify-update-assets-v2.mjs";
import { verifyUpdateManifest } from "@omp-studio/runtime-installer";
import { parseUpdateIndex } from "../apps/desktop/dist/src/update-index.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "test", keys = { test: publicKey.export({ type: "spki", format: "pem" }) };
const hash = b => createHash("sha256").update(b).digest("hex");
async function fixture(channel = "stable", runtimeVersion = "18.0.0-studio.1", exeBytes = "signed-runtime") {
  const root = await mkdtemp(join(tmpdir(), "omp-v2-release-")), runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir);
  const exe = Buffer.from(exeBytes), manifest = Buffer.from(JSON.stringify({ runtimeVersion, upstreamVersion: "18.0.0", upstreamCommit: "a".repeat(40), patchsetVersion: "studio.1", studioProtocol: { min: 1, max: 1 }, profile: "full-parity-v1", capabilityHash: "fixture", commandManifestHash: "fixture", platform: "win32-x64", entrypoint: "omp.exe", channel }));
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

test("an old desktop tag cannot shadow a newer published desktop", async () => {
  const options = await fixture();
  const published = await buildUpdateAssetsV2(options);
  const previous = JSON.parse(await readFile(join(published.out, "updates-win32-x64.json"), "utf8"));
  const older = await fixture();
  // Consumers only follow the highest app sequence, so re-tagging an old desktop would hide 1.0.0.
  await assert.rejects(() => buildUpdateAssetsV2({ ...older, previous: [previous], appVersion: "0.9.0" }), /would hide newer published app 1\.0\.0/);
  await assert.rejects(() => buildUpdateAssetsV2({ ...older, previous: [previous], appVersion: "not-semver" }), /Cannot order app release versions/);
  // Republishing the same desktop version stays allowed and just mints a new sequence.
  const republished = await buildUpdateAssetsV2({ ...older, previous: [previous], out: join(older.root, "republish") });
  assert.equal(republished.manifest.app.sequence, 2);
});

test("a desktop republish rejects a reused Runtime version with different bytes or channel", async () => {
  const published = await buildUpdateAssetsV2(await fixture());
  const previous = JSON.parse(await readFile(join(published.out, "updates-win32-x64.json"), "utf8"));
  const altered = await fixture("stable", "18.0.0-studio.1", "tampered-runtime");
  await assert.rejects(() => buildUpdateAssetsV2({ ...altered, previous: [previous] }), /different bytes or channel/);
  const otherChannel = await fixture("canary", "18.0.0-studio.1");
  await assert.rejects(() => buildUpdateAssetsV2({ ...otherChannel, previous: [previous] }), /different bytes or channel/);
});

async function darwinFixture(channel = "stable") {
  const root = await mkdtemp(join(tmpdir(), "omp-v2-release-mac-")), runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir);
  const exe = Buffer.from("signed-darwin-runtime"), manifest = Buffer.from(JSON.stringify({ runtimeVersion: "18.0.0-studio.1", upstreamVersion: "18.0.0", upstreamCommit: "a".repeat(40), patchsetVersion: "studio.1", studioProtocol: { min: 1, max: 1 }, profile: "full-parity-v1", capabilityHash: "fixture", commandManifestHash: "fixture", platform: "darwin-arm64", entrypoint: "omp", channel }));
  const sums = Buffer.from(JSON.stringify({ algorithm: "sha256", files: { omp: hash(exe), "runtime-manifest.json": hash(manifest) } }));
  const payload = Buffer.concat([manifest, Buffer.from("\0"), sums]);
  for (const [name, bytes] of [["omp", exe], ["runtime-manifest.json", manifest], ["checksums.json", sums], ["runtime-signature.json", JSON.stringify({ algorithm: "ed25519", keyId, payloadSha256: hash(payload), signature: sign(null, payload, signingKey).toString("base64url") })]]) await writeFile(join(runtimeDir, name), bytes);
  const installer = join(root, "outputs", "installer-mac");
  await mkdir(installer, { recursive: true });
  await writeFile(join(installer, "OMP-Studio-1.0.0-macos-arm64.zip"), "app-zip-fixture");
  await writeFile(join(installer, "OMP-Studio-1.0.0-macos-arm64.dmg"), "dmg-fixture");
  return { root, runtimeDir, platform: "darwin-arm64", appVersion: "1.0.0", repo: "owner/repo", keys, signingKey, keyId };
}

test("a macOS desktop release: the update zip in the catalog, the signed dmg beside it, no v1 index", async () => {
  const options = await darwinFixture();
  const { out, manifest, notes } = await buildUpdateAssetsV2({ ...options, previousIndex: join(options.root, "never-read.json") });
  assert.equal(out, join(options.root, "outputs", "release", "darwin-arm64"));
  assert.equal(manifest.platform, "darwin-arm64");
  assert.equal(manifest.app.file.asset, "OMP-Studio-1.0.0-macos-arm64.zip");
  assert.equal(manifest.runtime.file.asset, "OMP-Studio-Runtime-18.0.0-studio.1-macos-arm64.zip");
  assert.equal(manifest.firstInstall.url, "https://github.com/owner/repo/releases/download/v1.0.0/OMP-Studio-1.0.0-macos-arm64.dmg");
  assert.deepEqual((await readdir(out)).sort(), [
    "OMP-Studio-1.0.0-macos-arm64.dmg",
    "OMP-Studio-1.0.0-macos-arm64.zip",
    "OMP-Studio-1.0.0-macos-arm64.zip.blockmap",
    "OMP-Studio-Runtime-18.0.0-studio.1-macos-arm64.zip",
    "OMP-Studio-Runtime-18.0.0-studio.1-macos-arm64.zip.blockmap",
    "release-notes.md",
    "updates-darwin-arm64.json",
  ]);
  assert.equal((await verifyUpdateAssets(out, keys, "owner/repo", "darwin-arm64")).app.version, "1.0.0");
  // The desktop journals the verified envelope and verifies it again on every start.
  const once = verifyUpdateManifest(JSON.parse(await readFile(join(out, "updates-darwin-arm64.json"), "utf8")), keys, "owner/repo", "darwin-arm64");
  assert.deepEqual(verifyUpdateManifest(JSON.parse(JSON.stringify(once)), keys, "owner/repo", "darwin-arm64"), once);
  assert.equal(once.manifest.firstInstall.asset, "OMP-Studio-1.0.0-macos-arm64.dmg");
  assert.match(notes, /下载 dmg\]\(https:\/\/github\.com\/owner\/repo\/releases\/download\/v1\.0\.0\/OMP-Studio-1\.0\.0-macos-arm64\.dmg\)/u);
  assert.match(notes, /仍要打开/u);
  assert.doesNotMatch(notes, /update-index/u);

  await writeFile(join(out, "OMP-Studio-1.0.0-macos-arm64.dmg"), "tampered");
  await assert.rejects(() => verifyUpdateAssets(out, keys, "owner/repo", "darwin-arm64"), /mismatch: OMP-Studio-1\.0\.0-macos-arm64\.dmg/u);
  const { rm } = await import("node:fs/promises");
  await rm(join(out, "OMP-Studio-1.0.0-macos-arm64.dmg"));
  await assert.rejects(() => verifyUpdateAssets(out, keys, "owner/repo", "darwin-arm64"), /ENOENT/u);
});

test("a Runtime-only macOS release carries no dmg", async () => {
  const options = await darwinFixture("canary");
  const { out, manifest } = await buildUpdateAssetsV2({ ...options, runtimeOnly: true });
  assert.equal(manifest.app, undefined);
  assert.equal(manifest.firstInstall, undefined);
  assert.equal((await verifyUpdateAssets(out, keys, "owner/repo", "darwin-arm64")).runtime.channel, "canary");
});
