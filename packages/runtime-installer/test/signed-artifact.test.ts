import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSafeVersion,
  installVerifiedArtifact,
  parseRuntimeInstallationManifest,
  RUNTIME_ARTIFACT_LAYOUT,
  verifySignedArtifact,
  writeJsonAtomic,
} from "../src/index.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });
const trustedKeys = { "test-key": trustedPublicKey };

async function writeSignature(
  directory: string,
  manifest: string,
  checksums: string,
  overrides: { keyId?: string; signature?: string; payloadSha256?: string } = {},
): Promise<void> {
  const payload = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  await writeFile(
    join(directory, "runtime-signature.json"),
    `${JSON.stringify({
      algorithm: "ed25519",
      keyId: overrides.keyId ?? "test-key",
      payloadSha256: overrides.payloadSha256 ?? createHash("sha256").update(payload).digest("hex"),
      signature: overrides.signature ?? sign(null, payload, signingKey).toString("base64url"),
    })}\n`,
  );
}

async function createValidArtifact(parent: string, version = "v1", content = "omp-v1"): Promise<string> {
  const directory = join(parent, `artifact-${version}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "omp.exe"), content);
  const manifest = `${JSON.stringify({
    runtimeVersion: version,
    upstreamVersion: "0.0.0",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    patchsetVersion: "0.1.0",
    studioProtocol: { min: 1, max: 1 },
    profile: "full-parity-v1",
    capabilityHash: "capability-fixture",
    commandManifestHash: "command-fixture",
    platform: "win32-x64",
    entrypoint: "omp.exe",
    channel: "stable",
  })}\n`;
  await writeFile(join(directory, "runtime-manifest.json"), manifest);
  const digest = createHash("sha256").update(content).digest("hex");
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");
  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: { "omp.exe": digest, "runtime-manifest.json": manifestDigest },
  })}\n`;
  await writeFile(join(directory, "checksums.json"), checksums);
  await writeSignature(directory, manifest, checksums);
  return directory;
}

test("assertSafeVersion accepts valid versions and rejects unsafe inputs", () => {
  assertSafeVersion("v1");
  assertSafeVersion("18.0.11-studio.14");
  assertSafeVersion("abc_123.test-01");

  assert.throws(() => assertSafeVersion(""), /Runtime version is not safe/u);
  assert.throws(() => assertSafeVersion(".."), /Runtime version is not safe/u);
  assert.throws(() => assertSafeVersion("foo/bar"), /Runtime version is not safe/u);
  assert.throws(() => assertSafeVersion("foo\\bar"), /Runtime version is not safe/u);
  assert.throws(() => assertSafeVersion("a".repeat(129)), /Runtime version is not safe/u);
  assert.throws(() => assertSafeVersion("-bad-prefix"), /Runtime version is not safe/u);
});

test("writeJsonAtomic writes atomically without leaving .tmp files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-atomic-"));
  const target = join(temporary, "data", "test.json");
  await writeJsonAtomic(target, { ok: true, number: 42 });

  const content = JSON.parse(await readFile(target, "utf8")) as { ok: boolean; number: number };
  assert.equal(content.ok, true);
  assert.equal(content.number, 42);

  const files = await readdir(join(temporary, "data"));
  assert.deepEqual(files, ["test.json"]);
});

test("verifySignedArtifact verifies valid artifact successfully", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-valid-"));
  const artifactDir = await createValidArtifact(temporary);

  const result = await verifySignedArtifact({
    directory: artifactDir,
    layout: RUNTIME_ARTIFACT_LAYOUT,
    parseManifest: parseRuntimeInstallationManifest,
    requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
    trustedKeys,
  });

  assert.equal(result.manifest.runtimeVersion, "v1");
  assert.ok(result.checksums.files["omp.exe"]);
});

test("verifySignedArtifact rejects signature mismatch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-bad-sig-"));
  const artifactDir = await createValidArtifact(temporary);
  const signaturePath = join(artifactDir, "runtime-signature.json");
  const signatureObj = JSON.parse(await readFile(signaturePath, "utf8")) as { signature: string };
  signatureObj.signature = Buffer.from("invalid-signature").toString("base64url");
  await writeFile(signaturePath, JSON.stringify(signatureObj));

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Runtime signature verification failed/u,
  );
});

test("verifySignedArtifact rejects payloadSha256 mismatch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-bad-hash-"));
  const artifactDir = await createValidArtifact(temporary);
  const signaturePath = join(artifactDir, "runtime-signature.json");
  const signatureObj = JSON.parse(await readFile(signaturePath, "utf8")) as { payloadSha256: string };
  signatureObj.payloadSha256 = "0".repeat(64);
  await writeFile(signaturePath, JSON.stringify(signatureObj));

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Runtime signature does not match the artifact metadata/u,
  );
});

test("verifySignedArtifact rejects unknown keyId", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-unknown-key-"));
  const artifactDir = await createValidArtifact(temporary);
  const signaturePath = join(artifactDir, "runtime-signature.json");
  const signatureObj = JSON.parse(await readFile(signaturePath, "utf8")) as { keyId: string };
  signatureObj.keyId = "unknown-key";
  await writeFile(signaturePath, JSON.stringify(signatureObj));

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Runtime signature verification failed/u,
  );
});

test("verifySignedArtifact rejects when checksums miss requireCovered files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-miss-req-"));
  const artifactDir = await createValidArtifact(temporary);
  const manifest = await readFile(join(artifactDir, "runtime-manifest.json"), "utf8");
  const checksums = `${JSON.stringify({ algorithm: "sha256", files: { "omp.exe": "0".repeat(64) } })}\n`;
  await writeFile(join(artifactDir, "checksums.json"), checksums);
  await writeSignature(artifactDir, manifest, checksums);

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
        coverageMessage: (file) =>
          file === "runtime-manifest.json"
            ? "checksums.json must cover runtime-manifest.json"
            : "checksums.json must cover the Runtime entrypoint",
      }),
    /checksums\.json must cover runtime-manifest\.json/u,
  );
});

test("verifySignedArtifact rejects uncovered extra files in directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-extra-file-"));
  const artifactDir = await createValidArtifact(temporary);
  await writeFile(join(artifactDir, "unexpected.txt"), "sneaky");

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Runtime artifact file is not covered by checksums: unexpected\.txt/u,
  );
});

test("verifySignedArtifact rejects symbolic links in artifact directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-symlink-"));
  const artifactDir = await createValidArtifact(temporary);
  try {
    await symlink(join(artifactDir, "omp.exe"), join(artifactDir, "omp-symlink.exe"));
  } catch {
    return; // Skip on platforms where unprivileged symlinks cannot be created
  }

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Runtime artifact cannot contain symbolic links/u,
  );
});

test("verifySignedArtifact rejects checksum paths that escape artifact", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-escape-"));
  const artifactDir = await createValidArtifact(temporary);
  const manifest = await readFile(join(artifactDir, "runtime-manifest.json"), "utf8");
  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "runtime-manifest.json": createHash("sha256").update(manifest).digest("hex"),
      "omp.exe": createHash("sha256").update("omp-v1").digest("hex"),
      "../escaped.txt": "0".repeat(64),
    },
  })}\n`;
  await writeFile(join(artifactDir, "checksums.json"), checksums);
  await writeSignature(artifactDir, manifest, checksums);

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Checksum path escapes artifact/u,
  );
});

test("verifySignedArtifact rejects file checksum mismatch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-file-mismatch-"));
  const artifactDir = await createValidArtifact(temporary);
  await writeFile(join(artifactDir, "omp.exe"), "tampered-content");

  await assert.rejects(
    () =>
      verifySignedArtifact({
        directory: artifactDir,
        layout: RUNTIME_ARTIFACT_LAYOUT,
        parseManifest: parseRuntimeInstallationManifest,
        requireCovered: (m) => ["runtime-manifest.json", m.entrypoint],
        trustedKeys,
      }),
    /Checksum mismatch for omp\.exe/u,
  );
});

test("installVerifiedArtifact atomically installs and leaves no staging artifacts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-install-"));
  const artifactDir = await createValidArtifact(temporary);
  const versionsDir = join(temporary, "versions");

  await installVerifiedArtifact({
    sourceDirectory: artifactDir,
    versionsDirectory: versionsDir,
    version: "v1",
    requireFile: "omp.exe",
  });

  const installedFiles = await readdir(versionsDir);
  assert.deepEqual(installedFiles, ["v1"]);
  const v1Files = await readdir(join(versionsDir, "v1"));
  assert.ok(v1Files.includes("omp.exe"));
  assert.ok(v1Files.includes("runtime-manifest.json"));
});

test("installVerifiedArtifact cleans staging and rejects if requireFile is missing", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-install-miss-"));
  const artifactDir = join(temporary, "incomplete");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "not-entrypoint.txt"), "hello");
  const versionsDir = join(temporary, "versions");

  await assert.rejects(
    () =>
      installVerifiedArtifact({
        sourceDirectory: artifactDir,
        versionsDirectory: versionsDir,
        version: "v1",
        requireFile: "missing-entrypoint.exe",
      }),
    /Runtime entrypoint is missing or escapes the artifact/u,
  );

  const items = await readdir(versionsDir);
  assert.deepEqual(items, []);
});

test("installVerifiedArtifact refuses to overwrite already installed version", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-signed-install-dup-"));
  const artifactDir = await createValidArtifact(temporary);
  const versionsDir = join(temporary, "versions");

  await installVerifiedArtifact({
    sourceDirectory: artifactDir,
    versionsDirectory: versionsDir,
    version: "v1",
    requireFile: "omp.exe",
  });

  await assert.rejects(
    () =>
      installVerifiedArtifact({
        sourceDirectory: artifactDir,
        versionsDirectory: versionsDir,
        version: "v1",
        requireFile: "omp.exe",
      }),
    /Runtime v1 is already installed/u,
  );
});

test("installVerifiedArtifact verifies the copied staging tree before publishing it", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-staging-verify-"));
  const source = await createValidArtifact(temporary);
  const versions = join(temporary, "versions");
  await assert.rejects(() => installVerifiedArtifact({
    sourceDirectory: source, versionsDirectory: versions, version: "v1", requireFile: "omp.exe",
    verifyStaging: async (directory) => {
      assert.notEqual(directory, source);
      await writeFile(join(directory, "omp.exe"), "corrupted-copy");
      await verifySignedArtifact({ directory, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: (manifest) => ["runtime-manifest.json", manifest.entrypoint], trustedKeys });
    },
  }), /Checksum mismatch/u);
  assert.deepEqual(await readdir(versions), []);
});

test("failed repair publication restores the original directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-repair-restore-"));
  const source = await createValidArtifact(temporary);
  const versions = join(temporary, "versions");
  const installed = join(versions, "v1");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "original.txt"), "preserve me");
  await assert.rejects(() => installVerifiedArtifact({
    sourceDirectory: source, versionsDirectory: versions, version: "v1", requireFile: "omp.exe",
    replaceExisting: { beforeReplace: async () => undefined },
    // Model staging disappearing between verification and the final rename.
    verifyStaging: async (directory) => { await rm(directory, { recursive: true }); },
  }), { code: "ENOENT" });
  assert.equal(await readFile(join(installed, "original.txt"), "utf8"), "preserve me");
  assert.deepEqual(await readdir(versions), ["v1"]);
});
