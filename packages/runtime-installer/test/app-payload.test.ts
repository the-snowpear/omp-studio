import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppPayloadInstaller,
  parseAppPayloadManifest,
  type AppPayloadManifest,
} from "../src/index.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });
const trustedKeys = { "test-key": trustedPublicKey };

async function writePayloadSignature(
  directory: string,
  manifest: string,
  checksums: string,
  overrides: { keyId?: string; signature?: string; payloadSha256?: string } = {},
): Promise<void> {
  const payload = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  await writeFile(
    join(directory, "payload-signature.json"),
    `${JSON.stringify({
      algorithm: "ed25519",
      keyId: overrides.keyId ?? "test-key",
      payloadSha256: overrides.payloadSha256 ?? createHash("sha256").update(payload).digest("hex"),
      signature: overrides.signature ?? sign(null, payload, signingKey).toString("base64url"),
    })}\n`,
  );
}

async function createValidAppArtifact(
  parent: string,
  version = "0.1.4",
  preloadContent = "console.log('preload');",
  rendererContent = "<!DOCTYPE html><html><body>OMP</body></html>",
): Promise<string> {
  const directory = join(parent, `artifact-${version}`);
  await mkdir(join(directory, "renderer"), { recursive: true });
  await writeFile(join(directory, "preload.cjs"), preloadContent);
  await writeFile(join(directory, "renderer", "index.html"), rendererContent);

  const manifestObj: AppPayloadManifest = {
    payloadVersion: version,
    payloadFormat: 1,
    platform: "win32-x64",
    abi: {
      electron: "43.4.0",
      modules: "143",
      nodePty: "1.1.0",
    },
    clientContractVersion: 1,
    studioProtocol: { min: 1, max: 1 },
    entries: ["preload.cjs", "renderer"],
  };
  const manifest = `${JSON.stringify(manifestObj, null, 2)}\n`;
  await writeFile(join(directory, "app-payload-manifest.json"), manifest);

  const preloadDigest = createHash("sha256").update(preloadContent).digest("hex");
  const rendererDigest = createHash("sha256").update(rendererContent).digest("hex");
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");

  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "app-payload-manifest.json": manifestDigest,
      "preload.cjs": preloadDigest,
      "renderer/index.html": rendererDigest,
    },
  }, null, 2)}\n`;
  await writeFile(join(directory, "checksums.json"), checksums);

  await writePayloadSignature(directory, manifest, checksums);
  return directory;
}

test("parseAppPayloadManifest parses valid manifest and rejects malformed fields", () => {
  const valid = {
    payloadVersion: "0.1.4",
    payloadFormat: 1,
    platform: "win32-x64",
    abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
    clientContractVersion: 1,
    studioProtocol: { min: 1, max: 2 },
    entries: ["preload.cjs", "renderer"],
  };

  const parsed = parseAppPayloadManifest(valid);
  assert.equal(parsed.payloadVersion, "0.1.4");
  assert.equal(parsed.payloadFormat, 1);
  assert.equal(parsed.platform, "win32-x64");
  assert.equal(parsed.abi.electron, "43.4.0");
  assert.equal(parsed.abi.modules, "143");
  assert.equal(parsed.abi.nodePty, "1.1.0");
  assert.deepEqual(parsed.entries, ["preload.cjs", "renderer"]);

  // Reject unknown top-level field
  assert.throws(() => parseAppPayloadManifest({ ...valid, extraField: "foo" }), /Unknown field/);
  // Reject unknown abi field
  assert.throws(() => parseAppPayloadManifest({ ...valid, abi: { ...valid.abi, extra: "bar" } }), /Unknown field/);
  // Reject unknown studioProtocol field
  assert.throws(() => parseAppPayloadManifest({ ...valid, studioProtocol: { ...valid.studioProtocol, extra: 3 } }), /Unknown field/);
  // Reject non-safe version
  assert.throws(() => parseAppPayloadManifest({ ...valid, payloadVersion: "invalid/version" }), /safe/);
  // Reject invalid payloadFormat
  assert.throws(() => parseAppPayloadManifest({ ...valid, payloadFormat: 0 }), /payloadFormat/);
  // Reject min > max
  assert.throws(() => parseAppPayloadManifest({ ...valid, studioProtocol: { min: 2, max: 1 } }), /studioProtocol/);
  // Reject empty entries
  assert.throws(() => parseAppPayloadManifest({ ...valid, entries: [] }), /entries/);
});

test("payload activation refuses bytes changed after installation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-activate-tamper-"));
  try {
    const root = join(temp, "payload");
    const installer = new AppPayloadInstaller(root, { trustedKeys });
    await installer.install(await createValidAppArtifact(temp));
    await writeFile(join(root, "versions", "0.1.4", "preload.cjs"), "tampered");
    await assert.rejects(() => installer.activate("0.1.4"), /Checksum mismatch/u);
    assert.equal(await installer.current(), undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("payload boot success only clears the version actually loaded", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-boot-version-"));
  try {
    const installer = new AppPayloadInstaller(join(temp, "payload"), { trustedKeys });
    assert.deepEqual(await installer.prune(), []);
    await installer.install(await createValidAppArtifact(temp));
    await installer.activate("0.1.4");
    await installer.noteBootAttempt();
    await installer.noteBootSuccess("0.1.3");
    assert.equal((await installer.current())?.bootAttempts, 1);
    await installer.noteBootSuccess("0.1.4");
    assert.equal((await installer.current())?.bootAttempts, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("payload pointers reject path traversal and invalid boot counters", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-pointer-"));
  try {
    const installer = new AppPayloadInstaller(temp, { trustedKeys });
    for (const override of [{ payloadVersion: "../outside" }, { previousPayloadVersion: "../outside" }, { bootAttempts: -1 }, { bootAttempts: 0.5 }]) {
      await writeFile(join(temp, "current.json"), JSON.stringify({ payloadVersion: "0.1.4", activatedAt: "now", bootAttempts: 0, ...override }));
      await assert.rejects(() => installer.current());
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("AppPayloadInstaller install verifies signed artifact and atomizes install", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-install-"));
  try {
    const artifact = await createValidAppArtifact(temp, "0.1.4");
    const installerRoot = join(temp, "installer");
    const installer = new AppPayloadInstaller(installerRoot, { trustedKeys });

    const manifest = await installer.install(artifact);
    assert.equal(manifest.payloadVersion, "0.1.4");

    // Installed files exist in versions/0.1.4
    const installedManifest = JSON.parse(
      await readFile(join(installerRoot, "versions", "0.1.4", "app-payload-manifest.json"), "utf8"),
    );
    assert.equal(installedManifest.payloadVersion, "0.1.4");

    // Re-installing throws already installed error
    await assert.rejects(
      () => installer.install(artifact),
      /already installed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("AppPayloadInstaller install rejects tampered content or signature", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-tamper-"));
  try {
    const artifact = await createValidAppArtifact(temp, "0.1.4");
    // Tamper preload.cjs
    await writeFile(join(artifact, "preload.cjs"), "tampered content");

    const installer = new AppPayloadInstaller(join(temp, "installer"), { trustedKeys });
    await assert.rejects(
      () => installer.install(artifact),
      /Checksum mismatch/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("AppPayloadInstaller activate and rollback track active versions and boot attempts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-activate-"));
  try {
    const installerRoot = join(temp, "installer");
    const installer = new AppPayloadInstaller(installerRoot, { trustedKeys });

    const art1 = await createValidAppArtifact(temp, "0.1.4");
    const art2 = await createValidAppArtifact(temp, "0.1.5");
    await installer.install(art1);
    await installer.install(art2);

    assert.equal(await installer.current(), undefined);

    // Activate v0.1.4
    const rec1 = await installer.activate("0.1.4");
    assert.equal(rec1.payloadVersion, "0.1.4");
    assert.equal(rec1.previousPayloadVersion, undefined);
    assert.equal(rec1.bootAttempts, 0);

    const cur1 = await installer.current();
    assert.equal(cur1?.payloadVersion, "0.1.4");
    assert.equal(cur1?.previousPayloadVersion, undefined);

    // Note boot attempts
    const attempts1 = await installer.noteBootAttempt();
    assert.equal(attempts1, 1);
    const attempts2 = await installer.noteBootAttempt();
    assert.equal(attempts2, 2);
    assert.equal((await installer.current())?.bootAttempts, 2);

    // Note boot success resets attempts
    await installer.noteBootSuccess();
    assert.equal((await installer.current())?.bootAttempts, 0);

    // Activate v0.1.5 -> previousPayloadVersion becomes 0.1.4
    const rec2 = await installer.activate("0.1.5");
    assert.equal(rec2.payloadVersion, "0.1.5");
    assert.equal(rec2.previousPayloadVersion, "0.1.4");
    assert.equal(rec2.bootAttempts, 0);

    const cur2 = await installer.current();
    assert.equal(cur2?.payloadVersion, "0.1.5");
    assert.equal(cur2?.previousPayloadVersion, "0.1.4");

    // Rollback switches back to 0.1.4 and marks 0.1.5 as previous
    const rolled = await installer.rollback();
    assert.ok(rolled);
    assert.equal(rolled.payloadVersion, "0.1.4");
    assert.equal(rolled.previousPayloadVersion, "0.1.5");

    const curRolled = await installer.current();
    assert.equal(curRolled?.payloadVersion, "0.1.4");
    assert.equal(curRolled?.previousPayloadVersion, "0.1.5");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("AppPayloadInstaller rollback deletes current pointer when no previous version exists", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-rollback-del-"));
  try {
    const installerRoot = join(temp, "installer");
    const installer = new AppPayloadInstaller(installerRoot, { trustedKeys });

    const art1 = await createValidAppArtifact(temp, "0.1.4");
    await installer.install(art1);
    await installer.activate("0.1.4");

    const rolled = await installer.rollback();
    assert.equal(rolled, undefined);
    assert.equal(await installer.current(), undefined);

    await assert.rejects(
      () => installer.rollback(),
      /No active payload to rollback/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("AppPayloadInstaller prune keeps only current and previous versions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-prune-"));
  try {
    const installerRoot = join(temp, "installer");
    const installer = new AppPayloadInstaller(installerRoot, { trustedKeys });

    const art1 = await createValidAppArtifact(temp, "0.1.3");
    const art2 = await createValidAppArtifact(temp, "0.1.4");
    const art3 = await createValidAppArtifact(temp, "0.1.5");

    await installer.install(art1);
    await installer.install(art2);
    await installer.install(art3);

    await installer.activate("0.1.4");
    await installer.activate("0.1.5"); // current: 0.1.5, previous: 0.1.4

    const removed = await installer.prune();
    assert.deepEqual(removed, ["0.1.3"]);

    // Verify 0.1.3 directory was removed, 0.1.4 and 0.1.5 remain
    await assert.rejects(() => readFile(join(installerRoot, "versions", "0.1.3", "app-payload-manifest.json")));
    assert.ok(await readFile(join(installerRoot, "versions", "0.1.4", "app-payload-manifest.json")));
    assert.ok(await readFile(join(installerRoot, "versions", "0.1.5", "app-payload-manifest.json")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
