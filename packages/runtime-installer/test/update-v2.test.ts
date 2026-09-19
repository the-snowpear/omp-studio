import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipSync } from "fflate";
import { createRuntimeArchive, extractRuntimeArchive, RUNTIME_ARCHIVE_FILES, updateSigningBytes, verifyUpdateManifest, type UpdateManifest, type UpdateFile } from "../src/index.js";

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
test("Runtime archive is deterministic and imports exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-archive-")), source = join(root, "source");
  await mkdir(source);
  for (const name of RUNTIME_ARCHIVE_FILES) await writeFile(join(source, name), `fixture:${name}`);
  await createRuntimeArchive(source, join(root, "a.zip"));
  await createRuntimeArchive(source, join(root, "b.zip"));
  assert.deepEqual(await readFile(join(root, "a.zip")), await readFile(join(root, "b.zip")));
  await extractRuntimeArchive(join(root, "a.zip"), join(root, "out"));
  for (const name of RUNTIME_ARCHIVE_FILES) assert.deepEqual(await readFile(join(source, name)), await readFile(join(root, "out", name)));
});
test("Runtime archive refuses path traversal, compressed entries and missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-bad-zip-"));
  for (const [name, bytes] of [["traversal", zipSync({ "../omp.exe": new Uint8Array([1]) }, { level: 0 })], ["compressed", zipSync({ "omp.exe": new Uint8Array(512) })], ["missing", zipSync({ "omp.exe": new Uint8Array([1]) }, { level: 0 })]] as const) {
    const path = join(root, `${name}.zip`); await writeFile(path, bytes);
    await assert.rejects(() => extractRuntimeArchive(path, join(root, name)), /archive/);
  }
});
