import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  IMPLEMENTED_CAPABILITIES,
  MANAGED_ENTRYPOINT,
  PATCHES_DIRECTORY,
  canonicalJson,
  derivePatchsetVersion,
  deriveRuntimeVersion,
  generateRuntimeArtifact,
  implementedManifestHash,
  LIMITED_CAPABILITIES,
  nextPatchsetVersion,
  readPatchSeries,
  readUpstreamPin,
  readUpstreamVersion,
  seriesDigest,
  sha256Hex,
} from "./runtime-artifact.mjs";
import { assertOverlayPresent, overlayHash } from "./omp-overlay.mjs";
import { RuntimeInstaller } from "../packages/runtime-installer/dist/src/index.js";

const REAL_UPSTREAM_COMMIT = "8500092296621a6826b7136e840f8a59ea338958";
const FIXTURE_COMMAND_MANIFEST_HASH = `sha256:${"c".repeat(64)}`;

async function fixtureInputs() {
  const root = await mkdtemp(join(tmpdir(), "omp-artifact-test-"));
  const upstream = {
    repository: "https://example.invalid/upstream.git",
    commit: REAL_UPSTREAM_COMMIT,
    firstPlatform: "win32-x64",
    entrypoint: "omp.exe",
  };
  const series = {
    upstreamCommit: REAL_UPSTREAM_COMMIT,
    patches: ["0001-first.patch", "0002-second.patch"],
  };
  const patchesDirectory = join(root, "patches");
  await mkdir(patchesDirectory);
  await writeFile(join(patchesDirectory, "0001-first.patch"), "patch-one\n");
  await writeFile(join(patchesDirectory, "0002-second.patch"), "patch-two\n");
  const binaryPath = join(root, "omp.exe");
  await writeFile(binaryPath, "fixture-binary-bytes\n");
  const vendorPackageJson = join(root, "package.json");
  await writeFile(vendorPackageJson, `${JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "17.2.12" })}\n`);
  const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
  const runtimeIdentity = {
    runtimeVersion: "17.2.12-studio.2",
    upstreamVersion: "17.2.12",
    upstreamCommit: REAL_UPSTREAM_COMMIT,
    selectedProtocolVersion: 1,
    profile: "limited",
    capabilityHash: implementedManifestHash("capabilities"),
    commandManifestHash: FIXTURE_COMMAND_MANIFEST_HASH,
  };
  return {
    root,
    upstream,
    series,
    patchesDirectory,
    binaryPath,
    vendorPackageJson,
    signingKey,
    publicKey,
    keyId: "fixture-key",
    runtimeIdentity,
    // Pinned so the unit fixtures stay hermetic; the real overlay digest is
    // exercised by the repository-level tests further down.
    overlay: `sha256:${"a".repeat(64)}`,
  };
}

test("artifact metadata is deterministic and free of timestamps and absolute paths", async () => {
  const inputs = await fixtureInputs();
  const first = await generateRuntimeArtifact({
    ...inputs,
    upstreamVersion: "17.2.12",
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory: join(inputs.root, "out-a"),
  });
  const second = await generateRuntimeArtifact({
    ...inputs,
    upstreamVersion: "17.2.12",
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory: join(inputs.root, "out-b"),
  });

  assert.equal(first.manifest.runtimeVersion, second.manifest.runtimeVersion);
  assert.equal(first.manifest.capabilityHash, second.manifest.capabilityHash);
  assert.equal(first.manifest.commandManifestHash, second.manifest.commandManifestHash);
  assert.deepEqual(
    await readFile(first.manifestPath, "utf8"),
    await readFile(second.manifestPath, "utf8"),
  );
  assert.deepEqual(
    await readFile(first.checksumsPath, "utf8"),
    await readFile(second.checksumsPath, "utf8"),
  );
  assert.deepEqual(
    await readFile(first.signaturePath, "utf8"),
    await readFile(second.signaturePath, "utf8"),
  );

  const manifestText = await readFile(first.manifestPath, "utf8");
  assert.ok(!manifestText.includes("generatedAt"), "no generatedAt timestamp may leak");
  assert.ok(!manifestText.includes(inputs.root), "no absolute path may leak");
  assert.ok(!manifestText.includes(":\\"), "no Windows drive path may leak");
});

test("artifact manifest carries the contract fields derived from real pin/series/binary", async () => {
  const inputs = await fixtureInputs();
  const { manifest, checksums, provenance } = await generateRuntimeArtifact({
    ...inputs,
    upstreamVersion: "17.2.12",
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory: join(inputs.root, "out"),
  });

  assert.equal(manifest.runtimeVersion, "17.2.12-studio.2");
  assert.equal(manifest.upstreamVersion, "17.2.12");
  assert.equal(manifest.upstreamCommit, REAL_UPSTREAM_COMMIT);
  assert.equal(manifest.patchsetVersion, "studio.2");
  assert.deepEqual(manifest.studioProtocol, { min: 1, max: 1 });
  assert.equal(manifest.profile, "limited");
  assert.equal(manifest.platform, "win32-x64");
  assert.equal(manifest.entrypoint, "omp.exe");
  assert.equal(manifest.channel, "stable");
  assert.match(manifest.capabilityHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(manifest.commandManifestHash, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(manifest.capabilityHash, manifest.commandManifestHash);
  assert.deepEqual(IMPLEMENTED_CAPABILITIES, [
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
    "session.fast.set",
    "session.prewalk.arm",
    "session.prewalk.disarm",
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
    "agent.conversation.read",
    "agent.subscribe",
    "job.list",
    "job.get",
    "job.cancel",
    "job.subscribe",
    "session.tree.get",
    "session.tree.navigate",
    "session.tree.branch",
    "session.fork",
    "session.handoff",
    "session.model.set",
    "session.thinking.set",
    "session.history",
    "session.transcript.read",
    "operator.manifest.get",
    "operator.invoke",
    "permissions.mode.set",
    "interaction.respond",
    "tui.transfer",
    "remoteUi.standard",
    "tui.manualCompatibility",
  ]);
  assert.equal(manifest.capabilityHash, implementedManifestHash("capabilities"));
  assert.equal(manifest.commandManifestHash, FIXTURE_COMMAND_MANIFEST_HASH);
  assert.deepEqual(LIMITED_CAPABILITIES["loop.enable"], ["Token limits are unsupported; use turns or minutes"]);

  assert.equal(provenance.upstreamCommit, REAL_UPSTREAM_COMMIT);
  assert.deepEqual(provenance.patches, ["0001-first.patch", "0002-second.patch"]);
  assert.equal(
    provenance.patchHashes["0001-first.patch"],
    sha256Hex("patch-one\n"),
    "patch hash must come from the real patch content",
  );
  assert.equal(provenance.entrypointSha256, sha256Hex("fixture-binary-bytes\n"));

  assert.equal(checksums.algorithm, "sha256");
  assert.equal(
    checksums.files["omp.exe"],
    sha256Hex("fixture-binary-bytes\n"),
    "checksums must hash the real binary bytes",
  );
  const manifestText = await readFile(join(inputs.root, "out", "runtime-manifest.json"), "utf8");
  assert.equal(checksums.files["runtime-manifest.json"], sha256Hex(manifestText));
  assert.deepEqual(
    await readFile(join(inputs.root, "out", "omp.exe"), "utf8"),
    "fixture-binary-bytes\n",
    "the built entrypoint binary must be part of the artifact",
  );
  assert.equal(
    canonicalJson(manifest),
    manifestText,
    "emitted manifest must use the canonical serialization",
  );

  const manifestBytes = await readFile(join(inputs.root, "out", "runtime-manifest.json"));
  const checksumsBytes = await readFile(join(inputs.root, "out", "checksums.json"));
  const signedPayload = Buffer.concat([manifestBytes, Buffer.from("\0"), checksumsBytes]);
  const signature = JSON.parse(await readFile(join(inputs.root, "out", "runtime-signature.json"), "utf8"));
  assert.equal(signature.algorithm, "ed25519");
  assert.equal(signature.keyId, "fixture-key");
  assert.equal(signature.payloadSha256, sha256Hex(signedPayload));
  assert.equal(verify(null, signedPayload, inputs.publicKey, Buffer.from(signature.signature, "base64url")), true);
});

test("generated signed artifact is accepted by the production installer verifier", async () => {
  const inputs = await fixtureInputs();
  const outDirectory = join(inputs.root, "installable");
  const generated = await generateRuntimeArtifact({
    ...inputs,
    upstreamVersion: "17.2.12",
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory,
  });
  const installer = new RuntimeInstaller(join(inputs.root, "installed"), {
    trustedKeys: {
      [inputs.keyId]: inputs.publicKey.export({ type: "spki", format: "pem" }),
    },
  });
  assert.equal((await installer.install(outDirectory)).runtimeVersion, generated.manifest.runtimeVersion);
});

test("packaging requires authenticated Runtime identity and rejects drift", async () => {
  const inputs = await fixtureInputs();
  const base = {
    ...inputs,
    upstreamVersion: "17.2.12",
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory: join(inputs.root, "out"),
  };
  await assert.rejects(
    generateRuntimeArtifact({ ...base, runtimeIdentity: undefined }),
    /identity evidence is required/u,
  );
  await assert.rejects(
    generateRuntimeArtifact({
      ...base,
      runtimeIdentity: { ...inputs.runtimeIdentity, commandManifestHash: `sha256:${"d".repeat(63)}` },
    }),
    /commandManifestHash is not a sha256 digest/u,
  );
  await assert.rejects(
    generateRuntimeArtifact({
      ...base,
      runtimeIdentity: { ...inputs.runtimeIdentity, capabilityHash: `sha256:${"e".repeat(64)}` },
    }),
    /capability hash does not match/u,
  );
});

test("real repository pin and series resolve to the pinned runtime identity", async () => {
  const upstream = await readUpstreamPin();
  const series = await readPatchSeries();
  const upstreamVersion = await readUpstreamVersion();
  assert.equal(upstream.commit, REAL_UPSTREAM_COMMIT);
  assert.equal(series.upstreamCommit, upstream.commit);
  assert.equal(upstream.entrypoint, "omp.exe");
  assert.equal(upstreamVersion, "17.3.7");
  const patchsetVersion = derivePatchsetVersion(series);
  assert.match(patchsetVersion, /^studio\.\d+$/u);
  assert.equal(patchsetVersion, series.patchsetVersion);
  assert.equal(deriveRuntimeVersion(upstreamVersion, series), `17.3.7-${patchsetVersion}`);
  for (const name of series.patches) {
    assert.ok(existsSync(join(PATCHES_DIRECTORY, name)), `series patch must exist: ${name}`);
  }
});

test("patchset version is recorded, not counted, so consolidating patches cannot reuse an installed version", () => {
  const consolidated = { patchsetVersion: "studio.35", patches: ["0001-a.patch", "0002-b.patch"] };
  assert.equal(derivePatchsetVersion(consolidated), "studio.35");
  assert.equal(nextPatchsetVersion("studio.35"), "studio.36");
  assert.throws(() => nextPatchsetVersion("35"), /studio\.<n>/u);
  assert.throws(() => nextPatchsetVersion(undefined), /studio\.<n>/u);
});

test("series digest changes with overlay content and with seam patch content", () => {
  const patchHashes = { "0001-a.patch": "a".repeat(64) };
  const baseline = seriesDigest({ overlayHash: `sha256:${"1".repeat(64)}`, patchHashes });
  assert.match(baseline, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(baseline, seriesDigest({ overlayHash: `sha256:${"1".repeat(64)}`, patchHashes }));
  assert.notEqual(baseline, seriesDigest({ overlayHash: `sha256:${"2".repeat(64)}`, patchHashes }));
  assert.notEqual(
    baseline,
    seriesDigest({ overlayHash: `sha256:${"1".repeat(64)}`, patchHashes: { "0001-a.patch": "b".repeat(64) } }),
  );
});

test("real overlay is non-empty and its digest lands in artifact provenance", async () => {
  const upstream = await readUpstreamPin();
  const series = await readPatchSeries();
  const files = await assertOverlayPresent();
  assert.ok(files.length > 0);
  const digest = await overlayHash();
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);

  const inputs = await fixtureInputs();
  const { provenance } = await generateRuntimeArtifact({
    upstream,
    series,
    upstreamVersion: "17.2.12",
    binaryPath: inputs.binaryPath,
    patchesDirectory: PATCHES_DIRECTORY,
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory: join(inputs.root, "out-overlay"),
    signingKey: inputs.signingKey,
    keyId: inputs.keyId,
    runtimeIdentity: {
      ...inputs.runtimeIdentity,
      runtimeVersion: deriveRuntimeVersion("17.2.12", series),
    },
  });
  assert.equal(provenance.overlayHash, digest);
});

test("real patch series contributes real patch content hashes", async () => {
  const upstream = await readUpstreamPin();
  const series = await readPatchSeries();
  const inputs = await fixtureInputs();
  const { provenance } = await generateRuntimeArtifact({
    upstream,
    series,
    upstreamVersion: "17.2.12",
    binaryPath: inputs.binaryPath,
    patchesDirectory: PATCHES_DIRECTORY,
    platform: "win32-x64",
    entrypoint: MANAGED_ENTRYPOINT,
    outDirectory: join(inputs.root, "out"),
    signingKey: inputs.signingKey,
    keyId: inputs.keyId,
    runtimeIdentity: {
      ...inputs.runtimeIdentity,
      runtimeVersion: deriveRuntimeVersion("17.2.12", series),
    },
  });
  assert.deepEqual(Object.keys(provenance.patchHashes), series.patches);
  for (const name of series.patches) {
    assert.equal(
      provenance.patchHashes[name],
      sha256Hex(await readFile(join(PATCHES_DIRECTORY, name))),
    );
  }
});

test("entrypoint must be omp.exe and the binary must match it", async () => {
  const inputs = await fixtureInputs();
  await assert.rejects(
    generateRuntimeArtifact({
      ...inputs,
      upstreamVersion: "17.2.12",
      platform: "win32-x64",
      entrypoint: "omp-studio.exe",
      outDirectory: join(inputs.root, "out"),
    }),
    /omp-studio\.exe.*reserved/u,
  );
  await assert.rejects(
    generateRuntimeArtifact({
      ...inputs,
      upstreamVersion: "17.2.12",
      platform: "win32-x64",
      entrypoint: MANAGED_ENTRYPOINT,
      binaryPath: join(inputs.root, "other.exe"),
      outDirectory: join(inputs.root, "out"),
    }),
    /does not match managed entrypoint/u,
  );
});

test("pin and series commit mismatch is rejected", async () => {
  const inputs = await fixtureInputs();
  const series = { ...inputs.series, upstreamCommit: "a".repeat(40) };
  await assert.rejects(
    generateRuntimeArtifact({
      ...inputs,
      series,
      upstreamVersion: "17.2.12",
      platform: "win32-x64",
      entrypoint: MANAGED_ENTRYPOINT,
      outDirectory: join(inputs.root, "out"),
    }),
    /OMP pin mismatch/u,
  );
});
