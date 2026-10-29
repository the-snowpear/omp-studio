import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeInstaller, type RuntimeInstallerOptions } from "../src/index.js";

/**
 * P0-2: a Runtime lookup must not re-hash the ~170 MB entrypoint every time.
 *
 * `currentManifest()` is on two hot paths: the Runtime Resolver's managed
 * lookup and the `omp-usage-adapter` entrypoint lookup behind the 30 s
 * `usage.get` poll. These tests pin the evidence cache's reuse rules and, just
 * as importantly, the cases where it must read the bytes again.
 */

const passingSelfCheck = { run: async () => undefined };
const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });

function runtimeInstaller(root: string, options: RuntimeInstallerOptions = {}): RuntimeInstaller {
  return new RuntimeInstaller(root, { trustedKeys: { "test-key": trustedPublicKey }, ...options });
}

async function writeSignature(directory: string, manifest: string, checksums: string): Promise<void> {
  const payload = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  await writeFile(
    join(directory, "runtime-signature.json"),
    `${JSON.stringify({
      algorithm: "ed25519",
      keyId: "test-key",
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      signature: sign(null, payload, signingKey).toString("base64url"),
    })}\n`,
  );
}

async function artifact(parent: string, version: string, content = `omp-${version}`): Promise<string> {
  const directory = join(parent, `artifact-${version}`);
  await mkdir(directory);
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
  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "omp.exe": createHash("sha256").update(content).digest("hex"),
      "runtime-manifest.json": createHash("sha256").update(manifest).digest("hex"),
    },
  })}\n`;
  await writeFile(join(directory, "checksums.json"), checksums);
  await writeSignature(directory, manifest, checksums);
  return directory;
}

async function installedRuntime(
  parent: string,
  options: RuntimeInstallerOptions = {},
  content?: string,
): Promise<{ installer: RuntimeInstaller; entrypoint: string }> {
  const root = join(parent, "installed");
  const installer = runtimeInstaller(root, options);
  await installer.install(await artifact(parent, "v1", content));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  return { installer, entrypoint: join(root, "versions", "v1", "omp.exe") };
}

test("repeated currentManifest lookups hash the entrypoint once and report the skipped bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-reuse-"));
  try {
    // A size large enough that the saved reads are the point of the change, and
    // small enough to keep the suite fast.
    const content = "r".repeat(4 * 1024 * 1024);
    const { installer } = await installedRuntime(temporary, {}, content);

    const first = await installer.currentManifest();
    assert.ok(first);
    for (let lookup = 0; lookup < 4; lookup += 1) {
      const again = await installer.currentManifest();
      assert.equal(again?.entrypointPath, first.entrypointPath);
      assert.equal(again?.record.runtimeVersion, "v1");
    }

    assert.deepEqual(installer.verificationStats(), {
      contentHashes: 1,
      cacheHits: 4,
      singleFlightJoins: 0,
      skippedBytes: 4 * 4 * 1024 * 1024,
      hashedBytes: 4 * 1024 * 1024,
      invalidations: 0,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an entrypoint whose bytes changed is hashed again and rejected", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-tamper-"));
  try {
    const content = "A".repeat(64 * 1024);
    const { installer } = await installedRuntime(temporary, {}, content);
    await installer.currentManifest();
    assert.equal(installer.verificationStats().contentHashes, 1);

    // Same length, so only the modification time can reveal the replacement.
    await writeFile(join(temporary, "installed", "versions", "v1", "omp.exe"), "B".repeat(content.length));
    await assert.rejects(() => installer.currentManifest(), /Checksum mismatch for omp\.exe/u);
    assert.equal(installer.verificationStats().contentHashes, 2);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// A stat identity alone (size + mtime + inode) can be forged by whoever can
// write the file. The trust window is the mitigation: inside it a lookup may
// reuse the evidence, once it expires the bytes are read and the mismatch is
// fatal.
test("evidence older than the trust window is re-hashed even when the stat identity is unchanged", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-window-"));
  try {
    const clock = { now: 1_000_000 };
    const content = "A".repeat(4096);
    const { installer, entrypoint } = await installedRuntime(
      temporary,
      { verificationMaxAgeMs: 60_000, now: () => clock.now },
      content,
    );
    const stamp = new Date(1_700_000_000_123);
    await utimes(entrypoint, stamp, stamp);

    await installer.currentManifest();
    assert.equal(installer.verificationStats().contentHashes, 1);

    // Same size, same inode, mtime restored to the exact recorded instant.
    await writeFile(entrypoint, "B".repeat(content.length));
    await utimes(entrypoint, stamp, stamp);

    clock.now += 59_000;
    assert.ok(await installer.currentManifest(), "evidence inside the window is reused");
    assert.equal(installer.verificationStats().contentHashes, 1);

    clock.now += 2_000;
    await assert.rejects(() => installer.currentManifest(), /Checksum mismatch for omp\.exe/u);
    assert.equal(installer.verificationStats().contentHashes, 2);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("invalidate() forces the next lookup to read the bytes again", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-invalidate-"));
  try {
    const { installer } = await installedRuntime(temporary);
    await installer.currentManifest();
    installer.invalidate();
    await installer.currentManifest();
    const stats = installer.verificationStats();
    assert.equal(stats.contentHashes, 2);
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.invalidations, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("activating a Runtime again drops the evidence recorded for the previous activation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-activate-"));
  try {
    const { installer } = await installedRuntime(temporary);
    await installer.currentManifest();
    await installer.activate("v1", { selfCheck: passingSelfCheck });
    await installer.currentManifest();
    assert.equal(installer.verificationStats().contentHashes, 2);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("concurrent currentManifest lookups share one in-flight verification", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-concurrent-"));
  try {
    const content = "C".repeat(1024 * 1024);
    const { installer } = await installedRuntime(temporary, {}, content);
    const [first, second, third] = await Promise.all([
      installer.currentManifest(),
      installer.currentManifest(),
      installer.currentManifest(),
    ]);
    assert.equal(first?.entrypointPath, second?.entrypointPath);
    assert.equal(second?.entrypointPath, third?.entrypointPath);
    const stats = installer.verificationStats();
    assert.equal(stats.contentHashes, 1);
    assert.equal(stats.singleFlightJoins, 2);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a failed verification is never recorded", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-failure-"));
  try {
    const { installer, entrypoint } = await installedRuntime(temporary);
    await writeFile(entrypoint, "tampered-before-first-lookup");
    await assert.rejects(() => installer.currentManifest(), /Checksum mismatch for omp\.exe/u);
    await assert.rejects(() => installer.currentManifest(), /Checksum mismatch for omp\.exe/u);
    const stats = installer.verificationStats();
    assert.equal(stats.contentHashes, 2);
    assert.equal(stats.cacheHits, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("signed metadata is re-verified on every lookup inside the trust window", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-metadata-"));
  try {
    const { installer } = await installedRuntime(temporary);
    await installer.currentManifest();
    await installer.currentManifest();
    const manifestPath = join(temporary, "installed", "versions", "v1", "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { commandManifestHash: string };
    manifest.commandManifestHash = "sha256:planted-by-a-standard-user";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(() => installer.currentManifest(), /signature does not match/u);
    assert.equal(installer.verificationStats().contentHashes, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Acceptance evidence for P0-2, in the shape of the real call sites: the
// resolver's managed lookup, the Host backend's resolve, the update coordinator's
// reconcile, and the 30 s `usage.get` entrypoint lookup all go through
// `currentManifest()`. One launch plus two minutes of polling used to be six
// full hashes of the installed executable.
test("a launch plus four usage polls hash the installed Runtime once", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-evidence-launch-"));
  try {
    const content = "L".repeat(8 * 1024 * 1024);
    const { installer } = await installedRuntime(temporary, {}, content);

    // runtime-resolver.ts managed lookup -> host-backend.ts resolve
    await installer.currentManifest();
    // update-coordinator.ts reconcileRuntimePending / launch recovery
    await installer.currentManifest();
    // omp-usage-adapter.ts locateOmp, every USAGE_POLL_MS for two minutes
    for (let poll = 0; poll < 4; poll += 1) await installer.currentManifest();

    const stats = installer.verificationStats();
    assert.equal(stats.contentHashes, 1);
    assert.equal(stats.cacheHits, 5);
    assert.equal(stats.skippedBytes, 5 * 8 * 1024 * 1024);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
