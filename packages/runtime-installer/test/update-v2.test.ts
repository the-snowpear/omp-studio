import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipSync } from "fflate";
import { createRuntimeArchive, extractRuntimeArchive, RUNTIME_ARCHIVE_FILES, runtimeArchiveFiles, runtimeEntrypointFor, UPDATE_PLATFORMS, updateSigningBytes, verifyUpdateManifest, type UpdateManifest, type UpdateFile } from "../src/index.js";

const pair = generateKeyPairSync("ed25519"), key = pair.publicKey.export({ type: "spki", format: "pem" });
const file = (asset: string): UpdateFile => ({ asset, url: `https://github.com/owner/repo/releases/download/v1/${asset}`, size: 3, sha256: createHash("sha256").update("abc").digest("hex"), sha512: createHash("sha512").update("abc").digest("base64") });
function manifest(): UpdateManifest { return { schema: 2, repo: "owner/repo", platform: "win32-x64", generatedAt: "2026-09-17T00:00:00Z", releaseNotesUrl: "https://github.com/owner/repo/releases/tag/v1", app: { version: "1.0.0", sequence: 1, channel: "stable", minAppVersion: "0.0.0", studioProtocol: { min: 1, max: 1 }, file: file("setup.exe"), blockmap: file("setup.exe.blockmap") } }; }
function envelope(m: UpdateManifest) { return { manifest: m, signature: { algorithm: "ed25519", keyId: "test", value: sign(null, updateSigningBytes(m), pair.privateKey).toString("base64url") } }; }

test("v2 authenticates full identity, channel, artifact and map digests", () => {
  const signed = envelope(manifest());
  assert.equal(verifyUpdateManifest(signed, { test: key }, "owner/repo", "win32-x64").manifest.app?.version, "1.0.0");
  assert.throws(() => verifyUpdateManifest(signed, {}, "owner/repo", "win32-x64"), /Untrusted/);
  assert.throws(() => verifyUpdateManifest(signed, { test: key }, "other/repo", "win32-x64"), /identity/);
  assert.throws(() => verifyUpdateManifest(signed, { test: key }, "owner/repo", "win32-arm64"), /identity/);
  signed.manifest.app!.file.sha256 = "0".repeat(64);
  assert.throws(() => verifyUpdateManifest(signed, { test: key }, "owner/repo", "win32-x64"), /signature/);
});
test("even a signed catalog rejects unsafe URLs and inconsistent protocols", () => {
  const m = manifest(); m.app!.file.url = "https://evil.example/setup.exe";
  assert.throws(() => verifyUpdateManifest(envelope(m), { test: key }, "owner/repo", "win32-x64"), /outside/);
  m.app!.file = file("setup.exe"); m.app!.studioProtocol = { min: 2, max: 1 };
  assert.throws(() => verifyUpdateManifest(envelope(m), { test: key }, "owner/repo", "win32-x64"), /metadata/);
});
async function archiveSource(root: string, platform: string, entrypoint: string): Promise<string> {
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "runtime-manifest.json"), JSON.stringify({ platform, entrypoint }));
  for (const name of ["checksums.json", entrypoint, "runtime-signature.json"]) await writeFile(join(source, name), `fixture:${name}`);
  return source;
}
test("Runtime archive is deterministic and imports exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-archive-")), source = await archiveSource(root, "win32-x64", "omp.exe");
  await createRuntimeArchive(source, join(root, "a.zip"));
  await createRuntimeArchive(source, join(root, "b.zip"));
  assert.deepEqual(await readFile(join(root, "a.zip")), await readFile(join(root, "b.zip")));
  // Golden bytes: the Windows archive layout must never move, or published blockmaps stop matching.
  assert.equal(createHash("sha256").update(await readFile(join(root, "a.zip"))).digest("hex"), "ec4faef8361a16b40d06be8240de2eabdebef0f231739cd5001fce5668e83129");
  await extractRuntimeArchive(join(root, "a.zip"), join(root, "out"));
  for (const name of RUNTIME_ARCHIVE_FILES) assert.deepEqual(await readFile(join(source, name)), await readFile(join(root, "out", name)));
});
test("a macOS Runtime archive carries omp and extracts it executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-archive-darwin-")), source = await archiveSource(root, "darwin-arm64", "omp");
  await createRuntimeArchive(source, join(root, "a.zip"));
  await extractRuntimeArchive(join(root, "a.zip"), join(root, "out"));
  for (const name of runtimeArchiveFiles("omp")) assert.deepEqual(await readFile(join(source, name)), await readFile(join(root, "out", name)));
  if (process.platform !== "win32") assert.equal((await stat(join(root, "out", "omp"))).mode & 0o777, 0o755);
});
test("Runtime archive entrypoint must agree with the manifest platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-archive-mismatch-"));
  const wrong = await archiveSource(root, "darwin-arm64", "omp.exe");
  await assert.rejects(() => createRuntimeArchive(wrong, join(root, "wrong.zip")), /does not match/);
  const manifest = new TextEncoder().encode(JSON.stringify({ platform: "win32-x64", entrypoint: "omp.exe" }));
  const bytes = (name: string) => new TextEncoder().encode(name);
  for (const [name, archive] of [
    ["swapped", zipSync({ "checksums.json": bytes("c"), omp: bytes("x"), "runtime-manifest.json": manifest, "runtime-signature.json": bytes("s") }, { level: 0 })],
    ["unsupported", zipSync({ "checksums.json": bytes("c"), omp: bytes("x"), "runtime-manifest.json": new TextEncoder().encode(JSON.stringify({ platform: "linux-x64", entrypoint: "omp" })), "runtime-signature.json": bytes("s") }, { level: 0 })],
    ["two-entrypoints", zipSync({ "checksums.json": bytes("c"), omp: bytes("x"), "omp.exe": bytes("x"), "runtime-manifest.json": manifest }, { level: 0 })],
    ["finder", zipSync({ ".DS_Store": bytes("d") }, { level: 0 })],
  ] as const) {
    const path = join(root, `${name}.zip`); await writeFile(path, archive);
    await assert.rejects(() => extractRuntimeArchive(path, join(root, name)), /archive/);
  }
});
test("platform table follows the artifact platform", () => {
  assert.equal(runtimeEntrypointFor("win32-x64"), "omp.exe");
  assert.equal(runtimeEntrypointFor("win32-arm64"), "omp.exe");
  assert.equal(runtimeEntrypointFor("darwin-arm64"), "omp");
  assert.throws(() => runtimeEntrypointFor("linux-x64"), /Unsupported/);
  assert.deepEqual([...UPDATE_PLATFORMS], ["win32-x64", "win32-arm64", "darwin-arm64"]);
});
test("a macOS catalog ships the desktop as a zipped app and rejects the Windows installer", () => {
  const m = manifest(); m.platform = "darwin-arm64"; m.app!.file = file("OMP-Studio-1.0.0-macos-arm64.zip"); m.app!.blockmap = file("OMP-Studio-1.0.0-macos-arm64.zip.blockmap");
  m.runtime = { ...m.app!, file: file("OMP-Studio-Runtime-18.0.0-macos-arm64.zip"), blockmap: file("OMP-Studio-Runtime-18.0.0-macos-arm64.zip.blockmap") };
  assert.equal(verifyUpdateManifest(envelope(m), { test: key }, "owner/repo", "darwin-arm64").manifest.platform, "darwin-arm64");
  const exe = manifest(); exe.platform = "darwin-arm64";
  assert.throws(() => verifyUpdateManifest(envelope(exe), { test: key }, "owner/repo", "darwin-arm64"), /metadata/);
  const zip = manifest(); zip.app!.file = file("app.zip"); zip.app!.blockmap = file("app.zip.blockmap");
  assert.throws(() => verifyUpdateManifest(envelope(zip), { test: key }, "owner/repo", "win32-x64"), /metadata/);
  const intel = manifest(); (intel as { platform: string }).platform = "darwin-x64";
  assert.throws(() => verifyUpdateManifest(envelope(intel), { test: key }, "owner/repo", "darwin-x64"), /identity/);
});
test("Runtime archive refuses path traversal, compressed entries and missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-bad-zip-"));
  for (const [name, bytes] of [["traversal", zipSync({ "../omp.exe": new Uint8Array([1]) }, { level: 0 })], ["compressed", zipSync({ "omp.exe": new Uint8Array(512) })], ["missing", zipSync({ "omp.exe": new Uint8Array([1]) }, { level: 0 })]] as const) {
    const path = join(root, `${name}.zip`); await writeFile(path, bytes);
    await assert.rejects(() => extractRuntimeArchive(path, join(root, name)), /archive/);
  }
});
