import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeInstaller, RuntimeInstallationReferencedError, type RuntimeInstallerOptions } from "../src/index.js";

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

async function artifact(
  parent: string,
  version: string,
  content = `omp-${version}`,
  channel: "stable" | "canary" = "stable",
): Promise<string> {
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
      channel,
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

test("WP-003 installs two versions, activates, and rolls back atomically", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  await installer.install(await artifact(temporary, "v1"));
  await installer.install(await artifact(temporary, "v2"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  await installer.activate("v2", { selfCheck: passingSelfCheck });
  assert.equal((await installer.rollback()).runtimeVersion, "v1");
  assert.equal(JSON.parse(await readFile(join(temporary, "installed", "current.json"), "utf8")).runtimeVersion, "v1");
});

test("activation verifies installed bytes before running any executable", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-activate-tampered-"));
  const root = join(temporary, "installed");
  const installer = runtimeInstaller(root);
  await installer.install(await artifact(temporary, "v1"));
  await writeFile(join(root, "versions", "v1", "omp.exe"), "tampered-after-install");
  let executed = false;
  await assert.rejects(() => installer.activate("v1", { selfCheck: { run: async () => { executed = true; } } }), /Checksum mismatch/u);
  assert.equal(executed, false);
  assert.equal(await installer.current(), undefined);
});

test("managed launch lookup rejects an executable changed after activation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-launch-integrity-"));
  const root = join(temporary, "installed");
  const installer = runtimeInstaller(root);
  await installer.install(await artifact(temporary, "v1"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  await writeFile(join(root, "versions", "v1", "omp.exe"), "replaced executable");
  await assert.rejects(() => installer.currentManifest(), /Checksum mismatch for omp\.exe/u);
});

test("same-version reinstall repairs corrupt bytes without losing the rollback pointer", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-repair-runtime-"));
  const root = join(temporary, "installed");
  const installer = runtimeInstaller(root);
  await installer.install(await artifact(temporary, "v1"));
  const source = await artifact(temporary, "v2");
  await installer.install(source);
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  await installer.activate("v2", { selfCheck: passingSelfCheck });
  const pointer = await readFile(join(root, "current.json"), "utf8");
  await installer.install(source); // A healthy duplicate is idempotent.
  assert.equal(await readFile(join(root, "current.json"), "utf8"), pointer);
  await writeFile(join(root, "versions", "v2", "omp.exe"), "broken");
  await installer.install(source);
  assert.equal(await readFile(join(root, "versions", "v2", "omp.exe"), "utf8"), "omp-v2");
  assert.equal(await readFile(join(root, "current.json"), "utf8"), pointer);
  await installer.activate("v2", { selfCheck: passingSelfCheck });
  assert.equal((await installer.current())?.previousRuntimeVersion, "v1");
  assert.equal((await installer.rollback()).runtimeVersion, "v1");
  assert.deepEqual((await readdir(join(root, "versions"))).sort(), ["v1", "v2"]);
});

test("repair preserves referenced installations unless maintenance has stopped their processes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-repair-referenced-"));
  const root = join(temporary, "installed");
  const installer = runtimeInstaller(root, { isRuntimeReferenced: () => true });
  const source = await artifact(temporary, "v1");
  await installer.install(source);
  await installer.install(source); // Healthy referenced copies need no replacement.
  const entrypoint = join(root, "versions", "v1", "omp.exe");
  await writeFile(entrypoint, "broken");
  await assert.rejects(() => installer.install(source), RuntimeInstallationReferencedError);
  assert.equal(await readFile(entrypoint, "utf8"), "broken");
  assert.deepEqual(await readdir(join(root, "versions")), ["v1"]);
  await installer.install(source, { allowReferencedRepair: true });
  assert.equal(await readFile(entrypoint, "utf8"), "omp-v1");
});

test("a corrupt repair source never changes the installed bytes or active pointer", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-repair-source-"));
  const root = join(temporary, "installed");
  const installer = runtimeInstaller(root);
  const source = await artifact(temporary, "v1");
  await installer.install(source);
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  const pointer = await readFile(join(root, "current.json"), "utf8");
  await writeFile(join(root, "versions", "v1", "omp.exe"), "installed-broken");
  await writeFile(join(source, "omp.exe"), "source-broken");
  await assert.rejects(() => installer.install(source), /Checksum mismatch/u);
  assert.equal(await readFile(join(root, "versions", "v1", "omp.exe"), "utf8"), "installed-broken");
  assert.equal(await readFile(join(root, "current.json"), "utf8"), pointer);
});

test("prune preserves broken current, previous and externally referenced versions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-prune-broken-"));
  const root = join(temporary, "installed");
  const installer = runtimeInstaller(root, { isRuntimeReferenced: (version) => version === "bound" });
  assert.deepEqual(await installer.prune(), []);
  for (const version of ["current", "previous", "bound", "orphan"]) {
    await mkdir(join(root, "versions", version), { recursive: true });
    await writeFile(join(root, "versions", version, "runtime-manifest.json"), "corrupt");
  }
  await writeFile(join(root, "current.json"), JSON.stringify({ runtimeVersion: "current", previousRuntimeVersion: "previous", activatedAt: "now" }));
  assert.deepEqual(await installer.prune(), ["orphan"]);
  assert.deepEqual((await readdir(join(root, "versions"))).sort(), ["bound", "current", "previous"]);
});

test("WP-003 rejects a checksum mismatch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-bad-"));
  const source = await artifact(temporary, "bad");
  await writeFile(join(source, "omp.exe"), "tampered");
  await assert.rejects(() => runtimeInstaller(join(temporary, "installed")).install(source), /Checksum mismatch/u);
});

test("SEC-006 rejects unsigned, metadata-tampered, and untrusted Runtime artifacts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-signature-"));
  const unsigned = await artifact(temporary, "unsigned");
  await writeFile(join(unsigned, "runtime-signature.json"), "{}\n");
  await assert.rejects(() => runtimeInstaller(join(temporary, "installed-a")).install(unsigned), /signature/u);

  const tampered = await artifact(temporary, "tampered-metadata");
  const manifest = JSON.parse(await readFile(join(tampered, "runtime-manifest.json"), "utf8")) as Record<string, unknown>;
  manifest.channel = "canary";
  await writeFile(join(tampered, "runtime-manifest.json"), `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    () => runtimeInstaller(join(temporary, "installed-b")).install(tampered),
    /signature does not match/u,
  );

  const untrusted = await artifact(temporary, "untrusted");
  await assert.rejects(
    () => new RuntimeInstaller(join(temporary, "installed-c"), { trustedKeys: {} }).install(untrusted),
    /signature verification failed/u,
  );
});

test("RT-007 failed activation preserves the current Runtime", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-activate-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  await installer.install(await artifact(temporary, "v1"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  await assert.rejects(() => installer.activate("missing"));
  assert.equal((await installer.current())?.runtimeVersion, "v1");
});

test("WP-062 currentManifest reports the active installation read-only", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-currentmanifest-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  assert.equal(await installer.currentManifest(), undefined);
  await installer.install(await artifact(temporary, "v1"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  const installed = await installer.currentManifest();
  assert.ok(installed);
  assert.equal(installed.record.runtimeVersion, "v1");
  assert.equal(installed.manifest.runtimeVersion, "v1");
  assert.equal(installed.manifest.profile, "full-parity-v1");
  assert.equal(installed.entrypointPath, join(temporary, "installed", "versions", "v1", "omp.exe"));
  assert.equal((await installer.current())?.runtimeVersion, "v1");
});

// The installed tree is an ordinary directory, so verifying once at install
// time proves nothing about what a later launch reads. Without this the only
// symptom of an edited manifest is the Runtime Resolver reporting an opaque
// "managed runtime command manifest hash drift".
test("SEC-006 currentManifest rejects an installed manifest edited after install", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-posttamper-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  await installer.install(await artifact(temporary, "v1"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  const manifestPath = join(temporary, "installed", "versions", "v1", "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { commandManifestHash: string };
  manifest.commandManifestHash = "sha256:planted-by-a-standard-user";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(() => installer.currentManifest(), /signature does not match/u);
});

test("WP-003 activation self-check runs on the installed entrypoint before current.json is switched", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-selfcheck-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  await installer.install(await artifact(temporary, "v1"));
  const checked: string[] = [];
  await installer.activate("v1", {
    selfCheck: { run: async (entrypointPath) => { checked.push(entrypointPath); } },
  });
  assert.equal(checked.length, 1);
  assert.equal(checked[0], join(temporary, "installed", "versions", "v1", "omp.exe"));
  assert.equal((await installer.current())?.runtimeVersion, "v1");
});

test("WP-003 failed activation self-check preserves current and quarantines the candidate", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-quarantine-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  await installer.install(await artifact(temporary, "v1"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });
  await installer.install(await artifact(temporary, "v2"));

  await assert.rejects(
    () =>
      installer.activate("v2", {
        selfCheck: { run: async () => { throw new Error("smoke failed"); } },
      }),
    /failed its activation self-check.*quarantine/u,
  );

  assert.equal((await installer.current())?.runtimeVersion, "v1");
  const versionDirectories = await readdir(join(temporary, "installed", "versions"));
  assert.ok(!versionDirectories.includes("v2"), "failed candidate must leave the installable set");
  const quarantined = versionDirectories.filter((name) => name.startsWith(".quarantine-v2-"));
  assert.equal(quarantined.length, 1);
  const quarantineName = quarantined[0];
  assert.ok(quarantineName);
  await readFile(join(temporary, "installed", "versions", quarantineName, "runtime-manifest.json"));
  await readFile(join(temporary, "installed", "versions", quarantineName, "omp.exe"));
});

test("WP-003 self-check failure never quarantines a Runtime referenced by current.json", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-active-selfcheck-"));
  const installer = runtimeInstaller(join(temporary, "installed"));
  await installer.install(await artifact(temporary, "v1"));
  await installer.activate("v1", { selfCheck: passingSelfCheck });

  await assert.rejects(
    () =>
      installer.activate("v1", {
        selfCheck: { run: async () => { throw new Error("transient failure"); } },
      }),
    /referenced installation and current\.json were preserved/u,
  );

  assert.equal((await installer.current())?.runtimeVersion, "v1");
  await readFile(join(temporary, "installed", "versions", "v1", "omp.exe"));
  assert.deepEqual(
    (await readdir(join(temporary, "installed", "versions"))).filter((name) => name.startsWith(".quarantine-")),
    [],
  );
});

test("WP-003 requires checksums for the manifest and entrypoint", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-coverage-"));
  const source = await artifact(temporary, "missing-manifest-checksum");
  const digest = createHash("sha256").update("omp-missing-manifest-checksum").digest("hex");
  const manifest = await readFile(join(source, "runtime-manifest.json"), "utf8");
  const checksums = `${JSON.stringify({ algorithm: "sha256", files: { "omp.exe": digest } })}\n`;
  await writeFile(join(source, "checksums.json"), checksums);
  await writeSignature(source, manifest, checksums);
  await assert.rejects(
    () => runtimeInstaller(join(temporary, "installed")).install(source),
    /must cover runtime-manifest.json/u,
  );
});

test("SEC-005 rejects a symlinked Runtime entrypoint", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-symlink-"));
  const outside = join(temporary, "outside.exe");
  const source = join(temporary, "artifact-symlink");
  await mkdir(source);
  await writeFile(outside, "external-binary");
  try {
    await symlink(outside, join(source, "omp.exe"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Windows developer mode is required to create a file symlink");
      return;
    }
    throw error;
  }
  const manifest = `${JSON.stringify({
    runtimeVersion: "symlink",
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
  await writeFile(join(source, "runtime-manifest.json"), manifest);
  const checksums = `${JSON.stringify({
      algorithm: "sha256",
      files: {
        "omp.exe": createHash("sha256").update("external-binary").digest("hex"),
        "runtime-manifest.json": createHash("sha256").update(manifest).digest("hex"),
      },
    })}\n`;
  await writeFile(join(source, "checksums.json"), checksums);
  await writeSignature(source, manifest, checksums);
  await assert.rejects(
    () => runtimeInstaller(join(temporary, "installed")).install(source),
    /cannot contain symbolic links/u,
  );
});

test("WP-064 uninstall protects active and externally referenced Runtime versions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-uninstall-"));
  const referenced = new Set(["bound"]);
  const installer = runtimeInstaller(join(temporary, "installed"), {
    isRuntimeReferenced: (version) => referenced.has(version),
  });
  for (const version of ["active", "bound", "free"]) await installer.install(await artifact(temporary, version));
  await installer.activate("active", { selfCheck: passingSelfCheck });
  await assert.rejects(() => installer.uninstall("active"), /current\.json/u);
  await assert.rejects(() => installer.uninstall("bound"), /active Thread binding/u);
  await installer.uninstall("free");
  await assert.rejects(() => readFile(join(temporary, "installed", "versions", "free", "runtime-manifest.json")), {
    code: "ENOENT",
  });
});

test("WP-064 pruning keeps at least two stable versions and every referenced version", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-installer-prune-"));
  const referenced = new Set(["canary-bound"]);
  const installer = runtimeInstaller(join(temporary, "installed"), {
    isRuntimeReferenced: (version) => referenced.has(version),
  });
  for (const version of ["stable-1", "stable-2", "stable-3"]) {
    await installer.install(await artifact(temporary, version, undefined, "stable"));
  }
  await installer.install(await artifact(temporary, "canary-old", undefined, "canary"));
  await installer.install(await artifact(temporary, "canary-bound", undefined, "canary"));

  const removed = await installer.prune();
  assert.ok(removed.includes("canary-old"));
  assert.ok(!removed.includes("canary-bound"));
  const remaining = (await readdir(join(temporary, "installed", "versions"))).filter(name => !name.startsWith("."));
  assert.equal(remaining.filter(name => name.startsWith("stable-")).length, 2);
  assert.ok(remaining.includes("canary-bound"));
});
