/**
 * Managed Runtime install seam: local signed artifacts only.
 * Does not spawn a real OMP process or touch the user's AppData runtimes tree.
 */

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { RuntimeInstaller } from "@omp-studio/runtime-installer";
import type { RuntimeInstallationManifest } from "@omp-studio/studio-protocol";

import {
  collectManagedRuntimeArtifactRoots,
  createDesktopRuntimeInstallService,
  loadInstallerTrustedKeys,
  locateManagedRuntimeArtifact,
} from "../src/runtime-install.js";

const passingSelfCheck = { run: async () => undefined };
const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });

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

async function writeArtifact(
  parent: string,
  version: string,
  channel: "stable" | "canary" = "stable",
): Promise<string> {
  const directory = join(parent, version);
  await mkdir(directory, { recursive: true });
  const content = `omp-${version}`;
  await writeFile(join(directory, "omp.exe"), content);
  const manifest = `${JSON.stringify({
    runtimeVersion: version,
    upstreamVersion: "0.0.0",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    patchsetVersion: "0.1.0",
    studioProtocol: { min: 1, max: 1 },
    profile: "limited",
    capabilityHash: "capability-fixture",
    commandManifestHash: "command-fixture",
    platform: "win32-x64",
    entrypoint: "omp.exe",
    channel,
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

test("locateManagedRuntimeArtifact picks the newest matching channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-art-"));
  try {
    await writeArtifact(root, "1.0.0-studio.1", "stable");
    await writeArtifact(root, "1.0.1-studio.1", "canary");
    await writeArtifact(root, "1.0.2-studio.1", "stable");
    const stable = await locateManagedRuntimeArtifact({
      platform: "win32-x64",
      channel: "stable",
      roots: [root],
    });
    assert.equal(stable, join(root, "1.0.2-studio.1"));
    const canary = await locateManagedRuntimeArtifact({
      platform: "win32-x64",
      channel: "canary",
      roots: [root],
    });
    assert.equal(canary, join(root, "1.0.1-studio.1"));
    const missing = await locateManagedRuntimeArtifact({
      platform: "darwin-arm64",
      roots: [root],
    });
    assert.equal(missing, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locateManagedRuntimeArtifact walks ancestors of a nested seed", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-art-walk-"));
  try {
    const platformRoot = join(root, "packages", "runtime-installer", "dist", "artifacts", "win32-x64");
    await writeArtifact(platformRoot, "3.0.0-studio.1", "stable");
    const nested = join(root, "apps", "desktop");
    await mkdir(nested, { recursive: true });
    const roots = collectManagedRuntimeArtifactRoots({
      platform: "win32-x64",
      seeds: [nested],
    });
    assert.equal(roots.includes(resolve(platformRoot)), true);
    const found = await locateManagedRuntimeArtifact({
      platform: "win32-x64",
      channel: "stable",
      roots,
    });
    assert.equal(found, join(platformRoot, "3.0.0-studio.1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadInstallerTrustedKeys reads a local keys directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-keys-"));
  try {
    assert.equal(await loadInstallerTrustedKeys(directory), undefined);
    await writeFile(join(directory, "key-id.txt"), "omp-studio-local\n");
    await writeFile(join(directory, "trusted-public.pem"), trustedPublicKey);
    const loaded = await loadInstallerTrustedKeys(directory);
    assert.ok(loaded);
    assert.deepEqual([...Object.keys(loaded.trustedKeys)], ["omp-studio-local"]);
    assert.equal(loaded.trustedKeys["omp-studio-local"]?.equals(Buffer.from(trustedPublicKey)), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install service fail-closes without a trusted key or artifact", async () => {
  const noKey = createDesktopRuntimeInstallService({
    backend: {
      install: async () => {
        throw new Error("must not install");
      },
      activate: async () => {
        throw new Error("must not activate");
      },
    },
    platform: "win32-x64",
    hasTrustedKey: false,
    locateArtifact: async () => undefined,
  });
  await assert.rejects(() => Promise.resolve(noKey()), /OMP_RUNTIME_TRUSTED_PUBLIC_KEY/u);

  const noArtifact = createDesktopRuntimeInstallService({
    backend: {
      install: async () => {
        throw new Error("must not install");
      },
      activate: async () => {
        throw new Error("must not activate");
      },
    },
    platform: "win32-x64",
    hasTrustedKey: true,
    locateArtifact: async () => undefined,
  });
  await assert.rejects(() => Promise.resolve(noArtifact()), /No managed Runtime artifact was found/u);
});

test("install service copies a signed artifact and activates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-inst-"));
  try {
    const artifact = await writeArtifact(root, "1.2.3-studio.4");
    const installer = new RuntimeInstaller(join(root, "runtimes"), {
      trustedKeys: { "test-key": trustedPublicKey },
    });
    const activated: string[] = [];
    const service = createDesktopRuntimeInstallService({
      backend: {
        install: (directory) => installer.install(directory),
        activate: async (version, activateOptions) => {
          activated.push(version);
          return installer.activate(version, activateOptions ?? { selfCheck: passingSelfCheck });
        },
      },
      platform: "win32-x64",
      hasTrustedKey: true,
      locateArtifact: async () => artifact,
      activateOptions: { selfCheck: passingSelfCheck },
    });
    const state = await service("stable");
    assert.equal(state.status, "installed");
    assert.equal(state.version, "1.2.3-studio.4");
    assert.equal(state.signature, "verified");
    assert.deepEqual(activated, ["1.2.3-studio.4"]);
    const current = await installer.currentManifest();
    assert.equal(current?.manifest.runtimeVersion, "1.2.3-studio.4");
    assert.equal(current?.manifest.entrypoint, "omp.exe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install service reactivates an already-installed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-reinst-"));
  try {
    const artifact = await writeArtifact(root, "2.0.0-studio.1");
    const installer = new RuntimeInstaller(join(root, "runtimes"), {
      trustedKeys: { "test-key": trustedPublicKey },
    });
    const manifest: RuntimeInstallationManifest = await installer.install(artifact);
    await installer.activate(manifest.runtimeVersion, { selfCheck: passingSelfCheck });
    const service = createDesktopRuntimeInstallService({
      backend: {
        install: (directory) => installer.install(directory),
        activate: async (version, activateOptions) =>
          installer.activate(version, activateOptions ?? { selfCheck: passingSelfCheck }),
      },
      platform: "win32-x64",
      hasTrustedKey: true,
      locateArtifact: async () => artifact,
      activateOptions: { selfCheck: passingSelfCheck },
    });
    const state = await service();
    assert.equal(state.status, "installed");
    assert.equal(state.version, "2.0.0-studio.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
