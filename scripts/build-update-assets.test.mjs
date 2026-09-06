import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createTrustedKeyVerifier,
  verifySignedArtifact,
  APP_PAYLOAD_ARTIFACT_LAYOUT,
  parseAppPayloadManifest,
  parseRuntimeSignatureManifest,
} from "@omp-studio/runtime-installer";

import { buildUpdateAssets, resolveAppAbi } from "./build-update-assets.mjs";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });
const testKeyId = "test-release-key-2026";
const trustedKeys = { [testKeyId]: trustedPublicKey };

async function createMockEnvironment(parentDir) {
  const rootDir = join(parentDir, "root");
  const unpackedDir = join(rootDir, "outputs", "installer", "win-unpacked");
  const rendererDir = join(unpackedDir, "resources", "renderer", "dist");
  const preloadPath = join(rootDir, "apps", "desktop", "dist", "preload.cjs");

  await mkdir(rendererDir, { recursive: true });
  await mkdir(join(rootDir, "apps", "desktop", "dist"), { recursive: true });

  await writeFile(
    join(rendererDir, "index.html"),
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body>OMP</body></html>\n',
    "utf8",
  );
  await writeFile(
    join(rendererDir, "bundle.js"),
    "console.log('renderer code');\n",
    "utf8",
  );
  await writeFile(
    preloadPath,
    "console.log('preload code');\n",
    "utf8",
  );

  const runtimeDir = join(unpackedDir, "runtime", "versions", "18.0.11-studio.14");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "runtime-manifest.json"), JSON.stringify({ runtimeVersion: "18.0.11-studio.14", platform: "win32-x64" }));
  for (const name of ["omp.exe", "checksums.json", "runtime-signature.json"]) await writeFile(join(runtimeDir, name), `fixture-${name}`);
  await writeFile(join(rootDir, "outputs", "installer", "OMP-Studio-Setup-0.1.4-win-x64.exe"), "setup-fixture");
  return { rootDir, unpackedDir, rendererDir, preloadPath };

}

test("buildUpdateAssets produces byte-for-byte identical output for identical inputs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-determ-"));
  try {
    const env = await createMockEnvironment(temp);
    const out1 = join(temp, "out1");
    const out2 = join(temp, "out2");

    const fixedDate = "2026-09-05T00:00:00.000Z";

    const res1 = await buildUpdateAssets({
      rootDir: env.rootDir,
      unpackedDir: env.unpackedDir,
      rendererDir: env.rendererDir,
      preloadPath: env.preloadPath,
      outDir: out1,
      appVersion: "0.1.4",
      signingKey,
      keyId: testKeyId,
      sequence: 10,
      generatedAt: fixedDate,
      abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
    });

    const res2 = await buildUpdateAssets({
      rootDir: env.rootDir,
      unpackedDir: env.unpackedDir,
      rendererDir: env.rendererDir,
      preloadPath: env.preloadPath,
      outDir: out2,
      appVersion: "0.1.4",
      signingKey,
      keyId: testKeyId,
      sequence: 10,
      generatedAt: fixedDate,
      abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
    });

    // tar.gz sha256 and bytes match
    assert.equal(res1.tarGzSha256, res2.tarGzSha256);
    assert.equal(res1.tarGzSize, res2.tarGzSize);

    const tarGz1 = await readFile(res1.tarGzPath);
    const tarGz2 = await readFile(res2.tarGzPath);
    assert.ok(tarGz1.equals(tarGz2));

    // update-index.json matches
    const index1 = await readFile(res1.indexJsonPath, "utf8");
    const index2 = await readFile(res2.indexJsonPath, "utf8");
    assert.equal(index1, index2);

    // update-index.sig.json matches
    const sig1 = await readFile(res1.indexSigJsonPath, "utf8");
    const sig2 = await readFile(res2.indexSigJsonPath, "utf8");
    assert.equal(sig1, sig2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("release baselines can be explicitly reviewed for payload and Runtime separately", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-baseline-"));
  try {
    const env = await createMockEnvironment(temp);
    const res = await buildUpdateAssets({ ...env, outDir: join(temp, "out"), appVersion: "0.1.4",
      minAppVersion: "0.1.2", runtimeMinAppVersion: "0.1.3", signingKey, keyId: testKeyId,
      abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" } });
    assert.equal(res.updateIndex.app.payload.minAppVersion, "0.1.2");
    assert.equal(res.updateIndex.runtime.minAppVersion, "0.1.3");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("buildUpdateAssets increments sequence from previous update index", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-seq-"));
  try {
    const env = await createMockEnvironment(temp);
    const out = join(temp, "out");

    const previousIndex = {
      schema: 1,
      sequence: 42,
      generatedAt: "2026-09-04T00:00:00.000Z",
      repo: "the-snowpear/omp-studio",
      app: { version: "0.1.3" },
      runtime: { runtimeVersion: "1.0.0" },
    };

    const res = await buildUpdateAssets({
      rootDir: env.rootDir,
      unpackedDir: env.unpackedDir,
      rendererDir: env.rendererDir,
      preloadPath: env.preloadPath,
      outDir: out,
      appVersion: "0.1.4",
      signingKey,
      keyId: testKeyId,
      previousIndex,
      abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
    });

    assert.equal(res.updateIndex.sequence, 43);

    const onDiskIndex = JSON.parse(await readFile(res.indexJsonPath, "utf8"));
    assert.equal(onDiskIndex.sequence, 43);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("buildUpdateAssets throws when native .node module is found in tree", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-node-"));
  try {
    const env = await createMockEnvironment(temp);
    await writeFile(join(env.rendererDir, "bad-native.node"), "native-binary");

    await assert.rejects(
      () =>
        buildUpdateAssets({
          rootDir: env.rootDir,
          unpackedDir: env.unpackedDir,
          rendererDir: env.rendererDir,
          preloadPath: env.preloadPath,
          outDir: join(temp, "out"),
          appVersion: "0.1.4",
          signingKey,
          keyId: testKeyId,
          abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
        }),
      /App payload must not contain native modules/u,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("buildUpdateAssets throws when index.html lacks Content-Security-Policy", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-csp-"));
  try {
    const env = await createMockEnvironment(temp);
    await writeFile(
      join(env.rendererDir, "index.html"),
      "<html><head><title>No CSP</title></head><body>No CSP</body></html>",
    );

    await assert.rejects(
      () =>
        buildUpdateAssets({
          rootDir: env.rootDir,
          unpackedDir: env.unpackedDir,
          rendererDir: env.rendererDir,
          preloadPath: env.preloadPath,
          outDir: join(temp, "out"),
          appVersion: "0.1.4",
          signingKey,
          keyId: testKeyId,
          abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
        }),
      /Content-Security-Policy meta tag/u,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("buildUpdateAssets produces signatures verifiable by createTrustedKeyVerifier", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-verify-"));
  try {
    const env = await createMockEnvironment(temp);
    const out = join(temp, "out");

    const res = await buildUpdateAssets({
      rootDir: env.rootDir,
      unpackedDir: env.unpackedDir,
      rendererDir: env.rendererDir,
      preloadPath: env.preloadPath,
      outDir: out,
      appVersion: "0.1.4",
      signingKey,
      keyId: testKeyId,
      abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
    });

    // 1. Verify app-payload staging directory using verifySignedArtifact
    const stagingPayload = join(out, "app-payload", "0.1.4");
    const verifiedPayload = await verifySignedArtifact({
      directory: stagingPayload,
      layout: APP_PAYLOAD_ARTIFACT_LAYOUT,
      parseManifest: parseAppPayloadManifest,
      requireCovered: () => ["app-payload-manifest.json", "preload.cjs", "renderer/index.html"],
      trustedKeys,
    });
    assert.equal(verifiedPayload.manifest.payloadVersion, "0.1.4");
    assert.equal(verifiedPayload.manifest.clientContractVersion, CLIENT_CONTRACT_VERSION);
    assert.equal(res.updateIndex.app.payload.clientContractVersion, CLIENT_CONTRACT_VERSION);
    assert.equal(res.updateIndex.app.payload.minAppVersion, "0.1.4");
    assert.equal(res.updateIndex.runtime.minAppVersion, "0.1.4");

    // 2. Verify update-index.sig.json using createTrustedKeyVerifier
    const indexJsonText = await readFile(res.indexJsonPath, "utf8");
    const indexSigRaw = JSON.parse(await readFile(res.indexSigJsonPath, "utf8"));
    const indexSig = parseRuntimeSignatureManifest(indexSigRaw);

    const verifier = createTrustedKeyVerifier(trustedKeys);
    const indexPayloadBytes = Buffer.from(indexJsonText, "utf8");
    assert.equal(
      indexSig.payloadSha256,
      createHash("sha256").update(indexPayloadBytes).digest("hex"),
    );
    assert.ok(verifier.verify(indexSig, indexPayloadBytes));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("ABI comes from the packaged executable, not the Node build process", () => {
  const expected = { electron: "43.4.0", modules: "143", nodePty: "1.1.0" };
  assert.deepEqual(resolveAppAbi({}, "packaged", (exe, args) => {
    assert.equal(exe, join("packaged", "OMP Studio.exe"));
    assert.deepEqual(args, ["--omp-print-abi"]);
    return JSON.stringify(expected);
  }), expected);
  assert.throws(() => resolveAppAbi({ electron: "43.4.0" }, "packaged"), /All three ABI/u);
  assert.throws(() => resolveAppAbi({}, "packaged", () => "{}"), /missing electron/u);
});

test("release builder rejects missing artifacts and invalid previous sequence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-build-assets-required-"));
  try {
    const env = await createMockEnvironment(temp);
    const options = { ...env, outDir: join(temp, "out"), appVersion: "0.1.4", signingKey, keyId: testKeyId, abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" } };
    await assert.rejects(() => buildUpdateAssets({ ...options, previousIndex: { sequence: "42" } }), /Previous update index sequence/u);
    await assert.rejects(() => buildUpdateAssets({ ...options, previousIndex: { sequence: 42 }, sequence: 42 }), /must increase/u);
    const previousIndexPath = join(temp, "previous.json");
    await writeFile(previousIndexPath, JSON.stringify({ sequence: 42 }));
    const built = await buildUpdateAssets({ ...options, previousIndexPath, minAppVersion: "0.1.3" });
    assert.equal(built.updateIndex.sequence, 43);
    assert.equal(built.updateIndex.app.payload.minAppVersion, "0.1.3");
    await rm(join(env.rootDir, "outputs", "installer", "OMP-Studio-Setup-0.1.4-win-x64.exe"));
    await assert.rejects(() => buildUpdateAssets(options), /real Setup installer/u);
    await rm(join(env.unpackedDir, "runtime"), { recursive: true, force: true });
    await assert.rejects(() => buildUpdateAssets(options), /real signed Runtime artifact/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
