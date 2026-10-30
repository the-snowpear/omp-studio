import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  CapabilityGrade,
  CapabilityManifestEntry,
  OperatorCommandManifest,
  RuntimeEpoch,
  RuntimeInstallationManifest,
  StudioHelloResponse,
} from "@omp-studio/studio-protocol";
import { FULL_PARITY_REQUIRED_CAPABILITIES } from "@omp-studio/studio-protocol";
import { runtimeEntrypointFor } from "@omp-studio/runtime-installer";
import {
  fingerprintExecutable,
  readExecutableDigests,
  resolveRuntime,
  type ExecutableDigests,
  type RuntimeProbeOutcome,
  type RuntimeProbePort,
  type RuntimeResolverEnvironment,
} from "../src/index.js";

/**
 * P1-2 (PR #20 review): the execution boundary must prove that the bytes the
 * probe executed are the bytes that were approved.
 *
 * The previous implementation let the post-probe fingerprint reuse the pre-probe
 * read whenever `lstat` still reported the same size/mtime/inode/device. A local
 * writer can rewrite an executable in place (same size, same inode) and restore
 * `mtime`, so that comparison could not see a swap at all. These tests pin the
 * stricter rule: both boundary reads are real reads of the bytes, compared as
 * digests, and a managed Runtime additionally proves its content matches the
 * digest in the signature-covered checksums.
 */

const epoch = 1 as RuntimeEpoch;
const HOST_ENTRYPOINT = runtimeEntrypointFor(process.platform);
const FIXTURE_BYTES = "fixture-bytes";
const TAMPERED_BYTES = "tampered-byte"; // same length on purpose
const FIXTURE_SHA256 = createHash("sha256").update(FIXTURE_BYTES).digest("hex");

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

function managedManifest(): RuntimeInstallationManifest {
  return {
    runtimeVersion: "17.2.13-studio.1",
    upstreamVersion: "17.2.13",
    upstreamCommit: "a".repeat(40),
    patchsetVersion: "1.0.0",
    studioProtocol: { min: 1, max: 1 },
    profile: "full-parity-v1",
    capabilityHash: "sha256:capabilities-full",
    commandManifestHash: "sha256:commands-full",
    platform: `${process.platform}-${process.arch}`,
    entrypoint: HOST_ENTRYPOINT,
    channel: "stable",
  } as RuntimeInstallationManifest;
}

async function executableFile(content = FIXTURE_BYTES): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-exec-verify-"));
  const path = join(directory, HOST_ENTRYPOINT);
  await writeFile(path, content);
  return { directory, path };
}

/** Wraps the real boundary read and records how many times the bytes were read. */
function countingReads(): {
  readDigests: (platform: NodeJS.Platform, path: string) => Promise<ExecutableDigests>;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    readDigests: async (platform, path) => {
      reads.push(path);
      return await readExecutableDigests(platform, path);
    },
    reads,
  };
}

function managedEnvironment(path: string, overrides: Partial<RuntimeResolverEnvironment> = {}): RuntimeResolverEnvironment {
  return {
    managedLookup: {
      current: async () => ({ manifest: managedManifest(), entrypointPath: path, entrypointSha256: FIXTURE_SHA256 }),
    },
    probe: { probe: async () => fullOutcome() },
    ...overrides,
  };
}

test("the boundary reads the bytes before and after the probe", async () => {
  const { directory, path } = await executableFile();
  try {
    const { readDigests, reads } = countingReads();
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: false },
      { probe: { probe: async () => fullOutcome() }, readDigests },
    );
    assert.equal(resolution.classification, "compatible-system");
    assert.equal(reads.length, 2, "one read before the probe, one after it");
    // The published identity is still the frozen platform-salted digest, so
    // persisted Thread bindings keep matching.
    assert.equal(resolution.executableIdentity, await fingerprintExecutable(process.platform, path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an in-place rewrite with a restored mtime is still detected after the probe", async () => {
  const { directory, path } = await executableFile();
  try {
    const before = await stat(path);
    const { readDigests, reads } = countingReads();
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: true },
      {
        readDigests,
        probe: {
          probe: async () => {
            // The attack the stat-keyed cache could not see: same length, same
            // inode (in-place write), and the original `mtime` restored.
            await writeFile(path, TAMPERED_BYTES);
            await utimes(path, before.atime, before.mtime);
            return fullOutcome();
          },
        },
      },
    );
    const after = await stat(path);
    assert.equal(after.size, before.size, "the rewrite keeps the size");
    assert.equal(after.ino, before.ino, "the rewrite keeps the inode");
    // `utimes` restores whole milliseconds; a stat-keyed cache compares the
    // filesystem's reported value, which is exactly this granularity on NTFS
    // (100 ns ticks) and on any tree whose mtime was stamped by an installer.
    assert.equal(Math.round(after.mtimeMs), Math.round(before.mtimeMs), "the rewrite restores mtime");
    assert.equal(reads.length, 2);
    assert.equal(resolution.classification, "rejected");
    assert.equal(resolution.probeFailure, "IDENTITY_MISMATCH");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a metadata-only touch during the probe stays accepted when the bytes match", async () => {
  const { directory, path } = await executableFile();
  try {
    const { readDigests, reads } = countingReads();
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: true },
      {
        readDigests,
        probe: {
          probe: async () => {
            const stamp = new Date(Date.now() + 60_000);
            await utimes(path, stamp, stamp);
            return fullOutcome();
          },
        },
      },
    );
    assert.equal(reads.length, 2, "a touch forces a second read, not a cached answer");
    assert.equal(resolution.classification, "compatible-system");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a managed Runtime whose bytes do not match the signed checksum never reaches the probe", async () => {
  const { directory, path } = await executableFile();
  try {
    // Replace the bytes in place and put the metadata back: size, inode and
    // mtime all describe the signed file. Only a content comparison can see it.
    const original = await stat(path);
    await writeFile(path, TAMPERED_BYTES);
    await utimes(path, original.atime, original.mtime);
    let probed = 0;
    const resolution = await resolveRuntime(
      { kind: "managed" },
      managedEnvironment(path, {
        probe: {
          probe: async () => {
            probed += 1;
            return fullOutcome();
          },
        },
      }),
    );
    assert.equal(probed, 0, "the probe must never execute unverified bytes");
    assert.equal(resolution.classification, "rejected");
    assert.match(resolution.rejectionReason ?? "", /signed checksum/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a managed Runtime without a signed entrypoint digest fails closed", async () => {
  const { directory, path } = await executableFile();
  try {
    const resolution = await resolveRuntime(
      { kind: "managed" },
      {
        managedLookup: { current: async () => ({ manifest: managedManifest(), entrypointPath: path }) },
        probe: { probe: async () => fullOutcome() },
      },
    );
    assert.equal(resolution.classification, "rejected");
    assert.match(resolution.rejectionReason ?? "", /do not cover the Runtime entrypoint/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a managed Runtime replaced after the probe is rejected even when it matches its own metadata", async () => {
  const { directory, path } = await executableFile();
  try {
    const { readDigests, reads } = countingReads();
    const resolution = await resolveRuntime(
      { kind: "managed" },
      managedEnvironment(path, {
        readDigests,
        probe: {
          probe: async () => {
            await writeFile(path, TAMPERED_BYTES);
            return fullOutcome();
          },
        },
      }),
    );
    assert.equal(reads.length, 2);
    assert.equal(resolution.classification, "rejected");
    assert.equal(resolution.probeFailure, "IDENTITY_MISMATCH");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two resolves each read the bytes twice: no shared fingerprint cache", async () => {
  const { directory, path } = await executableFile();
  try {
    const { readDigests, reads } = countingReads();
    const environment = { probe: { probe: async () => fullOutcome() }, readDigests };
    const first = await resolveRuntime({ kind: "system", executable: path, allowLimited: false }, environment);
    const second = await resolveRuntime({ kind: "system", executable: path, allowLimited: false }, environment);
    assert.equal(first.classification, "compatible-system");
    assert.equal(second.classification, "compatible-system");
    assert.equal(reads.length, 4, "an execution boundary never reuses another resolve's read");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readExecutableDigests yields both the frozen identity and the plain content digest", async () => {
  const { directory, path } = await executableFile();
  try {
    const digests = await readExecutableDigests(process.platform, path);
    assert.equal(digests.contentSha256, FIXTURE_SHA256);
    assert.equal(
      digests.identity,
      `sha256:${createHash("sha256").update(`${process.platform}\0`).update(FIXTURE_BYTES).digest("hex")}`,
      "the identity algorithm (platform salt) is frozen",
    );
    assert.equal(digests.bytes, Buffer.byteLength(FIXTURE_BYTES));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed boundary read rejects instead of trusting anything", async () => {
  const { directory, path } = await executableFile();
  try {
    const resolution = await resolveRuntime(
      { kind: "system", executable: path, allowLimited: true },
      {
        probe: { probe: async () => fullOutcome() },
        readDigests: async () => {
          throw new Error("read failed");
        },
      },
    );
    assert.equal(resolution.classification, "rejected");
    assert.match(resolution.rejectionReason ?? "", /could not be fingerprinted/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a probe port is still required and its absence fails closed", async () => {
  const { directory, path } = await executableFile();
  try {
    const resolution = await resolveRuntime({ kind: "system", executable: path, allowLimited: true }, {});
    assert.equal(resolution.classification, "rejected");
    assert.equal(resolution.probeFailure, "PROBE_UNAVAILABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the probe is called with the verified path and the identity is published", async () => {
  const { directory, path } = await executableFile();
  try {
    const probed: string[] = [];
    const probe: RuntimeProbePort = {
      probe: async (context) => {
        probed.push(context.executablePath);
        return fullOutcome();
      },
    };
    const resolution = await resolveRuntime({ kind: "system", executable: path, allowLimited: true }, { probe });
    assert.deepEqual(probed, [path]);
    assert.equal(resolution.executableIdentity, await fingerprintExecutable(process.platform, path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
