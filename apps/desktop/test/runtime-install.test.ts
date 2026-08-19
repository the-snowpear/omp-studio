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
  createManagedArtifactLocator,
  loadInstallerTrustedKeys,
  locateManagedRuntimeArtifact,
  packagedRuntimeInstallLayout,
  probeManagedRuntimeInstall,
  resolveManagedRuntimeInstallDirectory,
  resolveManagedRuntimeInstallState,
  seedManagedRuntimeFromArtifact,
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

test("resolveManagedRuntimeInstallState reports local artifact updates", () => {
  assert.deepEqual(resolveManagedRuntimeInstallState({}), { status: "not-installed", signature: "unknown" });
  assert.deepEqual(resolveManagedRuntimeInstallState({ availableVersion: "1.0.1-studio.1" }), {
    status: "not-installed",
    signature: "unknown",
    availableVersion: "1.0.1-studio.1",
  });
  assert.deepEqual(resolveManagedRuntimeInstallState({ installedVersion: "1.0.1-studio.1" }), {
    status: "installed",
    version: "1.0.1-studio.1",
    signature: "unknown",
  });
  assert.deepEqual(
    resolveManagedRuntimeInstallState({ installedVersion: "1.0.1-studio.1", availableVersion: "1.0.1-studio.1" }),
    { status: "installed", version: "1.0.1-studio.1", signature: "unknown" },
  );
  assert.deepEqual(
    resolveManagedRuntimeInstallState({ installedVersion: "1.0.0-studio.1", availableVersion: "1.0.2-studio.1" }),
    {
      status: "update-available",
      version: "1.0.0-studio.1",
      availableVersion: "1.0.2-studio.1",
      signature: "unknown",
    },
  );
  assert.deepEqual(
    resolveManagedRuntimeInstallState({
      installedVersion: "1.0.1-studio.1",
      signature: "verified",
    }),
    { status: "installed", version: "1.0.1-studio.1", signature: "verified" },
  );
});

test("probeManagedRuntimeInstall compares the newest local artifact to the installed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-probe-"));
  try {
    await writeArtifact(root, "1.0.0-studio.1", "stable");
    await writeArtifact(root, "1.0.2-studio.1", "stable");
    const update = await probeManagedRuntimeInstall({
      platform: "win32-x64",
      currentVersion: "1.0.0-studio.1",
      locateArtifact: async () => locateManagedRuntimeArtifact({ platform: "win32-x64", roots: [root] }),
    });
    assert.equal(update.status, "update-available");
    assert.equal(update.version, "1.0.0-studio.1");
    assert.equal(update.availableVersion, "1.0.2-studio.1");

    const current = await probeManagedRuntimeInstall({
      platform: "win32-x64",
      currentVersion: "1.0.2-studio.1",
      locateArtifact: async () => locateManagedRuntimeArtifact({ platform: "win32-x64", roots: [root] }),
    });
    assert.equal(current.status, "installed");
    assert.equal(current.availableVersion, undefined);

    const missing = await probeManagedRuntimeInstall({
      platform: "win32-x64",
      locateArtifact: async () => locateManagedRuntimeArtifact({ platform: "win32-x64", roots: [root] }),
    });
    assert.equal(missing.status, "not-installed");
    assert.equal(missing.availableVersion, "1.0.2-studio.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install service reports failed when afterActivate throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-afteract-"));
  try {
    const artifact = await writeArtifact(root, "3.0.0-studio.1");
    const installer = new RuntimeInstaller(join(root, "runtimes"), {
      trustedKeys: { "test-key": trustedPublicKey },
    });
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
      afterActivate: async () => {
        throw new Error("Runtime did not start");
      },
    });
    const state = await service("stable");
    assert.equal(state.status, "failed");
    assert.equal(state.version, "3.0.0-studio.1");
    assert.equal(state.signature, "verified");
    assert.equal(state.message, "Runtime did not start");
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

test("packagedRuntimeInstallLayout is the live RuntimeInstaller tree next to the exe", () => {
  assert.equal(packagedRuntimeInstallLayout({ isPackaged: false, execPath: join("C:", "dev", "OMP Studio.exe") }), undefined);
  const layout = packagedRuntimeInstallLayout({
    isPackaged: true,
    execPath: join("C:", "Program Files", "OMP Studio", "OMP Studio.exe"),
  });
  assert.deepEqual(layout, {
    installDirectory: join("C:", "Program Files", "OMP Studio", "runtime"),
    artifactRoot: join("C:", "Program Files", "OMP Studio", "runtime", "versions"),
    keysDirectory: join("C:", "Program Files", "OMP Studio", "runtime-keys"),
  });
});

test("resolveManagedRuntimeInstallDirectory prefers the packaged override", () => {
  const profile = join("C:", "Users", "me", "AppData", "Roaming", "omp-studio");
  assert.equal(resolveManagedRuntimeInstallDirectory({ stateDirectory: profile }), join(profile, "runtimes"));
  assert.equal(
    resolveManagedRuntimeInstallDirectory({
      stateDirectory: profile,
      installDirectory: join("C:", "Program Files", "OMP Studio", "runtime"),
    }),
    join("C:", "Program Files", "OMP Studio", "runtime"),
  );
});

test("loadInstallerTrustedKeys tries bundled keys before the profile directory", async () => {
  const bundled = await mkdtemp(join(tmpdir(), "omp-keys-bundled-"));
  const profile = await mkdtemp(join(tmpdir(), "omp-keys-profile-"));
  try {
    await writeFile(join(profile, "key-id.txt"), "profile-key\n");
    await writeFile(join(profile, "trusted-public.pem"), trustedPublicKey);
    const missingBundled = await loadInstallerTrustedKeys([bundled, profile]);
    assert.ok(missingBundled);
    assert.deepEqual([...Object.keys(missingBundled.trustedKeys)], ["profile-key"]);
    await writeFile(join(bundled, "key-id.txt"), "bundled-key\n");
    await writeFile(join(bundled, "trusted-public.pem"), trustedPublicKey);
    const fromBundled = await loadInstallerTrustedKeys([bundled, profile]);
    assert.ok(fromBundled);
    assert.deepEqual([...Object.keys(fromBundled.trustedKeys)], ["bundled-key"]);
  } finally {
    await rm(bundled, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});

test("createManagedArtifactLocator reads extraFiles-style runtime root", async () => {
  const extra = await mkdtemp(join(tmpdir(), "omp-extra-runtime-"));
  try {
    await writeArtifact(extra, "4.1.0-studio.1");
    const locate = createManagedArtifactLocator({
      locateArtifact: async (input) => locateManagedRuntimeArtifact({ ...input, roots: [extra] }),
    });
    const found = await locate({ platform: "win32-x64" });
    assert.equal(found, join(extra, "4.1.0-studio.1"));
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("seedManagedRuntimeFromArtifact skips without a key or artifact, and does not reinstall", async () => {
  const calls: string[] = [];
  const skippedKey = await seedManagedRuntimeFromArtifact({
    backend: {
      installer: { currentManifest: async () => {
        calls.push("current");
        return undefined;
      } },
      install: async () => {
        calls.push("install");
        throw new Error("must not install");
      },
      activate: async () => {
        calls.push("activate");
        throw new Error("must not activate");
      },
    },
    platform: "win32-x64",
    hasTrustedKey: false,
  });
  assert.equal(skippedKey, "skipped");
  assert.deepEqual(calls, []);

  const skippedArtifact = await seedManagedRuntimeFromArtifact({
    backend: {
      installer: { currentManifest: async () => undefined },
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
  assert.equal(skippedArtifact, "skipped");

  const already = await seedManagedRuntimeFromArtifact({
    backend: {
      installer: { currentManifest: async () => ({}) },
      install: async () => {
        throw new Error("must not install");
      },
      activate: async () => {
        throw new Error("must not activate");
      },
    },
    platform: "win32-x64",
    hasTrustedKey: true,
    locateArtifact: async () => {
      throw new Error("must not locate");
    },
  });
  assert.equal(already, "already-installed");
});

test("seedManagedRuntimeFromArtifact installs and activates a located artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-seed-"));
  try {
    const artifact = await writeArtifact(root, "5.0.0-studio.1");
    const installer = new RuntimeInstaller(join(root, "runtimes"), {
      trustedKeys: { "test-key": trustedPublicKey },
    });
    const result = await seedManagedRuntimeFromArtifact({
      backend: {
        installer,
        install: (directory) => installer.install(directory),
        activate: async (version, activateOptions) =>
          installer.activate(version, activateOptions ?? { selfCheck: passingSelfCheck }),
      },
      platform: "win32-x64",
      hasTrustedKey: true,
      locateArtifact: async () => artifact,
      activateOptions: { selfCheck: passingSelfCheck },
    });
    assert.equal(result, "seeded");
    const current = await installer.currentManifest();
    assert.equal(current?.manifest.runtimeVersion, "5.0.0-studio.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seedManagedRuntimeFromArtifact activates a versions tree already in the installer root", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-seed-inplace-"));
  try {
    const installerRoot = join(root, "runtime");
    const artifact = await writeArtifact(join(installerRoot, "versions"), "6.0.0-studio.1");
    const installer = new RuntimeInstaller(installerRoot, {
      trustedKeys: { "test-key": trustedPublicKey },
    });
    const result = await seedManagedRuntimeFromArtifact({
      backend: {
        installer,
        install: (directory) => installer.install(directory),
        activate: async (version, activateOptions) =>
          installer.activate(version, activateOptions ?? { selfCheck: passingSelfCheck }),
      },
      platform: "win32-x64",
      hasTrustedKey: true,
      locateArtifact: async () => artifact,
      activateOptions: { selfCheck: passingSelfCheck },
    });
    assert.equal(result, "seeded");
    const current = await installer.currentManifest();
    assert.equal(current?.manifest.runtimeVersion, "6.0.0-studio.1");
    assert.equal(current?.entrypointPath, join(installerRoot, "versions", "6.0.0-studio.1", "omp.exe"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
