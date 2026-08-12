// WP-002: reproducible Windows Runtime artifact metadata pipeline.
//
// Generates the installer-consumed metadata files for a built managed
// Runtime artifact:
//
//   runtime-manifest.json   contract fields per RuntimeInstallationManifest
//                           (packages/studio-protocol/src/contracts/runtime.ts)
//   checksums.json          sha256 per artifact file, covering the entrypoint
//                           and runtime-manifest.json itself
//   runtime-signature.json  Ed25519 signature over the exact manifest and
//                           checksum bytes (joined by a NUL byte)
//
// Determinism rules
// -----------------
// Every emitted value is derived from the real pin (omp-patch/upstream.json),
// the real patch series (omp-patch/patches/series.json), the pinned vendor
// package version, and the built binary bytes. The emitted JSON contains no
// timestamps and no absolute paths; two runs over identical inputs produce
// byte-identical files. Key order is fixed by construction.
//
// Runtime identity
// ----------------
// The managed Runtime currently exposes a verified backend capability subset.
// The capability hash is mirrored here so a stale package definition fails
// closed. The command manifest hash is never reconstructed here: packaging
// probes the just-built Runtime and records its authenticated live value.
//
// Entrypoint naming
// -----------------
// The managed Runtime CLI is always `omp.exe` on Windows (upstream pin).
// `omp-studio.exe` is reserved for the future desktop application and is
// rejected here.

import { createHash, sign as signPayload } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

export const MANAGED_ENTRYPOINT = "omp.exe";

// Must stay in sync with STUDIO_PROTOCOL_VERSION in
// packages/studio-protocol/src/contracts/protocol.ts.
export const STUDIO_PROTOCOL_RANGE = Object.freeze({ min: 1, max: 1 });

export const IMPLEMENTED_CAPABILITIES = Object.freeze([
  "runtime.pause",
  "runtime.resume",
  "runtime.snapshot",
  "runtime.shutdown",
  "live.start",
  "live.stop",
  "queue.enqueue",
  "session.clearContext",
  "session.drop",
  "turn.retry",
  "core.prompt",
  "core.steer",
  "core.followUp",
  "core.abort",
  "loop.enable",
  "loop.pause",
  "loop.disable",
  "mode.plan.enter",
  "mode.plan.exit",
  "mode.plan.review.open",
  "mode.plan.review.respond",
  "mode.vibe.enter",
  "mode.vibe.exit",
  "goal.create",
  "goal.replace",
  "goal.show",
  "goal.setBudget",
  "goal.pause",
  "goal.resume",
  "goal.drop",
  "goal.guided.start",
  "btw.ask",
  "btw.abort",
  "btw.branch",
  "tan.start",
  "omfg.generate",
  "omfg.amend",
  "omfg.commit",
  "agent.list",
  "agent.get",
  "agent.spawn",
  "agent.send",
  "agent.kill",
  "agent.revive",
  "agent.release",
  "agent.transcript.read",
  "agent.subscribe",
  "job.list",
  "job.get",
  "job.cancel",
  "job.subscribe",
  "session.tree.get",
  "session.tree.navigate",
  "session.fork",
  "operator.manifest.get",
  "operator.invoke",
  "interaction.respond",
  "tui.transfer",
  "remoteUi.standard",
  "tui.manualCompatibility",
]);

export const LIMITED_CAPABILITIES = Object.freeze({
  "live.start": ["Requires a frontend-owned authenticated audio device and media sideband"],
  "live.stop": ["Live start is unavailable until a frontend media sideband is attached"],
  "loop.enable": ["Token limits are unsupported; use turns or minutes"],
});

export const UPSTREAM_JSON_PATH = join(REPOSITORY_ROOT, "omp-patch", "upstream.json");
export const SERIES_JSON_PATH = join(REPOSITORY_ROOT, "omp-patch", "patches", "series.json");
export const PATCHES_DIRECTORY = join(REPOSITORY_ROOT, "omp-patch", "patches");
export const VENDOR_DIRECTORY = join(REPOSITORY_ROOT, "omp-patch", "vendor", "oh-my-pi");
export const VENDOR_CODING_AGENT_PACKAGE_JSON = join(
  VENDOR_DIRECTORY,
  "packages",
  "coding-agent",
  "package.json",
);

export function defaultBinaryPath() {
  return join(
    VENDOR_DIRECTORY,
    "packages",
    "coding-agent",
    "dist",
    process.platform === "win32" ? "omp.exe" : "omp",
  );
}

export function defaultArtifactDirectory(platform, runtimeVersion) {
  return join(
    REPOSITORY_ROOT,
    "packages",
    "runtime-installer",
    "dist",
    "artifacts",
    platform,
    runtimeVersion,
  );
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function implementedManifestHash(kind) {
  if (kind !== "capabilities") {
    throw new Error(`Only the capability manifest is statically reproducible; found ${kind}`);
  }
  const content = IMPLEMENTED_CAPABILITIES.map((id) => ({
    id,
    grade: LIMITED_CAPABILITIES[id] === undefined ? "stable" : "limited",
    limitations: LIMITED_CAPABILITIES[id] ?? [],
  }));
  return `sha256:${sha256Hex(`${kind}:${JSON.stringify(content)}`)}`;
}

export async function probeRuntimeIdentity({
  binaryPath,
  platform = process.platform,
  arch = process.arch,
  workspaceDirectory,
  probeTimeoutMs = 30_000,
} = {}) {
  if (typeof binaryPath !== "string" || binaryPath.length === 0) {
    throw new Error("A built Runtime binary is required for identity probing");
  }
  let createProcessProbe;
  try {
    ({ createProcessProbe } = await import("../packages/studio-host/dist/src/index.js"));
  } catch (error) {
    throw new Error(`Studio Host must be built before Runtime identity probing: ${error.message}`);
  }
  const { tmpdir } = await import("node:os");
  const outcome = await createProcessProbe().probe({
    executablePath: resolve(binaryPath),
    platform,
    arch,
    workspaceDirectory: resolve(workspaceDirectory ?? tmpdir()),
    supportedProtocolVersions: [STUDIO_PROTOCOL_RANGE.max],
    probeTimeoutMs,
  });
  if (outcome.failure !== undefined) {
    throw new Error(`Runtime identity probe failed (${outcome.failure}): ${outcome.failureDetail ?? "no detail"}`);
  }
  if (outcome.hello === undefined) throw new Error("Runtime identity probe returned no Studio Hello");
  if (outcome.commandManifest === undefined) {
    throw new Error("Runtime identity probe could not verify the operator command manifest");
  }
  if (outcome.smoke !== "passed") throw new Error(`Runtime identity smoke check was ${outcome.smoke ?? "skipped"}`);
  if (outcome.shutdown !== "passed") {
    throw new Error(`Runtime identity graceful shutdown check was ${outcome.shutdown ?? "skipped"}`);
  }
  if (outcome.commandManifest.unclassifiedBuiltins.length > 0) {
    throw new Error("Runtime operator command manifest contains unclassified builtins");
  }
  return {
    runtimeVersion: outcome.hello.runtimeVersion,
    upstreamVersion: outcome.hello.upstreamVersion,
    upstreamCommit: outcome.hello.upstreamCommit,
    selectedProtocolVersion: outcome.hello.selectedProtocolVersion,
    profile: outcome.hello.capabilityManifest.profile,
    capabilityHash: outcome.hello.capabilityManifest.hash,
    commandManifestHash: outcome.commandManifest.hash,
  };
}

// Deterministic serialization used for every emitted file and hash input:
// two-space indentation, fixed key order, trailing newline.
export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function derivePatchsetVersion(series) {
  return `studio.${series.patches.length}`;
}

export function deriveRuntimeVersion(upstreamVersion, series) {
  return `${upstreamVersion}-${derivePatchsetVersion(series)}`;
}

function asRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertRuntimeIdentity(identity, expected) {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Authenticated Runtime identity evidence is required for packaging");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (identity[field] !== value) {
      throw new Error(`Runtime identity ${field} mismatch: expected ${value}, found ${identity[field] ?? "missing"}`);
    }
  }
  if (identity.selectedProtocolVersion !== STUDIO_PROTOCOL_RANGE.max) {
    throw new Error(`Runtime identity selected unsupported protocol ${identity.selectedProtocolVersion ?? "missing"}`);
  }
  if (identity.profile !== "limited") {
    throw new Error(`Runtime identity profile mismatch: expected limited, found ${identity.profile ?? "missing"}`);
  }
  const expectedCapabilityHash = implementedManifestHash("capabilities");
  if (identity.capabilityHash !== expectedCapabilityHash) {
    throw new Error("Runtime identity capability hash does not match the packaged capability definition");
  }
  for (const field of ["capabilityHash", "commandManifestHash"]) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(identity[field] ?? "")) {
      throw new Error(`Runtime identity ${field} is not a sha256 digest`);
    }
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export async function readUpstreamPin(path = UPSTREAM_JSON_PATH) {
  const pin = asRecord(JSON.parse(await readFile(path, "utf8")), "upstream pin");
  const commit = requiredString(pin.commit, "upstream pin commit");
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new TypeError(`upstream pin commit is not a 40-hex sha: ${commit}`);
  }
  return {
    repository: requiredString(pin.repository, "upstream pin repository"),
    commit,
    firstPlatform: requiredString(pin.firstPlatform, "upstream pin firstPlatform"),
    entrypoint: requiredString(pin.entrypoint, "upstream pin entrypoint"),
  };
}

export async function readPatchSeries(path = SERIES_JSON_PATH) {
  const series = asRecord(JSON.parse(await readFile(path, "utf8")), "patch series");
  const upstreamCommit = requiredString(series.upstreamCommit, "patch series upstreamCommit");
  if (!/^[a-f0-9]{40}$/u.test(upstreamCommit)) {
    throw new TypeError(`patch series upstreamCommit is not a 40-hex sha: ${upstreamCommit}`);
  }
  if (!Array.isArray(series.patches) || series.patches.some((name) => typeof name !== "string")) {
    throw new TypeError("patch series patches must be an array of file names");
  }
  return { upstreamCommit, patches: [...series.patches] };
}

export async function readUpstreamVersion(packageJsonPath = VENDOR_CODING_AGENT_PACKAGE_JSON) {
  const pkg = asRecord(JSON.parse(await readFile(packageJsonPath, "utf8")), "vendor package");
  return requiredString(pkg.version, "vendor package version");
}

export function assertPinConsistent(upstream, series) {
  if (upstream.commit !== series.upstreamCommit) {
    throw new Error(
      `OMP pin mismatch: upstream.json=${upstream.commit}, series.json=${series.upstreamCommit}`,
    );
  }
  if (upstream.entrypoint !== MANAGED_ENTRYPOINT) {
    throw new Error(`upstream pin entrypoint must be "${MANAGED_ENTRYPOINT}", found "${upstream.entrypoint}"`);
  }
}

export async function computePatchHashes(patchesDirectory, names) {
  const patchHashes = {};
  for (const name of names) {
    if (name.length === 0 || name !== basename(name)) {
      throw new Error(`unsafe patch name in series: ${name}`);
    }
    patchHashes[name] = sha256Hex(await readFile(join(patchesDirectory, name)));
  }
  return patchHashes;
}

export async function buildManifest({
  upstream,
  series,
  upstreamVersion,
  binaryPath,
  patchesDirectory,
  platform,
  entrypoint = MANAGED_ENTRYPOINT,
  channel = "stable",
  runtimeIdentity,
}) {
  if (entrypoint !== MANAGED_ENTRYPOINT) {
    throw new Error(
      `Managed Runtime entrypoint must be "${MANAGED_ENTRYPOINT}"; "omp-studio.exe" is reserved for the desktop application`,
    );
  }
  if (basename(binaryPath) !== entrypoint) {
    throw new Error(`built binary "${basename(binaryPath)}" does not match managed entrypoint "${entrypoint}"`);
  }
  if (channel !== "stable" && channel !== "canary") {
    throw new Error(`Runtime channel must be "stable" or "canary", found "${channel}"`);
  }
  assertPinConsistent(upstream, series);

  const patchsetVersion = derivePatchsetVersion(series);
  const runtimeVersion = deriveRuntimeVersion(upstreamVersion, series);
  assertRuntimeIdentity(runtimeIdentity, {
    runtimeVersion,
    upstreamVersion,
    upstreamCommit: upstream.commit,
  });
  const entrypointSha256 = sha256Hex(await readFile(binaryPath));
  const patchHashes = await computePatchHashes(patchesDirectory, series.patches);

  const provenanceBase = {
    upstreamVersion,
    upstreamCommit: upstream.commit,
    patchsetVersion,
    patches: [...series.patches],
    patchHashes,
    entrypoint,
    entrypointSha256,
  };
  const capabilityHash = runtimeIdentity.capabilityHash;
  const commandManifestHash = runtimeIdentity.commandManifestHash;

  return {
    manifest: {
      runtimeVersion,
      upstreamVersion,
      upstreamCommit: upstream.commit,
      patchsetVersion,
      studioProtocol: { min: STUDIO_PROTOCOL_RANGE.min, max: STUDIO_PROTOCOL_RANGE.max },
      profile: "limited",
      capabilityHash,
      commandManifestHash,
      platform,
      entrypoint,
      channel,
    },
    provenance: { ...provenanceBase },
  };
}

export async function generateRuntimeArtifact({
  upstream,
  series,
  upstreamVersion,
  binaryPath,
  patchesDirectory,
  platform,
  entrypoint = MANAGED_ENTRYPOINT,
  channel = "stable",
  signingKey,
  keyId,
  outDirectory,
  runtimeIdentity,
}) {
  if (signingKey === undefined) throw new Error("A Runtime Ed25519 signing key is required");
  if (typeof keyId !== "string" || keyId.length === 0) throw new Error("A Runtime signing key id is required");
  const { manifest, provenance } = await buildManifest({
    upstream,
    series,
    upstreamVersion,
    binaryPath,
    patchesDirectory,
    platform,
    entrypoint,
    channel,
    runtimeIdentity,
  });
  const manifestText = canonicalJson(manifest);
  const checksums = {
    algorithm: "sha256",
    files: {
      [entrypoint]: sha256Hex(await readFile(binaryPath)),
      "runtime-manifest.json": sha256Hex(manifestText),
    },
  };
  const checksumsText = canonicalJson(checksums);
  const signedPayload = Buffer.concat([
    Buffer.from(manifestText, "utf8"),
    Buffer.from("\0"),
    Buffer.from(checksumsText, "utf8"),
  ]);
  const signature = {
    algorithm: "ed25519",
    keyId,
    payloadSha256: sha256Hex(signedPayload),
    signature: signPayload(null, signedPayload, signingKey).toString("base64url"),
  };
  const signatureText = canonicalJson(signature);

  await mkdir(outDirectory, { recursive: true });
  await copyFile(binaryPath, join(outDirectory, entrypoint));
  await writeFile(join(outDirectory, "runtime-manifest.json"), manifestText, "utf8");
  await writeFile(join(outDirectory, "checksums.json"), checksumsText, "utf8");
  await writeFile(join(outDirectory, "runtime-signature.json"), signatureText, "utf8");

  return {
    manifest,
    checksums,
    signature,
    provenance,
    manifestPath: join(outDirectory, "runtime-manifest.json"),
    checksumsPath: join(outDirectory, "checksums.json"),
    signaturePath: join(outDirectory, "runtime-signature.json"),
  };
}

function parseArgs(argv) {
  const values = {
    binary: undefined,
    out: undefined,
    platform: undefined,
    entrypoint: undefined,
    channel: undefined,
    signingKey: undefined,
    keyId: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === "--binary" ||
      flag === "--out" ||
      flag === "--platform" ||
      flag === "--entrypoint" ||
      flag === "--channel" ||
      flag === "--signing-key" ||
      flag === "--key-id"
    ) {
      if (value === undefined) throw new Error(`${flag} requires a value`);
      values[flag.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return values;
}

async function main(argv) {
  const args = parseArgs(argv);
  const platform = args.platform ?? `${process.platform}-${process.arch}`;
  const entrypoint = args.entrypoint ?? MANAGED_ENTRYPOINT;
  const channel = args.channel ?? "stable";
  const signingKeyPath = args.signingKey ?? process.env.OMP_RUNTIME_SIGNING_KEY;
  const keyId = args.keyId ?? process.env.OMP_RUNTIME_SIGNING_KEY_ID;
  if (signingKeyPath === undefined) {
    throw new Error("--signing-key or OMP_RUNTIME_SIGNING_KEY is required");
  }
  if (keyId === undefined) throw new Error("--key-id or OMP_RUNTIME_SIGNING_KEY_ID is required");
  const signingKey = await readFile(resolve(signingKeyPath));
  const binaryPath = resolve(args.binary ?? defaultBinaryPath());
  const upstream = await readUpstreamPin();
  const series = await readPatchSeries();
  const upstreamVersion = await readUpstreamVersion();
  const runtimeVersion = deriveRuntimeVersion(upstreamVersion, series);
  const outDirectory =
    args.out !== undefined ? resolve(args.out) : defaultArtifactDirectory(platform, runtimeVersion);
  const runtimeIdentity = await probeRuntimeIdentity({ binaryPath });

  const { manifestPath, checksumsPath, signaturePath, manifest } = await generateRuntimeArtifact({
    upstream,
    series,
    upstreamVersion,
    binaryPath,
    patchesDirectory: PATCHES_DIRECTORY,
    platform,
    entrypoint,
    channel,
    signingKey,
    keyId,
    outDirectory,
    runtimeIdentity,
  });
  console.log(`runtimeVersion=${manifest.runtimeVersion}`);
  console.log(`platform=${manifest.platform} entrypoint=${manifest.entrypoint}`);
  console.log(`capabilityHash=${manifest.capabilityHash} (verified limited Runtime subset)`);
  console.log(`commandManifestHash=${manifest.commandManifestHash} (verified limited Runtime subset)`);
  console.log(`Wrote ${manifestPath}`);
  console.log(`Wrote ${checksumsPath}`);
  console.log(`Wrote ${signaturePath}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
