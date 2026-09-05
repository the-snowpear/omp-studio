import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppPayloadInstaller,
  type AppPayloadManifest,
} from "@omp-studio/runtime-installer";
import {
  resolveAppResourceLayout,
  PRELOAD_OUTPUT,
} from "../src/payload-root.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });
const trustedKeys = { "test-key": trustedPublicKey };

const RUNTIME_ENV = {
  electron: "43.4.0",
  modules: "143",
  nodePty: "1.1.0",
};
const PLATFORM = "win32-x64";
const BUNDLED_VERSION = "0.1.3";

async function writePayloadSignature(
  directory: string,
  manifest: string,
  checksums: string,
): Promise<void> {
  const payload = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  await writeFile(
    join(directory, "payload-signature.json"),
    `${JSON.stringify({
      algorithm: "ed25519",
      keyId: "test-key",
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      signature: sign(null, payload, signingKey).toString("base64url"),
    })}\n`,
  );
}

async function createAndInstallArtifact(
  installer: AppPayloadInstaller,
  parent: string,
  version: string,
  overrides: Partial<AppPayloadManifest> = {},
): Promise<AppPayloadManifest> {
  const directory = join(parent, `temp-${version}`);
  await mkdir(join(directory, "renderer"), { recursive: true });
  const preloadContent = `console.log("preload ${version}");`;
  const rendererContent = `<!DOCTYPE html><html><body>${version}</body></html>`;
  await writeFile(join(directory, "preload.cjs"), preloadContent);
  await writeFile(join(directory, "renderer", "index.html"), rendererContent);

  const manifestObj: AppPayloadManifest = {
    payloadVersion: version,
    payloadFormat: 1,
    platform: PLATFORM,
    abi: { ...RUNTIME_ENV },
    clientContractVersion: 2,
    studioProtocol: { min: 1, max: 1 },
    entries: ["preload.cjs", "renderer"],
    ...overrides,
  };
  const manifest = `${JSON.stringify(manifestObj, null, 2)}\n`;
  await writeFile(join(directory, "app-payload-manifest.json"), manifest);

  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "app-payload-manifest.json": createHash("sha256").update(manifest).digest("hex"),
      "preload.cjs": createHash("sha256").update(preloadContent).digest("hex"),
      "renderer/index.html": createHash("sha256").update(rendererContent).digest("hex"),
    },
  }, null, 2)}\n`;
  await writeFile(join(directory, "checksums.json"), checksums);
  await writePayloadSignature(directory, manifest, checksums);

  return installer.install(directory);
}

test("resolveAppResourceLayout: --omp-baseline goes to baseline without modifying current.json", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-baseline-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    await createAndInstallArtifact(installer, temp, "0.1.4");
    await installer.activate("0.1.4");

    const layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: true,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });

    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.payloadVersion, undefined);
    assert.equal(layout.bootNotice, undefined);
    assert.ok(layout.preloadPath.endsWith(join("dist", "preload.cjs")));

    // Verify current.json was untouched
    const current = await installer.current();
    assert.equal(current?.payloadVersion, "0.1.4");
    assert.equal(current?.bootAttempts, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout rejects incompatible contracts and protocols", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-contract-"));
  try {
    for (const [name, override] of Object.entries({ contract: { clientContractVersion: 999 }, protocol: { studioProtocol: { min: 999, max: 999 } } })) {
      const parent = join(temp, name);
      const payloadRoot = join(parent, "payload");
      const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
      await createAndInstallArtifact(installer, parent, "0.1.4", override);
      await installer.activate("0.1.4");
      const layout = await resolveAppResourceLayout({ appPath: join(temp, "app"), isPackaged: true, bundledVersion: BUNDLED_VERSION, forceBaseline: false, runtime: RUNTIME_ENV, platform: PLATFORM, trustedKeys, payloadRoot });
      assert.equal(layout.payloadVersion, undefined);
      assert.equal(layout.bootNotice, "payload-rejected");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout falls back to baseline when both payloads fail without oscillating", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-double-fail-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    await createAndInstallArtifact(installer, temp, "0.1.4");
    await createAndInstallArtifact(installer, temp, "0.1.5");
    await installer.activate("0.1.4");
    await installer.activate("0.1.5");
    await installer.noteBootAttempt();
    await installer.noteBootAttempt();
    const input = { appPath: join(temp, "app"), isPackaged: true, bundledVersion: BUNDLED_VERSION, forceBaseline: false, runtime: RUNTIME_ENV, platform: PLATFORM, trustedKeys, payloadRoot };
    assert.equal((await resolveAppResourceLayout(input)).payloadVersion, "0.1.4");
    assert.equal((await installer.current())?.previousPayloadVersion, undefined);
    await installer.noteBootAttempt();
    const fallback = await resolveAppResourceLayout(input);
    assert.equal(fallback.payloadVersion, undefined);
    assert.equal(fallback.bootNotice, "payload-rolled-back");
    assert.equal(await installer.current(), undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: missing or corrupt current.json falls back to baseline", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-missing-"));
  try {
    const payloadRoot = join(temp, "payload");

    // Missing current.json
    const layout1 = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });
    assert.equal(layout1.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout1.payloadVersion, undefined);

    // Corrupted current.json
    await mkdir(payloadRoot, { recursive: true });
    await writeFile(join(payloadRoot, "current.json"), "{ invalid json ");
    const layout2 = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });
    assert.equal(layout2.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout2.payloadVersion, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: bootAttempts >= 2 downgrades to previous and notes attempt", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-downgrade-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    await createAndInstallArtifact(installer, temp, "0.1.4");
    await createAndInstallArtifact(installer, temp, "0.1.5");

    await installer.activate("0.1.4");
    await installer.activate("0.1.5");

    // Simulate 2 failed boot attempts
    await installer.noteBootAttempt();
    await installer.noteBootAttempt();
    assert.equal((await installer.current())?.bootAttempts, 2);

    const layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });

    assert.equal(layout.effectiveVersion, "0.1.4");
    assert.equal(layout.payloadVersion, "0.1.4");
    assert.equal(layout.bootNotice, "payload-rolled-back");

    // Verify current.json rolled back to 0.1.4 and bootAttempt was noted
    const current = await installer.current();
    assert.equal(current?.payloadVersion, "0.1.4");
    assert.equal(current?.bootAttempts, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: bootAttempts >= 2 with corrupt previous falls back to baseline", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-prevbad-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    await createAndInstallArtifact(installer, temp, "0.1.4");
    await createAndInstallArtifact(installer, temp, "0.1.5");

    await installer.activate("0.1.4");
    await installer.activate("0.1.5");

    // Corrupt previous version's preload.cjs
    await writeFile(join(payloadRoot, "versions", "0.1.4", "preload.cjs"), "tampered");

    await installer.noteBootAttempt();
    await installer.noteBootAttempt();

    const layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });

    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.payloadVersion, undefined);
    assert.equal(layout.bootNotice, "payload-rolled-back");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: signature failure falls back to baseline with payload-rejected", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-sigfail-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    await createAndInstallArtifact(installer, temp, "0.1.4");
    await installer.activate("0.1.4");

    // Tamper preload.cjs
    await writeFile(join(payloadRoot, "versions", "0.1.4", "preload.cjs"), "tampered");

    const layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });

    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.payloadVersion, undefined);
    assert.equal(layout.bootNotice, "payload-rejected");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: ABI mismatch falls back to baseline with payload-rejected", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-abi-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });

    // 1. Electron mismatch
    await createAndInstallArtifact(installer, temp, "0.1.4", {
      abi: { electron: "99.0.0", modules: "143", nodePty: "1.1.0" },
    });
    await installer.activate("0.1.4");

    let layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });
    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.bootNotice, "payload-rejected");

    // 2. Modules mismatch
    await createAndInstallArtifact(installer, temp, "0.1.5", {
      abi: { electron: "43.4.0", modules: "999", nodePty: "1.1.0" },
    });
    await installer.activate("0.1.5");
    layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });
    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.bootNotice, "payload-rejected");

    // 3. Node-pty mismatch
    await createAndInstallArtifact(installer, temp, "0.1.6", {
      abi: { electron: "43.4.0", modules: "143", nodePty: "9.9.9" },
    });
    await installer.activate("0.1.6");
    layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });
    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.bootNotice, "payload-rejected");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: payloadFormat higher than supported falls back to baseline", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-fmt-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    // Note: installer.install rejects format !== 1, so we write directly to simulate future format installed by future tool
    const versionDir = join(payloadRoot, "versions", "0.1.4");
    await mkdir(join(versionDir, "renderer"), { recursive: true });
    await writeFile(join(versionDir, "preload.cjs"), "console.log(1);");
    await writeFile(join(versionDir, "renderer", "index.html"), "<html></html>");

    const manifestObj: AppPayloadManifest = {
      payloadVersion: "0.1.4",
      payloadFormat: 99,
      platform: PLATFORM,
      abi: { ...RUNTIME_ENV },
      clientContractVersion: 2,
      studioProtocol: { min: 1, max: 1 },
      entries: ["preload.cjs", "renderer"],
    };
    const manifest = `${JSON.stringify(manifestObj, null, 2)}\n`;
    await writeFile(join(versionDir, "app-payload-manifest.json"), manifest);
    const checksums = `${JSON.stringify({
      algorithm: "sha256",
      files: {
        "app-payload-manifest.json": createHash("sha256").update(manifest).digest("hex"),
        "preload.cjs": createHash("sha256").update("console.log(1);").digest("hex"),
        "renderer/index.html": createHash("sha256").update("<html></html>").digest("hex"),
      },
    }, null, 2)}\n`;
    await writeFile(join(versionDir, "checksums.json"), checksums);
    await writePayloadSignature(versionDir, manifest, checksums);

    // Write current.json pointing to this future format
    await writeFile(
      join(payloadRoot, "current.json"),
      JSON.stringify({ payloadVersion: "0.1.4", activatedAt: new Date().toISOString(), bootAttempts: 0 }),
    );

    // parseAppPayloadManifest in resolveAppResourceLayout would reject format 99 (or payloadFormat > APP_PAYLOAD_FORMAT check)
    const layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });
    assert.equal(layout.effectiveVersion, BUNDLED_VERSION);
    assert.equal(layout.bootNotice, "payload-rejected");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveAppResourceLayout: valid payload resolves and increments bootAttempts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "payload-root-success-"));
  try {
    const payloadRoot = join(temp, "payload");
    const installer = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    await createAndInstallArtifact(installer, temp, "0.1.4");
    await installer.activate("0.1.4");

    assert.equal((await installer.current())?.bootAttempts, 0);

    const layout = await resolveAppResourceLayout({
      appPath: join(temp, "app"),
      isPackaged: true,
      bundledVersion: BUNDLED_VERSION,
      forceBaseline: false,
      runtime: RUNTIME_ENV,
      platform: PLATFORM,
      trustedKeys,
      payloadRoot,
    });

    assert.equal(layout.effectiveVersion, "0.1.4");
    assert.equal(layout.payloadVersion, "0.1.4");
    assert.equal(layout.bootNotice, undefined);
    assert.ok(layout.rendererDist.endsWith("renderer"));
    assert.ok(layout.preloadPath.endsWith("preload.cjs"));

    // bootAttempts incremented to 1
    assert.equal((await installer.current())?.bootAttempts, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
