import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { activatePreviewArtifact, matchingPreviewArtifact, stageProductionPreviewRuntime } from "./production-preview-runtime.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ type: "spki", format: "pem" });
const identity = {
  runtimeVersion: "18.20.2-studio.5",
  upstreamVersion: "18.20.2",
  upstreamCommit: "7c49c11aa5bbaf3f418406583096168ad5b8c6dc",
  patchsetVersion: "studio.5",
  platform: "win32-x64",
};
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function artifact(root, name, version = identity.runtimeVersion, marker = 0) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const executable = Buffer.alloc(128);
  executable.write("MZ");
  executable.writeUInt32LE(64, 60);
  executable.write("PE\0\0", 64, "binary");
  executable.writeUInt16LE(0x8664, 68);
  executable[100] = marker;
  const manifest = JSON.stringify({
    runtimeVersion: version,
    upstreamVersion: identity.upstreamVersion,
    upstreamCommit: identity.upstreamCommit,
    patchsetVersion: identity.patchsetVersion,
    studioProtocol: { min: 1, max: 1 },
    profile: "limited",
    capabilityHash: "fixture",
    commandManifestHash: "fixture",
    platform: identity.platform,
    entrypoint: "omp.exe",
    channel: "stable",
  });
  const checksums = JSON.stringify({ algorithm: "sha256", files: { "omp.exe": sha256(executable), "runtime-manifest.json": sha256(manifest) } });
  const payload = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  await Promise.all([
    writeFile(join(directory, "omp.exe"), executable),
    writeFile(join(directory, "runtime-manifest.json"), manifest),
    writeFile(join(directory, "checksums.json"), checksums),
    writeFile(join(directory, "runtime-signature.json"), JSON.stringify({ algorithm: "ed25519", keyId: "test-key", payloadSha256: sha256(payload), signature: sign(null, payload, privateKey).toString("base64url") })),
  ]);
  return directory;
}

test("production preview accepts only an intact signed Runtime for the required source version", async t => {
  const root = await mkdtemp(join(tmpdir(), "omp-production-preview-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = await artifact(root, "valid");
  const stale = await artifact(root, "stale", "18.19.0-studio.12");
  const trusted = { "test-key": key };
  assert.equal((await matchingPreviewArtifact(valid, identity, trusted)).manifest.runtimeVersion, identity.runtimeVersion);
  await assert.rejects(matchingPreviewArtifact(stale, identity, trusted), /does not match series/);
  await writeFile(join(valid, "omp.exe"), "changed after signing");
  await assert.rejects(matchingPreviewArtifact(valid, identity, trusted), /Checksum mismatch/);
});

test("production preview activates separately and reuses only matching Runtime bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "omp-production-preview-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await matchingPreviewArtifact(await artifact(root, "first", identity.runtimeVersion, 1), identity, { "test-key": key });
  const second = await matchingPreviewArtifact(await artifact(root, "second", identity.runtimeVersion, 2), identity, { "test-key": key });
  let checks = 0;
  const selfCheck = { run: async () => { checks++; } };
  const preview = join(root, "preview");
  const firstState = await activatePreviewArtifact(first, preview, selfCheck);
  assert.equal(await activatePreviewArtifact(first, preview, selfCheck), firstState);
  assert.equal(checks, 1, "a matching active Runtime is reused without another self-check");
  const secondState = await activatePreviewArtifact(second, preview, selfCheck);
  assert.notEqual(secondState, firstState, "different bytes never replace the first installation");
  assert.equal(checks, 2);
  const record = JSON.parse(await readFile(join(firstState, "runtimes", "current.json"), "utf8"));
  assert.equal(record.runtimeVersion, identity.runtimeVersion);
});

test("production preview stages the verified Runtime and public keys beside Electron", async t => {
  const root = await mkdtemp(join(tmpdir(), "omp-production-preview-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const verified = await matchingPreviewArtifact(await artifact(root, "source"), identity, { "test-key": key });
  const electron = join(root, "electron");
  await stageProductionPreviewRuntime({ ...verified, keys: { "test-key": key } }, electron);
  const staged = await matchingPreviewArtifact(join(electron, "runtime", "versions", identity.runtimeVersion), identity, { "test-key": key });
  assert.equal(staged.manifest.runtimeVersion, identity.runtimeVersion);
  const table = JSON.parse(await readFile(join(electron, "runtime-keys", "trusted-keys.json"), "utf8"));
  assert.equal(await readFile(join(electron, "runtime-keys", table.keys["test-key"]), "utf8"), key.toString());
});
