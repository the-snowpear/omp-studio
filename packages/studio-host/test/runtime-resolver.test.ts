import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  CapabilityGrade,
  CapabilityManifestEntry,
  OperatorCommandManifest,
  RuntimeEpoch,
  RuntimeInstallationManifest,
  RequestId,
  RuntimeInstanceId,
  RuntimePreference,
  StateVersion,
  StudioHelloResponse,
} from "@omp-studio/studio-protocol";
import { FULL_PARITY_REQUIRED_CAPABILITIES } from "@omp-studio/studio-protocol";
import {
  buildProcessProbeArgs,
  createPathLocator,
  createProcessProbe,
  fingerprintExecutable,
  resolveRuntime,
  validateExecutablePath,
  type PathCheckPort,
  type RuntimeProbeContext,
  type RuntimeProbeOutcome,
  type RuntimeProbePort,
  type RuntimeResolution,
  type RuntimeResolverEnvironment,
} from "../src/index.js";

const epoch = 1 as RuntimeEpoch;
const stateVersion = 0 as StateVersion;

function capabilityEntries(overrides: Record<string, CapabilityGrade> = {}): CapabilityManifestEntry[] {
  return FULL_PARITY_REQUIRED_CAPABILITIES.map((id) => ({
    id,
    grade: overrides[id] ?? "stable",
    version: 1,
    evidence: `fixture:${id}`,
  }));
}


function hello(partial: Partial<StudioHelloResponse> = {}): StudioHelloResponse {
  return {
    type: "studio.hello.result",
    requestId: "hello-1" as RequestId,
    selectedProtocolVersion: 1,
    runtimeVersion: "17.2.13-studio.1",
    upstreamVersion: "17.2.13",
    upstreamCommit: "a".repeat(40),
    runtimeInstanceId: "runtime-instance-1" as RuntimeInstanceId,
    runtimeEpoch: epoch,
    capabilityManifest: {
      profile: "full-parity-v1",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-full",
      capabilities: capabilityEntries(),
    },
    commandManifestHash: "sha256:commands-full",
    stateVersion,
    challengeProof: "probe-proof",
    ...partial,
  };
}

function commandManifest(unclassifiedBuiltins: string[] = []): OperatorCommandManifest {
  return {
    generatedAt: "2026-08-11T00:00:00.000Z",
    upstreamCommit: "a".repeat(40),
    hash: "sha256:commands-full",
    commands: [],
    unclassifiedBuiltins,
  };
}

function fullOutcome(partial: Partial<RuntimeProbeOutcome> = {}): RuntimeProbeOutcome {
  return { hello: hello(), commandManifest: commandManifest(), smoke: "passed", shutdown: "passed", ...partial };
}

function probeWith(outcome: RuntimeProbeOutcome, calls: RuntimeProbeContext[] = []): RuntimeProbePort {
  return {
    probe: async (context) => {
      calls.push(context);
      return outcome;
    },
  };
}

function environment(partial: Partial<RuntimeResolverEnvironment> = {}): RuntimeResolverEnvironment {
  return { probe: probeWith(fullOutcome()), ...partial };
}

async function executableFile(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-resolver-"));
  const path = join(directory, "omp.exe");
  await writeFile(path, "fixture-bytes");
  return { directory, path };
}

function managedManifest(partial: Partial<RuntimeInstallationManifest> = {}): RuntimeInstallationManifest {
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
    entrypoint: "omp.exe",
    channel: "stable",
    ...partial,
  };
}

test("RT-001 signed-equivalent managed full-parity installation resolves as managed", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime({ kind: "managed" }, environment({ managedLookup: { current: async () => ({ manifest: managedManifest(), entrypointPath: path }) } }));
  assert.equal(resolution.classification, "managed");
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.profile, "full-parity-v1");
  assert.equal(resolution.runtimeVersion, "17.2.13-studio.1");
  assert.equal(resolution.capabilityHash, "sha256:capabilities-full");
  assert.deepEqual(resolution.missingCapabilities, []);
  assert.deepEqual(resolution.warnings, []);
  assert.equal(resolution.commandManifestVerified, true);
  assert.equal(resolution.smokeStatus, "passed");
});

test("RT-002 system runtime with a full Studio profile resolves as compatible-system", async () => {
  const { path } = await executableFile();
  const calls: RuntimeProbeContext[] = [];
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: false },
    environment({ probe: probeWith(fullOutcome(), calls) }),
  );
  assert.equal(resolution.classification, "compatible-system");
  assert.equal(resolution.source, "system");
  assert.equal(resolution.missingCapabilities.length, 0);
  assert.ok(calls.length === 1);
  assert.equal(calls[0]!.executablePath, path);
  assert.equal(calls[0]!.platform, process.platform);
  assert.equal(calls[0]!.arch, process.arch);
  assert.deepEqual(calls[0]!.supportedProtocolVersions, [1]);
  assert.ok(calls[0]!.workspaceDirectory.length > 0);
});

test("RT-003 a runtime without a Studio protocol is rejected", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith({ failure: "PROTOCOL_UNSUPPORTED" }) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.equal(resolution.probeFailure, "PROTOCOL_UNSUPPORTED");
  assert.match(resolution.rejectionReason ?? "", /protocol/u);
});

test("RT-004 partial agent API resolves as limited-system with visible missing capabilities", async () => {
  const { path } = await executableFile();
  const limitedHello = hello({
    capabilityManifest: {
      profile: "limited",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-limited",
      capabilities: capabilityEntries({ "agent.spawn": "unavailable" }).filter((entry) => entry.id !== "job.list"),
    },
  });
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ hello: limitedHello })) }),
  );
  assert.equal(resolution.classification, "limited-system");
  assert.equal(resolution.source, "system");
  assert.ok(resolution.missingCapabilities.includes("agent.spawn"));
  assert.ok(resolution.missingCapabilities.includes("job.list"));
  assert.equal(resolution.profile, "limited");
});

test("limited-system is rejected when the user disallows limited", async () => {
  const { path } = await executableFile();
  const limitedHello = hello({
    capabilityManifest: {
      profile: "full-parity-v1",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-full",
      capabilities: capabilityEntries({ "runtime.resume": "limited" }),
    },
  });
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: false },
    environment({ probe: probeWith(fullOutcome({ hello: limitedHello })) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /limited runtimes are not allowed/u);
  assert.ok(resolution.missingCapabilities.includes("runtime.resume"));
});

test("RT-005 manifest claims full parity but operations are unclassified => rejected", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ commandManifest: commandManifest(["internal.debug"]) })) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /unclassified builtins/u);
});

test("managed installation manifest with a limited profile stays managed with warnings", async () => {
  const { path } = await executableFile();
  const limitedManifest = managedManifest({
    profile: "limited",
    capabilityHash: "sha256:capabilities-limited",
    commandManifestHash: "sha256:commands-limited",
  });
  const limitedHello = hello({
    capabilityManifest: {
      profile: "limited",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-limited",
      capabilities: capabilityEntries({ "runtime.pause": "unavailable" }),
    },
    commandManifestHash: "sha256:commands-limited",
  });
  const resolution = await resolveRuntime(
    { kind: "managed" },
    environment({ managedLookup: { current: async () => ({ manifest: limitedManifest, entrypointPath: path }) }, probe: probeWith(fullOutcome({ hello: limitedHello })) }),
  );
  assert.equal(resolution.classification, "managed");
  assert.equal(resolution.profile, "limited");
  assert.ok(resolution.warnings.some((warning) => /installation profile is limited/u.test(warning)));
  assert.ok(resolution.missingCapabilities.includes("runtime.pause"));
});

test("managed manifest claiming full parity without evidence is rejected", async () => {
  const { path } = await executableFile();
  const limitedHello = hello({
    capabilityManifest: {
      profile: "full-parity-v1",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-full",
      capabilities: capabilityEntries({ "core.abort": "limited" }),
    },
  });
  const resolution = await resolveRuntime(
    { kind: "managed" },
    environment({ managedLookup: { current: async () => ({ manifest: managedManifest(), entrypointPath: path }) }, probe: probeWith(fullOutcome({ hello: limitedHello })) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /claims full parity/u);
});

test("managed Runtime is rejected when its command manifest cannot be verified", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "managed" },
    environment({
      managedLookup: { current: async () => ({ manifest: managedManifest({ profile: "limited" }), entrypointPath: path }) },
      probe: probeWith({ hello: hello({ capabilityManifest: { ...hello().capabilityManifest, profile: "limited" } }), smoke: "passed", shutdown: "passed" }),
    }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /command manifest could not be verified/u);
});

test("managed capability hash drift is rejected", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "managed" },
    environment({ managedLookup: { current: async () => ({ manifest: managedManifest({ capabilityHash: "sha256:different" }), entrypointPath: path }) } }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /capability hash drift/u);
});

// The Runtime hashes only its builtin baseline so this value stays comparable
// with the one packaging signed into runtime-manifest.json. If anything
// environment-derived ever reaches the hash again, every operator whose profile
// differs from the build machine's lands here and cannot install their way out.
test("managed command manifest hash drift is rejected", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "managed" },
    environment({
      managedLookup: {
        current: async () => ({ manifest: managedManifest({ commandManifestHash: "sha256:commands-drifted" }), entrypointPath: path }),
      },
    }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /command manifest hash drift/u);
});

test("managed installation platform mismatch is rejected", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "managed" },
    environment({ managedLookup: { current: async () => ({ manifest: managedManifest({ platform: "linux-arm64" }), entrypointPath: path }) } }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /platform/u);
});

test("a protocol version outside the Host range is rejected", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ hello: hello({ selectedProtocolVersion: 2 }) })) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /protocol version 2/u);
});

test("probe failure rejects managed and system candidates alike", async () => {
  const { path } = await executableFile();
  const managed = await resolveRuntime(
    { kind: "managed" },
    environment({ managedLookup: { current: async () => ({ manifest: managedManifest(), entrypointPath: path }) }, probe: probeWith({ failure: "PROBE_TIMEOUT" }) }),
  );
  assert.equal(managed.classification, "rejected");
  assert.equal(managed.probeFailure, "PROBE_TIMEOUT");
  const system = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith({ failure: "CONNECTION_FAILED" }) }),
  );
  assert.equal(system.classification, "rejected");
  assert.equal(system.probeFailure, "CONNECTION_FAILED");
});

test("missing probe fields fail closed", async () => {
  const { path } = await executableFile();
  const noHello = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith({}) }),
  );
  assert.equal(noHello.classification, "rejected");
  assert.match(noHello.rejectionReason ?? "", /no hello response/u);
  const noCapabilities = {
    ...hello(),
    capabilityManifest: undefined,
  } as unknown as StudioHelloResponse;
  const noCaps = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith({ hello: noCapabilities }) }),
  );
  assert.equal(noCaps.classification, "rejected");
  assert.match(noCaps.rejectionReason ?? "", /omitted the capability manifest/u);
});

test("symlinked executables are rejected", async () => {
  const { path } = await executableFile();
  const fakePathCheck: PathCheckPort = {
    lstat: async (candidate) => {
      assert.equal(candidate, path);
      return { isFile: true, isSymbolicLink: true };
    },
  };
  const resolution = await resolveRuntime(
    { kind: "custom", executable: path, allowLimited: true },
    environment({ pathCheck: fakePathCheck }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /symbolic links/u);
});

test("path validation rejects relative, missing, and non-file targets", async () => {
  const relative = await validateExecutablePath("relative\\omp.exe");
  assert.equal(relative.ok, false);
  assert.match(relative.reason ?? "", /absolute path/u);
  const missing = await validateExecutablePath(join(tmpdir(), "omp-studio-missing-xyz"));
  assert.equal(missing.ok, false);
  assert.match(missing.reason ?? "", /does not exist/u);
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-resolver-dir-"));
  const notFile = await validateExecutablePath(directory);
  assert.equal(notFile.ok, false);
  assert.match(notFile.reason ?? "", /regular file/u);
  const asResolution = await resolveRuntime(
    { kind: "system", executable: directory, allowLimited: true },
    environment(),
  );
  assert.equal(asResolution.classification, "rejected");
  assert.match(asResolution.rejectionReason ?? "", /executable rejected/u);
});

test("system PATH locator finds omp and reports not-found when absent", async () => {
  const { directory, path } = await executableFile();
  const locator = createPathLocator({ pathEnv: `${directory}${process.platform === "win32" ? ";" : ":"}${tmpdir()}` });
  assert.equal(await locator.locate(process.platform, process.arch), path);
  const empty = createPathLocator({ pathEnv: tmpdir() });
  assert.equal(await empty.locate(process.platform, process.arch), undefined);
  const resolution = await resolveRuntime(
    { kind: "system", allowLimited: true },
    environment({ locateSystemRuntime: empty }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /system runtime was not found/u);
});

test("custom runtime follows the same rules as system and keeps its source", async () => {
  const { path } = await executableFile();
  const compatible = await resolveRuntime(
    { kind: "custom", executable: path, allowLimited: false },
    environment(),
  );
  assert.equal(compatible.classification, "compatible-system");
  assert.equal(compatible.source, "custom");
  const limited = await resolveRuntime(
    { kind: "custom", executable: path, allowLimited: true },
    environment({
      probe: probeWith(
        fullOutcome({
          hello: hello({
            capabilityManifest: {
              profile: "full-parity-v1",
              generatedAt: "2026-08-11T00:00:00.000Z",
              hash: "sha256:capabilities-full",
              capabilities: capabilityEntries({ "tui.manualCompatibility": "unavailable" }),
            },
          }),
        }),
      ),
    }),
  );
  assert.equal(limited.classification, "limited-system");
  assert.ok(limited.missingCapabilities.includes("tui.manualCompatibility"));
  const denied = await resolveRuntime(
    { kind: "custom", executable: path, allowLimited: false },
    environment({
      probe: probeWith(
        fullOutcome({
          hello: hello({
            capabilityManifest: {
              profile: "full-parity-v1",
              generatedAt: "2026-08-11T00:00:00.000Z",
              hash: "sha256:capabilities-full",
              capabilities: capabilityEntries({ "remoteUi.standard": "limited" }),
            },
          }),
        }),
      ),
    }),
  );
  assert.equal(denied.classification, "rejected");
});

test("executable identity is an opaque fingerprint and never leaks the path", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: false },
    environment(),
  );
  assert.match(resolution.executableIdentity, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(!resolution.executableIdentity.includes(path));
  assert.ok(!/[A-Za-z]:[\\/]/u.test(resolution.executableIdentity));
  assert.equal(resolution.executableIdentity, await fingerprintExecutable(process.platform, path));
});

test("SEC-005 rejects a candidate whose executable changes during the probe", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({
      probe: {
        async probe() {
          await writeFile(path, "replacement-bytes");
          return fullOutcome();
        },
      },
    }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.equal(resolution.probeFailure, "IDENTITY_MISMATCH");
});

test("process probe uses the real studio-host CLI contract", () => {
  assert.deepEqual(buildProcessProbeArgs(["--no-extensions"], { endpoint: "pipe", tokenFile: "token" }), [
    "--mode",
    "studio-host",
    "--no-extensions",
    "--bridge-endpoint",
    "pipe",
    "--bridge-token-file",
    "token",
    "--bridge-runtime-epoch",
    "1",
  ]);
  assert.deepEqual(buildProcessProbeArgs(["--cwd", "D:\\\\ws"], { endpoint: "pipe", tokenFile: "token" }, 3), [
    "--mode",
    "studio-host",
    "--cwd",
    "D:\\\\ws",
    "--bridge-endpoint",
    "pipe",
    "--bridge-token-file",
    "token",
    "--bridge-runtime-epoch",
    "3",
  ]);
});

test("profile limited with all required capabilities is still limited-system", async () => {
  const { path } = await executableFile();
  const limitedProfileHello = hello({
    capabilityManifest: {
      profile: "limited",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:capabilities-limited",
      capabilities: capabilityEntries(),
    },
  });
  const allowed = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ hello: limitedProfileHello })) }),
  );
  assert.equal(allowed.classification, "limited-system");
  assert.ok(allowed.warnings.some((warning) => /profile is limited/u.test(warning)));
  const denied = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: false },
    environment({ probe: probeWith(fullOutcome({ hello: limitedProfileHello })) }),
  );
  assert.equal(denied.classification, "rejected");
});

test("smoke failure rejects even when limited is allowed", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ smoke: "failed" })) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /smoke test failed/u);
});

test("compatible Runtime classification fails closed when graceful shutdown fails", async () => {
  const { path } = await executableFile();
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ shutdown: "failed" })) }),
  );
  assert.equal(resolution.classification, "rejected");
  assert.match(resolution.rejectionReason ?? "", /graceful shutdown/u);
});

test("fail closed when no probe is configured or no managed runtime is installed", async () => {
  const { path } = await executableFile();
  const noProbe = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    { platform: process.platform, arch: process.arch },
  );
  assert.equal(noProbe.classification, "rejected");
  assert.equal(noProbe.probeFailure, "PROBE_UNAVAILABLE");
  assert.match(noProbe.rejectionReason ?? "", /probe is unavailable/u);
  const noLookup = await resolveRuntime({ kind: "managed" }, {});
  assert.equal(noLookup.classification, "rejected");
  assert.match(noLookup.rejectionReason ?? "", /no managed runtime lookup/u);
  const notInstalled = await resolveRuntime(
    { kind: "managed" },
    { managedLookup: { current: async () => undefined } },
  );
  assert.equal(notInstalled.classification, "rejected");
  assert.match(notInstalled.rejectionReason ?? "", /no managed runtime is installed/u);
});

test("process probe reports PROBE_UNAVAILABLE when the bridge bootstrap fails", async () => {
  const probe = createProcessProbe({
    createBootstrap: async () => {
      throw new Error("no windows acl provider");
    },
  });
  const outcome = await probe.probe({
    executablePath: "C:\\runtimes\\omp.exe",
    platform: "win32",
    arch: "x64",
    workspaceDirectory: tmpdir(),
    supportedProtocolVersions: [1],
    probeTimeoutMs: 1_000,
  });
  assert.equal(outcome.failure, "PROBE_UNAVAILABLE");
  assert.equal(outcome.hello, undefined);
});

test("a transient probe failure is retried and a healthy second attempt is accepted", async () => {
  const { path } = await executableFile();
  const calls: RuntimeProbeContext[] = [];
  const outcomes: RuntimeProbeOutcome[] = [{ failure: "PROBE_TIMEOUT", failureDetail: "cold first launch" }, fullOutcome()];
  const resolution = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: false },
    environment({
      probe: {
        probe: async (context) => {
          calls.push(context);
          return outcomes[calls.length - 1] ?? fullOutcome();
        },
      },
    }),
  );
  assert.equal(calls.length, 2);
  assert.equal(resolution.classification, "compatible-system");
  assert.equal(resolution.probeFailure, undefined);
  // A cold first launch pays for page faults, virus scanning and first-run
  // config creation, so the default budget is not a warm-machine guess.
  assert.equal(calls[0]?.probeTimeoutMs, 30_000);
});

test("a probe verdict is never retried and probeAttempts caps transient retries", async () => {
  const { path } = await executableFile();
  const verdictCalls: RuntimeProbeContext[] = [];
  const verdict = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith(fullOutcome({ shutdown: "failed" }), verdictCalls) }),
  );
  assert.equal(verdictCalls.length, 1);
  assert.equal(verdict.classification, "rejected");
  const transientCalls: RuntimeProbeContext[] = [];
  const transient = await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith({ failure: "CONNECTION_FAILED" }, transientCalls), probeAttempts: 3 }),
  );
  assert.equal(transientCalls.length, 3);
  assert.equal(transient.classification, "rejected");
  assert.equal(transient.probeFailure, "CONNECTION_FAILED");
  const singleCall: RuntimeProbeContext[] = [];
  await resolveRuntime(
    { kind: "system", executable: path, allowLimited: true },
    environment({ probe: probeWith({ failure: "PROBE_TIMEOUT" }, singleCall), probeAttempts: 1 }),
  );
  assert.equal(singleCall.length, 1);
});
