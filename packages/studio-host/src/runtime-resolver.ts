import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  OperatorCommandManifest,
  RuntimeInstallationManifest,
  RuntimePreference,
  RuntimeProbeResult,
  StudioHelloResponse,
} from "@omp-studio/studio-protocol";
import { FULL_PARITY_REQUIRED_CAPABILITIES, STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import { StudioBridgeClient, StudioBridgeHandshakeError, StudioBridgeRequestError } from "./bridge-client.js";
import {
  createBridgeBootstrap,
  createWindowsBridgeAclPort,
  type WindowsBridgeAclPort,
} from "./bridge-auth.js";

/**
 * WP-062 System Runtime Resolver.
 *
 * Classifies a candidate runtime as one of:
 *   "managed" | "compatible-system" | "limited-system" | "rejected"
 *
 * The classification is a probe result, never a user setting. The resolver
 * never trusts a file name or a `--version` banner: every non-rejected
 * classification requires a live Studio Hello through an injected
 * RuntimeProbePort plus capability manifest evidence. When evidence is
 * missing the resolver fails closed (rejected / limited with warnings) and
 * never claims full parity it cannot prove.
 */

export type RuntimeSource = "managed" | "system" | "custom";

export type RuntimeProbeFailureCode =
  | "PROBE_UNAVAILABLE"
  | "SPAWN_FAILED"
  | "PROBE_TIMEOUT"
  | "CONNECTION_FAILED"
  | "PROTOCOL_UNSUPPORTED"
  | "AUTHENTICATION_FAILED"
  | "MALFORMED_HELLO"
  | "IDENTITY_MISMATCH"
  | "PROCESS_CRASHED"
  | "SMOKE_FAILED"
  | "SHUTDOWN_FAILED";

/**
 * Probe budget. A cold first launch pays for page-faulting a ~150 MB
 * single-file executable, on-access virus scanning and the Runtime's own
 * first-run config creation, so the budget matches the build-time identity
 * probe in `scripts/runtime-artifact.mjs` instead of a warm-machine guess.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const DEFAULT_PROBE_ATTEMPTS = 2;

/** Drain grace for the graceful-shutdown gate, independent of the connect budget. */
const SHUTDOWN_EXIT_GRACE_MS = 10_000;

/**
 * Failures that carry no evidence about the executable itself: the candidate
 * never got far enough to say anything. Everything else (protocol, auth,
 * hello, identity, smoke, shutdown) is a verdict and is never retried.
 */
const TRANSIENT_PROBE_FAILURES: Partial<Record<RuntimeProbeFailureCode, true>> = {
  SPAWN_FAILED: true,
  PROBE_TIMEOUT: true,
  CONNECTION_FAILED: true,
  PROCESS_CRASHED: true,
};

export interface RuntimeProbeOutcome {
  /** Parsed and authenticated Studio Hello, when the probe succeeded. */
  hello?: StudioHelloResponse;
  /** Fetched operator command manifest, when the probe could verify it. */
  commandManifest?: OperatorCommandManifest;
  /** Result of the no-side-effect smoke operations (snapshot/receipt correlation). */
  smoke?: "passed" | "failed" | "skipped";
  /** Graceful runtime.shutdown(drain=true) compatibility gate result. */
  shutdown?: "passed" | "failed" | "skipped";
  /** Present exactly when the probe could not produce a hello. */
  failure?: RuntimeProbeFailureCode;
  /** Host-side diagnostics; never rendered to a Renderer. */
  failureDetail?: string;
}

export interface RuntimeProbeContext {
  /** Resolved absolute path of the candidate executable. */
  executablePath: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Empty temporary workspace handed to the runtime under probe. */
  workspaceDirectory: string;
  supportedProtocolVersions: readonly number[];
  probeTimeoutMs: number;
}

/**
 * Injectable seam for the actual process/Bridge probe. The resolver is
 * deterministic: it only classifies from whatever this port returns and never
 * executes anything itself. Production callers wire `createProcessProbe()`;
 * tests inject fakes so no untrusted file is ever executed.
 */
export interface RuntimeProbePort {
  probe(context: RuntimeProbeContext): Promise<RuntimeProbeOutcome>;
}

export interface ManagedRuntimeInstallation {
  manifest: RuntimeInstallationManifest;
  /** Absolute path of the installed entrypoint. */
  entrypointPath: string;
}

/** Read-only current managed installation lookup (satisfied by RuntimeInstaller#currentManifest). */
export interface ManagedRuntimeLookup {
  current(): Promise<ManagedRuntimeInstallation | undefined>;
}

export interface SystemRuntimeLocator {
  locate(platform: NodeJS.Platform, arch: string): Promise<string | undefined>;
}

export interface PathCheckPort {
  lstat(path: string): Promise<{ isFile: boolean; isSymbolicLink: boolean }>;
}

export interface RuntimeResolverEnvironment {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Protocol versions this Host supports; defaults to [STUDIO_PROTOCOL_VERSION]. */
  supportedProtocolVersions?: readonly number[];
  /** Capabilities required for a full-parity claim; defaults to FULL_PARITY_REQUIRED_CAPABILITIES. */
  requiredCapabilities?: readonly string[];
  /** Managed current-manifest lookup; required for `{ kind: "managed" }`. */
  managedLookup?: ManagedRuntimeLookup;
  /** System PATH locator; used when `{ kind: "system" }` has no explicit executable. */
  locateSystemRuntime?: SystemRuntimeLocator;
  /** Live probe port; when absent every candidate is rejected (fail closed). */
  probe?: RuntimeProbePort;
  /** Injectable path checks; defaults to node:fs lstat. */
  pathCheck?: PathCheckPort;
  /** Workspace handed to the probe; defaults to os.tmpdir(). */
  workspaceDirectory?: string;
  probeTimeoutMs?: number;
  /**
   * Attempts for a *transient* probe failure (timeout, connection loss, spawn
   * or crash). First install is the worst case: a freshly written 150 MB
   * single-file executable is cold on disk, on-access virus scanning runs
   * against it, and the Runtime creates its config tree during the very first
   * launch. A single cold attempt is not evidence that the executable is
   * broken. Evidence requirements never change between attempts; only
   * transient codes are retried. Defaults to 2, minimum 1.
   */
  probeAttempts?: number;
}

export interface RuntimeResolution extends RuntimeProbeResult {
  source: RuntimeSource;
  /** Backend/profile evidence behind the classification. */
  profile?: "full-parity-v1" | "limited";
  commandManifestVerified: boolean;
  smokeStatus: "passed" | "failed" | "skipped";
  shutdownStatus: "passed" | "failed" | "skipped";
  /** Host-side probe failure code; the Renderer-facing reason stays in `rejectionReason`. */
  probeFailure?: RuntimeProbeFailureCode;
}

interface Candidate {
  source: RuntimeSource;
  executablePath: string;
  allowLimited: boolean;
  installationManifest?: RuntimeInstallationManifest;
}

export interface ExecutablePathCheck {
  ok: boolean;
  /** Normalized absolute path, present when ok. */
  absolutePath?: string;
  reason?: string;
}

export const nodePathCheckPort: PathCheckPort = {
  async lstat(path) {
    const metadata = await lstat(path);
    return { isFile: metadata.isFile(), isSymbolicLink: metadata.isSymbolicLink() };
  },
};

/**
 * Regular-file, non-symlink, absolute-path validation. Managed entrypoints
 * must also pass; nothing is trusted because of where it came from.
 */
export async function validateExecutablePath(
  input: string,
  platform: NodeJS.Platform = process.platform,
  pathCheck: PathCheckPort = nodePathCheckPort,
): Promise<ExecutablePathCheck> {
  if (!isAbsolute(input)) {
    return { ok: false, reason: "executable path must be an absolute path" };
  }
  const absolutePath = resolve(input);
  let metadata: { isFile: boolean; isSymbolicLink: boolean };
  try {
    metadata = await pathCheck.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "executable does not exist" };
    }
    throw error;
  }
  if (metadata.isSymbolicLink) {
    return { ok: false, reason: "symbolic links are not allowed" };
  }
  if (!metadata.isFile) {
    return { ok: false, reason: "executable must be a regular file" };
  }
  return { ok: true, absolutePath };
}

/** Opaque executable-content fingerprint. Never contains the original path. */
export async function fingerprintExecutable(platform: NodeJS.Platform, absolutePath: string): Promise<string> {
  const hash = createHash("sha256").update(`${platform}\0`);
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * PATH-based system runtime locator. Empty PATH entries are skipped so a
 * relative "current directory" can never be resolved implicitly.
 */
export function createPathLocator(options: {
  pathEnv?: string;
  executableName?: string;
  exists?: (candidate: string) => Promise<boolean>;
} = {}): SystemRuntimeLocator {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const executableName = options.executableName;
  const exists = options.exists;
  return {
    async locate(platform) {
      const name = executableName ?? (platform === "win32" ? "omp.exe" : "omp");
      for (const directory of pathEnv.split(platform === "win32" ? ";" : ":")) {
        if (directory.length === 0) continue;
        const candidate = join(directory, name);
        if (!isAbsolute(candidate)) continue;
        let found = false;
        if (exists !== undefined) {
          found = await exists(candidate);
        } else {
          try {
            const metadata = await lstat(candidate);
            found = metadata.isFile() && !metadata.isSymbolicLink();
          } catch {
            found = false;
          }
        }
        if (found) return candidate;
      }
      return undefined;
    },
  };
}

/** Deterministic resolver core. See module docs for the classification rules. */
export async function resolveRuntime(
  preference: RuntimePreference,
  environment: RuntimeResolverEnvironment = {},
): Promise<RuntimeResolution> {
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  const supportedProtocolVersions = environment.supportedProtocolVersions ?? [STUDIO_PROTOCOL_VERSION];
  const requiredCapabilities = environment.requiredCapabilities ?? FULL_PARITY_REQUIRED_CAPABILITIES;
  const pathCheck = environment.pathCheck ?? nodePathCheckPort;

  const candidate = await resolveCandidate(preference, environment, platform, arch);
  if (candidate.kind === "error") {
    return rejectedResolution(candidate.source, candidate.reason);
  }

  const candidateInfo = candidate.candidate;
  const pathValidation = await validateExecutablePath(candidateInfo.executablePath, platform, pathCheck);
  if (!pathValidation.ok) {
    return rejectedResolution(candidateInfo.source, `executable rejected: ${pathValidation.reason}`);
  }
  const executablePath = pathValidation.absolutePath as string;
  let executableIdentity: string;
  try {
    executableIdentity = await fingerprintExecutable(platform, executablePath);
  } catch {
    return rejectedResolution(candidateInfo.source, "executable could not be fingerprinted");
  }

  if (candidateInfo.source === "managed") {
    const installationManifest = candidateInfo.installationManifest as RuntimeInstallationManifest;
    const expectedPlatform = `${platform}-${arch}`;
    if (installationManifest.platform !== expectedPlatform) {
      return rejectedResolution("managed", `installation platform ${installationManifest.platform} does not match ${expectedPlatform}`);
    }
    if (!overlapsProtocolRange(installationManifest.studioProtocol, supportedProtocolVersions)) {
      return rejectedResolution("managed", "installation protocol range is not supported by this Host");
    }
  }

  if (environment.probe === undefined) {
    return rejectedResolution(candidateInfo.source, "runtime probe is unavailable; runtime was not verified", {
      probeFailure: "PROBE_UNAVAILABLE",
    });
  }

  const probeContext = {
    executablePath,
    platform,
    arch,
    workspaceDirectory: environment.workspaceDirectory ?? tmpdir(),
    supportedProtocolVersions,
    probeTimeoutMs: environment.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
  const attempts = Math.max(1, Math.trunc(environment.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS));
  let outcome = await environment.probe.probe(probeContext);
  for (
    let attempt = 2;
    attempt <= attempts && outcome.failure !== undefined && TRANSIENT_PROBE_FAILURES[outcome.failure] === true;
    attempt += 1
  ) {
    outcome = await environment.probe.probe(probeContext);
  }
  try {
    if ((await fingerprintExecutable(platform, executablePath)) !== executableIdentity) {
      return rejectedResolution(candidateInfo.source, describeProbeFailure("IDENTITY_MISMATCH"), {
        probeFailure: "IDENTITY_MISMATCH",
      });
    }
  } catch {
    return rejectedResolution(candidateInfo.source, describeProbeFailure("IDENTITY_MISMATCH"), {
      probeFailure: "IDENTITY_MISMATCH",
    });
  }
  if (outcome.failure !== undefined) {
    return rejectedResolution(candidateInfo.source, describeProbeFailure(outcome.failure), {
      probeFailure: outcome.failure,
    });
  }
  const hello = outcome.hello;
  if (hello === undefined) {
    return rejectedResolution(candidateInfo.source, "runtime probe returned no hello response");
  }
  if (hello.capabilityManifest === undefined) {
    return rejectedResolution(candidateInfo.source, "runtime hello omitted the capability manifest");
  }
  if (!supportedProtocolVersions.includes(hello.selectedProtocolVersion)) {
    return rejectedResolution(
      candidateInfo.source,
      `runtime selected protocol version ${hello.selectedProtocolVersion} which is not supported`,
    );
  }

  const capabilityById = new Map(hello.capabilityManifest.capabilities.map((entry) => [entry.id, entry]));
  const missingCapabilities = requiredCapabilities.filter((id) => {
    const entry = capabilityById.get(id);
    return entry === undefined || entry.grade === "limited" || entry.grade === "unavailable";
  });

  const commandManifestVerified = outcome.commandManifest !== undefined;
  const unclassifiedBuiltins = outcome.commandManifest?.unclassifiedBuiltins ?? [];
  const hasUnclassifiedBuiltins = unclassifiedBuiltins.length > 0;
  const smokeStatus = outcome.smoke ?? "skipped";
  const shutdownStatus = outcome.shutdown ?? "skipped";
  const profile = hello.capabilityManifest.profile;

  const warnings: string[] = [];
  if (smokeStatus === "skipped") warnings.push("no-side-effect smoke test was not performed");
  if (shutdownStatus === "skipped") warnings.push("graceful shutdown probe was not performed");
  if (!commandManifestVerified) warnings.push("command manifest was not verified");
  if (hasUnclassifiedBuiltins) warnings.push(`command manifest contains ${unclassifiedBuiltins.length} unclassified builtin(s)`);
  if (missingCapabilities.length > 0) warnings.push(`missing required capabilities: ${missingCapabilities.join(", ")}`);

  // Deception or instability is always Rejected, even when limited is allowed.
  if (hasUnclassifiedBuiltins) {
    return rejectedResolution(candidateInfo.source, "runtime command manifest contains unclassified builtins");
  }
  if (smokeStatus === "failed") {
    return rejectedResolution(candidateInfo.source, "runtime no-side-effect smoke test failed");
  }
  if (shutdownStatus === "failed") {
    return rejectedResolution(candidateInfo.source, "runtime graceful shutdown probe failed");
  }

  const shared = {
    source: candidateInfo.source,
    executableIdentity,
    runtimeVersion: hello.runtimeVersion,
    upstreamVersion: hello.upstreamVersion,
    upstreamCommit: hello.upstreamCommit,
    selectedProtocolVersion: hello.selectedProtocolVersion,
    capabilityHash: hello.capabilityManifest.hash,
    commandManifestHash: hello.commandManifestHash,
    commandManifestVerified,
    smokeStatus,
    shutdownStatus,
  };

  if (candidateInfo.source === "managed") {
    return classifyManaged(candidateInfo.installationManifest as RuntimeInstallationManifest, hello, profile, {
      ...shared,
      missingCapabilities,
      warnings,
    });
  }

  // system / custom follow identical rules; only the source label differs.
  if (
    profile === "full-parity-v1" &&
    missingCapabilities.length === 0 &&
    commandManifestVerified &&
    smokeStatus === "passed" &&
    shutdownStatus === "passed"
  ) {
    return { ...shared, classification: "compatible-system", profile: "full-parity-v1", missingCapabilities: [], warnings: [] };
  }
  if (profile === "limited") warnings.push("runtime profile is limited; only probed routes are supported");
  if (candidateInfo.allowLimited) {
    return { ...shared, classification: "limited-system", profile, missingCapabilities, warnings };
  }
  const detail = missingCapabilities.length > 0 ? `; missing: ${missingCapabilities.join(", ")}` : "";
  return rejectedResolution(candidateInfo.source, `runtime is limited and limited runtimes are not allowed${detail}`, { missingCapabilities });
}

function classifyManaged(
  installationManifest: RuntimeInstallationManifest,
  hello: StudioHelloResponse,
  helloProfile: "full-parity-v1" | "limited",
  evidence: Omit<RuntimeResolution, "classification" | "profile" | "missingCapabilities" | "warnings"> & {
    missingCapabilities: string[];
    warnings: string[];
  },
): RuntimeResolution {
  // A checksummed installation manifest that overclaims its evidence is
  // treated as damaged or mislabeled, mirroring RT-005.
  if (
    installationManifest.profile === "full-parity-v1" &&
    (helloProfile === "limited" || evidence.missingCapabilities.length > 0)
  ) {
    return rejectedResolution("managed", "installation manifest claims full parity but the runtime evidence does not support it");
  }
  if (installationManifest.capabilityHash !== hello.capabilityManifest.hash) {
    return rejectedResolution("managed", "managed runtime capability hash drift");
  }
  if (installationManifest.commandManifestHash !== hello.commandManifestHash) {
    return rejectedResolution("managed", "managed runtime command manifest hash drift");
  }

  const profile =
    installationManifest.profile === "limited" || helloProfile === "limited" ? "limited" : "full-parity-v1";
  if (!evidence.commandManifestVerified) {
    return rejectedResolution("managed", "managed runtime command manifest could not be verified");
  }
  if (installationManifest.profile === "limited") {
    evidence.warnings.push("managed runtime installation profile is limited; only probed routes are supported");
  }
  if (helloProfile === "limited") {
    evidence.warnings.push("runtime hello reports a limited capability profile");
  }
  return { ...evidence, classification: "managed", profile };
}

async function resolveCandidate(
  preference: RuntimePreference,
  environment: RuntimeResolverEnvironment,
  platform: NodeJS.Platform,
  arch: string,
): Promise<{ kind: "ok"; candidate: Candidate } | { kind: "error"; source: RuntimeSource; reason: string }> {
  if (preference.kind === "managed") {
    if (environment.managedLookup === undefined) {
      return { kind: "error", source: "managed", reason: "no managed runtime lookup is configured" };
    }
    const installation = await environment.managedLookup.current();
    if (installation === undefined) {
      return { kind: "error", source: "managed", reason: "no managed runtime is installed" };
    }
    return {
      kind: "ok",
      candidate: {
        source: "managed",
        executablePath: installation.entrypointPath,
        allowLimited: false,
        installationManifest: installation.manifest,
      },
    };
  }
  if (preference.kind === "system") {
    const executable =
      preference.executable ?? (environment.locateSystemRuntime === undefined ? undefined : await environment.locateSystemRuntime.locate(platform, arch));
    if (executable === undefined) {
      return { kind: "error", source: "system", reason: "system runtime was not found" };
    }
    return { kind: "ok", candidate: { source: "system", executablePath: executable, allowLimited: preference.allowLimited } };
  }
  return {
    kind: "ok",
    candidate: { source: "custom", executablePath: preference.executable, allowLimited: preference.allowLimited },
  };
}

function overlapsProtocolRange(range: { min: number; max: number }, supported: readonly number[]): boolean {
  return supported.some((version) => version >= range.min && version <= range.max);
}

function describeProbeFailure(code: RuntimeProbeFailureCode): string {
  switch (code) {
    case "PROBE_UNAVAILABLE":
      return "runtime probe is unavailable";
    case "SPAWN_FAILED":
      return "runtime process failed to start";
    case "PROBE_TIMEOUT":
      return "runtime probe timed out";
    case "CONNECTION_FAILED":
      return "runtime probe connection failed";
    case "PROTOCOL_UNSUPPORTED":
      return "runtime protocol is unsupported";
    case "AUTHENTICATION_FAILED":
      return "runtime failed host authentication";
    case "MALFORMED_HELLO":
      return "runtime returned a malformed Studio hello";
    case "IDENTITY_MISMATCH":
      return "runtime identity changed during the probe";
    case "PROCESS_CRASHED":
      return "runtime process crashed during the probe";
    case "SMOKE_FAILED":
      return "runtime no-side-effect smoke test failed";
    case "SHUTDOWN_FAILED":
      return "runtime graceful shutdown probe failed";
  }
}

function rejectedResolution(
  source: RuntimeSource,
  reason: string,
  extra: { probeFailure?: RuntimeProbeFailureCode; missingCapabilities?: string[]; warnings?: string[] } = {},
): RuntimeResolution {
  return {
    source,
    classification: "rejected",
    executableIdentity: "",
    missingCapabilities: extra.missingCapabilities ?? [],
    warnings: extra.warnings ?? [],
    commandManifestVerified: false,
    smokeStatus: "skipped",
    shutdownStatus: "skipped",
    rejectionReason: reason,
    ...(extra.probeFailure === undefined ? {} : { probeFailure: extra.probeFailure }),
  };
}

export interface ProcessProbeOptions {
  /** Additional CLI args inserted before the reserved Studio Bridge arguments. */
  args?: readonly string[];
  /** Extra environment variables merged over process.env for the child. */
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  /** Injectable bootstrap; defaults to createBridgeBootstrap with `windowsAcl`. */
  createBootstrap?: (workspaceDirectory: string, platform: NodeJS.Platform) => Promise<{
    endpoint: string;
    token: string;
    tokenFile: string;
  }>;
  /** Required on win32 when using the default createBridgeBootstrap. */
  windowsAcl?: WindowsBridgeAclPort;
  connectSocket?: (endpoint: string) => Socket;
  /** Drain grace for the shutdown gate; defaults to SHUTDOWN_EXIT_GRACE_MS. */
  shutdownGraceMs?: number;
  /** Remove the temporary probe workspace afterwards; defaults to true. */
  cleanupWorkspace?: boolean;
}

const PROBE_RUNTIME_EPOCH = 1;

export function buildProcessProbeArgs(
  additionalArgs: readonly string[],
  bootstrap: { endpoint: string; tokenFile: string },
  runtimeEpoch: number = PROBE_RUNTIME_EPOCH,
): string[] {
  if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 1) {
    throw new TypeError("runtimeEpoch must be a positive integer");
  }
  return [
    "--mode",
    "studio-host",
    ...additionalArgs,
    "--bridge-endpoint",
    bootstrap.endpoint,
    "--bridge-token-file",
    bootstrap.tokenFile,
    "--bridge-runtime-epoch",
    String(runtimeEpoch),
  ];
}

/**
 * Real host-side probe: spawns the candidate with a fresh empty temporary
 * workspace and Bridge bootstrap, authenticates with a Studio Hello through
 * StudioBridgeClient, fetches and validates the command manifest, and runs the
 * snapshot smoke operation. Nothing here trusts the executable name or a
 * `--version` banner.
 */
export function createProcessProbe(options: ProcessProbeOptions = {}): RuntimeProbePort {
  return {
    async probe(context) {
      const workspace = await mkdtemp(join(resolve(context.workspaceDirectory), "omp-studio-probe-"));
      const cleanup = options.cleanupWorkspace !== false;
      let bootstrap: { endpoint: string; token: string; tokenFile: string };
      try {
        bootstrap =
          options.createBootstrap !== undefined
            ? await options.createBootstrap(workspace, context.platform)
            : await createBridgeBootstrap(
                workspace,
                context.platform,
                options.windowsAcl ?? (context.platform === "win32" ? createWindowsBridgeAclPort() : undefined),
              );
      } catch (error) {
        await removeWorkspace(workspace, cleanup);
        return { failure: "PROBE_UNAVAILABLE", failureDetail: (error as Error).message };
      }

      let child: ChildProcess;
      try {
        child = (options.spawnProcess ?? spawn)(
          context.executablePath,
          buildProcessProbeArgs(options.args ?? [], bootstrap),
          {
          cwd: workspace,
          env: {
            ...process.env,
            ...options.env,
          },
          stdio: "ignore",
          windowsHide: true,
          },
        );
      } catch (error) {
        await removeWorkspace(workspace, cleanup);
        return { failure: "SPAWN_FAILED", failureDetail: (error as Error).message };
      }

      let client: StudioBridgeClient | undefined;
      const deadline = Date.now() + context.probeTimeoutMs;
      try {
        let hello: StudioHelloResponse | undefined;
        while (hello === undefined) {
          client = new StudioBridgeClient({
            endpoint: bootstrap.endpoint,
            token: bootstrap.token,
            handshakeTimeoutMs: Math.max(1, deadline - Date.now()),
            supportedProtocolVersions: context.supportedProtocolVersions,
            ...(options.connectSocket === undefined ? {} : { connectSocket: options.connectSocket }),
          });
          try {
            hello = await client.connect();
          } catch (error) {
            client.close();
            client = undefined;
            if (
              !(error instanceof StudioBridgeHandshakeError) ||
              error.code !== "CONNECTION_FAILED" ||
              Date.now() >= deadline
            ) {
              throw error;
            }
            if (child.exitCode !== null || child.signalCode !== null) {
              return { failure: "PROCESS_CRASHED", failureDetail: `child exited with code ${child.exitCode}` };
            }
            await delay(Math.min(50, Math.max(1, deadline - Date.now())));
          }
        }
        if (child.exitCode !== null) {
          return { failure: "PROCESS_CRASHED", failureDetail: `child exited with code ${child.exitCode}` };
        }
        const connectedClient = client;
        if (connectedClient === undefined) throw new Error("Runtime probe connected without a Bridge client");
        let smoke: "passed" | "failed" = "passed";
        // Command invocation is intentionally unavailable until the initial
        // snapshot has established the projection/epoch baseline.
        try {
          await connectedClient.requestSnapshot();
        } catch {
          smoke = "failed";
        }
        let commandManifest: OperatorCommandManifest | undefined;
        let commandManifestIdentityMismatch = false;
        try {
          if (smoke !== "passed") throw new Error("Initial Runtime snapshot failed");
          commandManifest = await connectedClient.requestCommandManifest();
          if (
            commandManifest.hash !== hello.commandManifestHash ||
            commandManifest.upstreamCommit !== hello.upstreamCommit
          ) {
            commandManifestIdentityMismatch = true;
            commandManifest = undefined;
          }
        } catch {
          // A limited System Runtime may not implement the manifest route. It
          // remains eligible only for an explicitly allowed limited result.
          commandManifest = undefined;
        }
        let shutdown: "passed" | "failed" | "skipped" = "skipped";
        if (connectedClient.state === "ready") {
          // The Runtime destroys its Bridge socket while exiting, so the
          // shutdown receipt can be dropped in flight. A lost ack is a
          // delivery race; graceful shutdown is proven by a clean exit.
          let ackFailed = false;
          try {
            await connectedClient.shutdown();
          } catch (error) {
            ackFailed = !(error instanceof StudioBridgeRequestError || error instanceof StudioBridgeHandshakeError);
          }
          // The drain wait is deliberately independent of the connect budget:
          // a runtime that answered late still gets the full grace to exit.
          const exited = await childExitsWithin(child, options.shutdownGraceMs ?? SHUTDOWN_EXIT_GRACE_MS);
          shutdown = !ackFailed && exited && child.exitCode === 0 ? "passed" : "failed";
        }
        if (commandManifestIdentityMismatch) {
          return {
            hello,
            smoke,
            shutdown,
            failure: "IDENTITY_MISMATCH",
            failureDetail: "Runtime command manifest identity does not match Studio Hello",
          };
        }
        return { hello, ...(commandManifest === undefined ? {} : { commandManifest }), smoke, shutdown };
      } catch (error) {
        if (error instanceof StudioBridgeHandshakeError) {
          const failure =
            error.code === "CONNECTION_FAILED" && Date.now() >= deadline
              ? "PROBE_TIMEOUT"
              : mapHandshakeFailure(error.code);
          return { failure, failureDetail: error.message };
        }
        return { failure: "CONNECTION_FAILED", failureDetail: (error as Error).message };
      } finally {
        client?.close();
        child.kill();
        await waitForChildExit(child);
        await removeWorkspace(workspace, cleanup);
      }
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function mapHandshakeFailure(
  code: "CONNECTION_FAILED" | "HANDSHAKE_TIMEOUT" | "PROTOCOL_UNSUPPORTED" | "UNAUTHENTICATED" | "IDENTITY_CHANGED" | "MALFORMED_RESPONSE",
): RuntimeProbeFailureCode {
  switch (code) {
    case "CONNECTION_FAILED":
      return "CONNECTION_FAILED";
    case "HANDSHAKE_TIMEOUT":
      return "PROBE_TIMEOUT";
    case "PROTOCOL_UNSUPPORTED":
      return "PROTOCOL_UNSUPPORTED";
    case "UNAUTHENTICATED":
      return "AUTHENTICATION_FAILED";
    case "IDENTITY_CHANGED":
      return "IDENTITY_MISMATCH";
    case "MALFORMED_RESPONSE":
      return "MALFORMED_HELLO";
  }
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function childExitsWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolveExit => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolveExit(false);
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("close", onClose);
  });
}

async function removeWorkspace(workspace: string, cleanup: boolean): Promise<void> {
  if (!cleanup) return;
  try {
    await rm(workspace, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of an ephemeral probe workspace.
  }
}
