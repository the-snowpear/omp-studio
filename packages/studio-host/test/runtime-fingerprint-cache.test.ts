import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  CapabilityGrade,
  CapabilityManifestEntry,
  OperatorCommandManifest,
  RuntimeEpoch,
  StudioHelloResponse,
} from "@omp-studio/studio-protocol";
import { FULL_PARITY_REQUIRED_CAPABILITIES } from "@omp-studio/studio-protocol";
import { runtimeEntrypointFor } from "@omp-studio/runtime-installer";
import {
  ExecutableFingerprintCache,
  HostBackend,
  fingerprintExecutable,
  resolveRuntime,
  type RuntimeProbeOutcome,
  type RuntimeProbePort,
  type RuntimeResolverEnvironment,
} from "../src/index.js";

/**
 * P0-2: `resolveRuntime` used to read the candidate executable twice - once
 * before the live probe and once after it - to prove the file did not change
 * underneath the probe. On a ~170 MB Runtime that is two full hashes per
 * resolve, on top of the installer's own checksum read. These tests pin the
 * reuse rules: one real read per resolve, a re-read when the file's stat
 * changes, and a single shared read when two resolves overlap.
 */

const epoch = 1 as RuntimeEpoch;
const HOST_ENTRYPOINT = runtimeEntrypointFor(process.platform);

function capabilityEntries(): CapabilityManifestEntry[] {
  return FULL_PARITY_REQUIRED_CAPABILITIES.map((id) => ({
    id,
    grade: "stable" as CapabilityGrade,
    version: 1,
    evidence: `fixture:${id}`,
  }));
}

function hello(): StudioHelloResponse {
  return {
    type: "studio.hello.result",
    requestId: "hello-1",
    selectedProtocolVersion: 1,
    runtimeVersion: "17.2.13-studio.1",
    upstreamVersion: "17.2.13",
    upstreamCommit: "a".repeat(40),
    runtimeInstanceId: "runtime-instance-1",
    runtimeEpoch: epoch,
    capabilityManifest: {
      profile: "full-parity-v1",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-full",
      capabilities: capabilityEntries(),
    },
    commandManifestHash: "sha256:commands-full",
    stateVersion: 0,
    challengeProof: "probe-proof",
  } as unknown as StudioHelloResponse;
}

function commandManifest(): OperatorCommandManifest {
  return {
    generatedAt: "2026-08-11T00:00:00.000Z",
    upstreamCommit: "a".repeat(40),
    hash: "sha256:commands-full",
    commands: [],
    unclassifiedBuiltins: [],
  };
}

function fullOutcome(): RuntimeProbeOutcome {
  return { hello: hello(), commandManifest: commandManifest(), smoke: "passed", shutdown: "passed" };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Cache whose reads are counted, so "one read per resolve" is measured, not inferred. */
function countingCache(): { cache: ExecutableFingerprintCache; reads: string[] } {
  const reads: string[] = [];
  const cache = new ExecutableFingerprintCache({
    read: async (platform, path) => {
      reads.push(path);
      return { fingerprint: await fingerprintExecutable(platform, path), bytes: 0 };
    },
  });
  return { cache, reads };
}

async function executableFile(content = "fixture-bytes"): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-fingerprint-"));
  const path = join(directory, HOST_ENTRYPOINT);
  await writeFile(path, content);
  return { directory, path };
}

function environment(probe: RuntimeProbePort, fingerprints: ExecutableFingerprintCache): RuntimeResolverEnvironment {
  return { probe, fingerprints };
}

test("one resolve fingerprints the executable once and reuses it after the probe", async () => {
  const { directory, path } = await executableFile();
  try {
    const { cache, reads } = countingCache();
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: false },
      environment({ probe: async () => fullOutcome() }, cache),
    );
    assert.equal(resolution.classification, "compatible-system");
    assert.equal(reads.length, 1);
    // 13 bytes of fixture: read once before the probe, reused after it.
    assert.deepEqual(cache.stats(), {
      contentHashes: 1,
      cacheHits: 1,
      singleFlightJoins: 0,
      skippedBytes: 13,
      hashedBytes: 13,
      invalidations: 0,
    });
    // The published identity is still the plain content fingerprint, so stored
    // Thread bindings keep matching.
    assert.equal(resolution.executableIdentity, await fingerprintExecutable(process.platform, path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an executable replaced during the probe is read again and rejected", async () => {
  const { directory, path } = await executableFile();
  try {
    const { cache, reads } = countingCache();
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: true },
      environment({
        probe: async () => {
          await writeFile(path, "replacement-bytes");
          return fullOutcome();
        },
      }, cache),
    );
    assert.equal(resolution.classification, "rejected");
    assert.equal(resolution.probeFailure, "IDENTITY_MISMATCH");
    assert.equal(reads.length, 2, "a changed stat identity must be read again");
    assert.equal(cache.stats().contentHashes, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A scanner or a synchronisation agent can touch the executable while it is
// being probed. The identity that decides the launch is the content, exactly as
// before this change: the re-read happens, and the same bytes stay accepted.
test("a metadata-only change during the probe is read again and accepted when the bytes match", async () => {
  const { directory, path } = await executableFile();
  try {
    const { cache, reads } = countingCache();
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: true },
      environment({
        probe: async () => {
          const stamp = new Date(Date.now() + 60_000);
          await utimes(path, stamp, stamp);
          return fullOutcome();
        },
      }, cache),
    );
    assert.equal(reads.length, 2);
    assert.equal(resolution.classification, "compatible-system");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent resolves share one in-flight read instead of hashing twice", async () => {
  const { directory, path } = await executableFile();
  try {
    const reads: string[] = [];
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const cache = new ExecutableFingerprintCache({
      read: async (platform, candidate) => {
        reads.push(candidate);
        markReadStarted();
        await readGate;
        return { fingerprint: await fingerprintExecutable(platform, candidate), bytes: 0 };
      },
    });
    const first = resolveRuntime(
      { kind: "system", executable: path, allowLimited: false },
      environment({ probe: async () => fullOutcome() }, cache),
    );
    const second = resolveRuntime(
      { kind: "system", executable: path, allowLimited: false },
      environment({ probe: async () => fullOutcome() }, cache),
    );
    // The first resolve is inside its read; let the second one reach the shared
    // in-flight entry before the read is allowed to finish.
    await readStarted;
    await tick();
    releaseRead();
    const [resolvedFirst, resolvedSecond] = await Promise.all([first, second]);
    assert.equal(resolvedFirst.classification, "compatible-system");
    assert.equal(resolvedSecond.classification, "compatible-system");
    assert.equal(reads.length, 1);
    assert.equal(cache.stats().contentHashes, 1);
    assert.equal(cache.stats().singleFlightJoins, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a warm cache still reads at the execution boundary and only reuses after it", async () => {
  const { directory, path } = await executableFile();
  try {
    const { cache, reads } = countingCache();
    await cache.fingerprint(process.platform, path);
    assert.equal(reads.length, 1);
    // Ordinary lookup: reused while the stat identity is unchanged.
    await cache.fingerprint(process.platform, path);
    assert.equal(reads.length, 1);
    assert.equal(cache.stats().cacheHits, 1);
    // Execution boundary: always measured again.
    await cache.fingerprint(process.platform, path, { fresh: true });
    assert.equal(reads.length, 2);
    // A metadata change invalidates immediately, without waiting for the TTL.
    const stamp = new Date(Date.now() + 60_000);
    await utimes(path, stamp, stamp);
    await cache.fingerprint(process.platform, path);
    assert.equal(reads.length, 3);
    cache.invalidate();
    await cache.fingerprint(process.platform, path);
    assert.equal(reads.length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HostBackend shares one fingerprint cache across resolves", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-backend-fingerprint-"));
  const { directory, path } = await executableFile();
  try {
    const backend = new HostBackend({
      stateDirectory: join(temporary, "profile"),
      resolver: { probe: { probe: async () => fullOutcome() } },
    });
    const first = await backend.resolve({ kind: "system", executable: path, allowLimited: false });
    assert.equal(first.classification, "compatible-system");
    assert.equal(backend.fingerprints.stats().contentHashes, 1);
    // A fresh cache would read again; the shared one is asked at the execution
    // boundary, so the second resolve reads once more rather than not at all.
    await backend.resolve({ kind: "system", executable: path, allowLimited: false });
    assert.equal(backend.fingerprints.stats().contentHashes, 2);
    backend.invalidateRuntimeVerification();
    assert.equal(backend.installer.verificationStats().contentHashes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});
