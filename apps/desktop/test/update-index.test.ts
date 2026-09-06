import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";
import {
  applyMirror,
  fetchUpdateIndex,
  PAYLOAD_FORMAT,
  parseUpdateIndex,
  planAppUpdate,
  planRuntimeUpdate,
  UPDATE_INDEX_SCHEMA,
  type UpdateIndex,
} from "../src/update-index.js";
import {
  createUpdatePrefsStore,
  DEFAULT_UPDATE_PREFS,
  parseUpdatePrefs,
} from "../src/update-prefs-store.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });
const trustedKeys = { "test-key": trustedPublicKey };

function createSampleIndex(overrides: Partial<UpdateIndex> = {}): UpdateIndex {
  return {
    schema: UPDATE_INDEX_SCHEMA,
    sequence: 10,
    generatedAt: "2026-09-04T00:00:00Z",
    repo: "the-snowpear/omp-studio",
    app: {
      version: "0.1.4",
      setup: {
        asset: "OMP-Studio-Setup-0.1.4-win-x64.exe",
        url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/OMP-Studio-Setup-0.1.4-win-x64.exe",
        size: 175000000,
        sha256: "a".repeat(64),
      },
      payload: {
        asset: "omp-studio-app-0.1.4-win-x64.tar.gz",
        url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/omp-studio-app-0.1.4-win-x64.tar.gz",
        size: 7300000,
        sha256: "b".repeat(64),
        payloadFormat: 1,
        minAppVersion: "0.1.3",
        platform: "win32-x64",
        abi: { electron: "43.4.0", modules: "127", nodePty: "1.1.0" },
        clientContractVersion: 2,
        studioProtocol: { min: 1, max: 1 },
      },
    },
    runtime: {
      runtimeVersion: "18.0.12-studio.1",
      channel: "stable",
      platform: "win32-x64",
      entrypoint: "omp.exe",
      minAppVersion: "0.1.3",
      studioProtocol: { min: 1, max: 1 },
      files: [
        {
          name: "omp.exe",
          url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/omp.exe",
          size: 174000000,
          sha256: "c".repeat(64),
        },
        {
          name: "runtime-manifest.json",
          url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/runtime-manifest.json",
          size: 524,
          sha256: "d".repeat(64),
        },
      ],
    },
    ...overrides,
  };
}

test("parseUpdateIndex parses valid index and rejects malformed fields", () => {
  const valid = createSampleIndex();
  assert.deepEqual(parseUpdateIndex(valid), valid);

  // Missing app.payload is valid
  const withoutPayload = createSampleIndex();
  delete (withoutPayload.app as { payload?: unknown }).payload;
  assert.equal(parseUpdateIndex(withoutPayload).app.payload, undefined);

  // Unknown top-level field rejected
  assert.throws(
    () => parseUpdateIndex({ ...valid, extraField: "not-allowed" }),
    /Unknown top-level field in update index/u,
  );

  // Non-https URL rejected
  const badUrl = createSampleIndex();
  (badUrl.app.setup as { url: string }).url = "http://insecure.com/setup.exe";
  assert.throws(() => parseUpdateIndex(badUrl), /must be an https URL/u);

  // Invalid sha256 rejected (wrong length or uppercase)
  const badSha = createSampleIndex();
  (badSha.app.setup as { sha256: string }).sha256 = "A".repeat(64);
  assert.throws(() => parseUpdateIndex(badSha), /must be a 64-char lowercase hex sha256/u);

  // Empty files array rejected
  const noFiles = createSampleIndex();
  (noFiles as unknown as { runtime: { files: unknown[] } }).runtime.files = [];
  assert.throws(() => parseUpdateIndex(noFiles), /runtime\.files must be a non-empty array/u);
});

test("applyMirror handles prefix variations and rejects non-https or non-github targets", () => {
  const ghUrl = "https://github.com/the-snowpear/omp-studio/releases/latest/download/update-index.json";

  // Empty prefix -> unchanged
  assert.equal(applyMirror("", ghUrl), ghUrl);
  assert.equal(applyMirror("   ", ghUrl), ghUrl);

  // Trailing slash (ghproxy style)
  assert.equal(
    applyMirror("https://mirror.example.com/", ghUrl),
    `https://mirror.example.com/${ghUrl}`,
  );

  // Bare origin
  assert.equal(
    applyMirror("https://mirror.example.com", ghUrl),
    `https://mirror.example.com/${ghUrl}`,
  );

  // Template with {url}
  assert.equal(
    applyMirror("https://proxy.example.com/fetch?target={url}", ghUrl),
    `https://proxy.example.com/fetch?target=${ghUrl}`,
  );

  // Host not in allowed list -> never mirror
  const nonGhUrl = "https://malicious-site.com/evil.json";
  assert.equal(applyMirror("https://mirror.example.com/", nonGhUrl), nonGhUrl);

  // Mirror result not https -> refuse mirror and return original
  assert.equal(applyMirror("http://insecure-mirror.com/", ghUrl), ghUrl);
});

test("fetchUpdateIndex verifies Ed25519 signature, checks sequence watermark, and parses index", async () => {
  const index = createSampleIndex({ sequence: 5 });
  const indexText = JSON.stringify(index, null, 2);
  const payload = Buffer.from(indexText, "utf8");
  const signature = {
    algorithm: "ed25519",
    keyId: "test-key",
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    signature: sign(null, payload, signingKey).toString("base64url"),
  };
  const sigText = JSON.stringify(signature);

  const mockFetcher: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("update-index.sig.json")) {
      return new Response(sigText, { status: 200 });
    }
    if (urlStr.endsWith("update-index.json")) {
      return new Response(indexText, { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  // Valid fetch
  const fetched = await fetchUpdateIndex({
    repo: "the-snowpear/omp-studio",
    mirrorPrefix: "",
    trustedKeys,
    lastSequence: 4,
    fetcher: mockFetcher,
  });
  assert.equal(fetched.sequence, 5);

  // The same signed release remains available after a check or application restart.
  await assert.doesNotReject(
    () =>
      fetchUpdateIndex({
        repo: "the-snowpear/omp-studio",
        mirrorPrefix: "",
        trustedKeys,
        lastSequence: 5,
        fetcher: mockFetcher,
      }),
  );

  await assert.rejects(
    () =>
      fetchUpdateIndex({
        repo: "the-snowpear/omp-studio",
        mirrorPrefix: "",
        trustedKeys,
        lastSequence: 6,
        fetcher: mockFetcher,
      }),
    /older than local watermark/u,
  );

  // Signature tampering rejected
  const tamperedFetcher: typeof fetch = async (url) => {
    const res = await mockFetcher(url);
    if (String(url).endsWith("update-index.json")) {
      return new Response(indexText.replace('"sequence": 5', '"sequence": 6'), { status: 200 });
    }
    return res;
  };
  await assert.rejects(
    () =>
      fetchUpdateIndex({
        repo: "the-snowpear/omp-studio",
        mirrorPrefix: "",
        trustedKeys,
        lastSequence: 0,
        fetcher: tamperedFetcher,
      }),
    /signature verification failed/u,
  );

  // Unknown keyId rejected
  const unknownKeyFetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("update-index.sig.json")) {
      return new Response(JSON.stringify({ ...signature, keyId: "untrusted-key" }), { status: 200 });
    }
    return mockFetcher(url);
  };
  await assert.rejects(
    () =>
      fetchUpdateIndex({
        repo: "the-snowpear/omp-studio",
        mirrorPrefix: "",
        trustedKeys,
        lastSequence: 0,
        fetcher: unknownKeyFetcher,
      }),
    /signature verification failed/u,
  );
});

test("canary discovery uses signed prerelease assets and an independent watermark", async () => {
  const index = createSampleIndex({ sequence: 3 });
  const canary = { ...index, runtime: { ...index.runtime, channel: "canary" as const } };
  const bytes = Buffer.from(JSON.stringify(canary));
  const signature = JSON.stringify({ algorithm: "ed25519", keyId: "test-key",
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    signature: sign(null, bytes, signingKey).toString("base64url") });
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("api.github.com")) return Response.json([
      { draft: false, prerelease: false, tag_name: "v9.0.0", assets: [] },
      { draft: false, prerelease: true, tag_name: "v0.1.5-canary.1", published_at: "2026-09-06T00:00:00Z",
        assets: [{ name: "update-index.json" }, { name: "update-index.sig.json" }] },
    ]);
    assert.ok(url.includes("/download/v0.1.5-canary.1/"));
    return new Response(url.endsWith(".sig.json") ? signature : bytes);
  };
  const input = { repo: index.repo, trustedKeys, mirrorPrefix: "", channel: "canary" as const, arch: "x64" as const, fetcher };
  assert.deepEqual(await fetchUpdateIndex({ ...input, lastSequence: 2 }), canary);
  await assert.rejects(fetchUpdateIndex({ ...input, lastSequence: 4 }), /watermark/);
  await assert.rejects(fetchUpdateIndex({ ...input, lastSequence: 0, fetcher: async () => Response.json([]) }), /No signed canary/);
  assert.equal(urls.some((url) => url.includes("latest/download")), false);
  const temp = await mkdtemp(join(tmpdir(), "channel-watermarks-"));
  try {
    const store = createUpdatePrefsStore({ appDataDirectory: temp });
    await store.write({ lastIndexSequence: 100 });
    await store.write({ lastCanaryIndexSequence: 3 });
    await store.write({ lastCanaryIndexSequence: 1 });
    const prefs = await store.read();
    assert.equal(prefs.lastIndexSequence, 100);
    assert.equal(prefs.lastCanaryIndexSequence, 3);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("incompatible contracts and protocols require Setup before downloading", () => {
  for (const [patch, reason] of [
    [{ clientContractVersion: CLIENT_CONTRACT_VERSION + 1 }, "client-contract"],
    [{ studioProtocol: { min: STUDIO_PROTOCOL_VERSION + 1, max: STUDIO_PROTOCOL_VERSION + 1 } }, "studio-protocol"],
  ] as const) {
    const index = createSampleIndex();
    const payload = { ...index.app.payload!, ...patch };
    const plan = planAppUpdate({ index: { ...index, app: { ...index.app, payload } },
      currentAppVersion: "0.1.3", bundledAppVersion: "0.1.3", runtime: payload.abi,
      platform: payload.platform, skippedVersion: "", preferHot: true });
    assert.equal(plan.kind, "full");
    if (plan.kind === "full") assert.equal(plan.reason, reason);
  }
});

test("planAppUpdate evaluates all conditions in decision table", () => {
  const index = createSampleIndex();
  const baseRuntime = { electron: "43.4.0", modules: "127", nodePty: "1.1.0" };
  const platform = "win32-x64";

  // 1. App version <= currentAppVersion -> none
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.4",
      runtime: baseRuntime,
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    { kind: "none" },
  );

  // 2. Skipped version matched -> none
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: baseRuntime,
      platform,
      skippedVersion: "0.1.4",
      preferHot: true,
    }),
    { kind: "none" },
  );

  // 3. No payload -> full (reason: no-payload)
  const noPayloadIndex = createSampleIndex();
  delete (noPayloadIndex.app as { payload?: unknown }).payload;
  assert.deepEqual(
    planAppUpdate({
      index: noPayloadIndex,
      currentAppVersion: "0.1.3",
      runtime: baseRuntime,
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "no-payload",
    },
  );

  // 4. preferHot === false -> full (reason: no-payload)
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: baseRuntime,
      platform,
      skippedVersion: "",
      preferHot: false,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "no-payload",
    },
  );

  // 5. platform mismatch -> full (reason: platform)
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: baseRuntime,
      platform: "darwin-arm64",
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "platform",
    },
  );

  // 6. payloadFormat > PAYLOAD_FORMAT -> full (reason: payload-format)
  const higherFormatIndex = createSampleIndex();
  (higherFormatIndex.app.payload as { payloadFormat: number }).payloadFormat = PAYLOAD_FORMAT + 1;
  assert.deepEqual(
    planAppUpdate({
      index: higherFormatIndex,
      currentAppVersion: "0.1.3",
      runtime: baseRuntime,
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "payload-format",
    },
  );

  // 7. currentAppVersion < minAppVersion -> full (reason: min-app-version)
  const higherMinIndex = createSampleIndex();
  (higherMinIndex.app.payload as { minAppVersion: string }).minAppVersion = "0.1.4";
  assert.deepEqual(
    planAppUpdate({
      index: higherMinIndex,
      currentAppVersion: "0.1.2",
      runtime: baseRuntime,
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "min-app-version",
    },
  );

  // 8. abi.electron mismatch -> full (reason: electron)
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: { ...baseRuntime, electron: "44.0.0" },
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "electron",
    },
  );

  // 9. abi.modules mismatch -> full (reason: modules)
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: { ...baseRuntime, modules: "128" },
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "modules",
    },
  );

  // 10. abi.nodePty mismatch -> full (reason: node-pty)
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: { ...baseRuntime, nodePty: "1.2.0" },
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "full",
      version: "0.1.4",
      setup: index.app.setup,
      reason: "node-pty",
    },
  );

  // 11. All match -> hot
  assert.deepEqual(
    planAppUpdate({
      index,
      currentAppVersion: "0.1.3",
      runtime: baseRuntime,
      platform,
      skippedVersion: "",
      preferHot: true,
    }),
    {
      kind: "hot",
      version: "0.1.4",
      payload: index.app.payload!,
    },
  );
});

test("planRuntimeUpdate checks platform, protocol, min-app, and version ordering", () => {
  const index = createSampleIndex();
  const platform = "win32-x64";

  // Platform mismatch
  assert.deepEqual(
    planRuntimeUpdate({
      index,
      installedRuntimeVersion: "18.0.11-studio.14",
      channel: "stable",
      platform: "darwin-arm64",
      appVersion: "0.1.4",
      studioProtocol: 1,
    }),
    { kind: "blocked", reason: "platform" },
  );

  // Studio protocol mismatch
  assert.deepEqual(
    planRuntimeUpdate({
      index,
      installedRuntimeVersion: "18.0.11-studio.14",
      channel: "stable",
      platform,
      appVersion: "0.1.4",
      studioProtocol: 2,
    }),
    { kind: "blocked", reason: "protocol" },
  );

  // minAppVersion higher than appVersion
  const higherMinIndex = createSampleIndex();
  (higherMinIndex.runtime as { minAppVersion: string }).minAppVersion = "0.2.0";
  assert.deepEqual(
    planRuntimeUpdate({
      index: higherMinIndex,
      installedRuntimeVersion: "18.0.11-studio.14",
      channel: "stable",
      platform,
      appVersion: "0.1.4",
      studioProtocol: 1,
    }),
    { kind: "blocked", reason: "min-app-version" },
  );

  // Same version installed -> none
  assert.deepEqual(
    planRuntimeUpdate({
      index,
      installedRuntimeVersion: "18.0.12-studio.1",
      channel: "stable",
      platform,
      appVersion: "0.1.4",
      studioProtocol: 1,
    }),
    { kind: "none" },
  );

  // Newer version already installed -> none
  assert.deepEqual(
    planRuntimeUpdate({
      index,
      installedRuntimeVersion: "18.0.13-studio.1",
      channel: "stable",
      platform,
      appVersion: "0.1.4",
      studioProtocol: 1,
    }),
    { kind: "none" },
  );

  // Update available
  assert.deepEqual(
    planRuntimeUpdate({
      index,
      installedRuntimeVersion: "18.0.11-studio.14",
      channel: "stable",
      platform,
      appVersion: "0.1.4",
      studioProtocol: 1,
    }),
    {
      kind: "available",
      runtimeVersion: "18.0.12-studio.1",
      totalBytes: 174000524,
    },
  );
});

test("parseUpdatePrefs and createUpdatePrefsStore handle atomic operations and corrupted files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-prefs-test-"));
  try {
    const store = createUpdatePrefsStore({ appDataDirectory: dir });

    // Missing file returns defaults
    const initial = await store.read();
    assert.deepEqual(initial, DEFAULT_UPDATE_PREFS);

    // Update fields
    const updated = await store.write({
      mirrorPrefix: "https://mirror.example.com/",
      autoCheck: false,
      runtimeChannel: "canary",
      lastIndexSequence: 42,
    });
    assert.equal(updated.mirrorPrefix, "https://mirror.example.com/");
    assert.equal(updated.autoCheck, false);
    assert.equal(updated.runtimeChannel, "canary");
    assert.equal(updated.lastIndexSequence, 42);

    // Verify written file roundtrips
    const reread = await store.read();
    assert.deepEqual(reread, updated);

    // No lingering .tmp file
    const files = await readdir(dir);
    assert.deepEqual(files, ["update-prefs.json"]);

    // Corrupted file falls back to defaults without throwing
    await writeFile(join(dir, "update-prefs.json"), "{ invalid-json }");
    const fallback = await store.read();
    assert.deepEqual(fallback, DEFAULT_UPDATE_PREFS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent preference changes retain both edits and never lower the sequence watermark", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prefs-concurrent-"));
  try {
    const store = createUpdatePrefsStore({ appDataDirectory: dir });
    await Promise.all([
      store.write({ autoCheck: false, lastIndexSequence: 42 }),
      store.write({ runtimeChannel: "canary", lastIndexSequence: 2 }),
      store.write({ mirrorPrefix: "https://mirror.example.com" }),
    ]);
    const prefs = await store.read();
    assert.equal(prefs.autoCheck, false);
    assert.equal(prefs.runtimeChannel, "canary");
    assert.equal(prefs.lastIndexSequence, 42);
    assert.equal(prefs.mirrorPrefix, "https://mirror.example.com");
    assert.deepEqual(await readdir(dir), ["update-prefs.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("index rejects filesystem escape versions and file names before staging writes", () => {
  for (const unsafe of ["../escape", "C:\\escape", "/absolute", "file:stream", "CON.exe"]) {
    const index = createSampleIndex();
    (index.runtime.files[0] as { name: string }).name = unsafe;
    assert.throws(() => parseUpdateIndex(index));
  }
  for (const unsafe of ["../escape", "/absolute", "C:\\escape"]) {
    const index = createSampleIndex();
    (index.runtime as { runtimeVersion: string }).runtimeVersion = unsafe;
    assert.throws(() => parseUpdateIndex(index));
    (index.app as { version: string }).version = unsafe;
    assert.throws(() => parseUpdateIndex(index));
  }
  const duplicate = createSampleIndex();
  (duplicate.runtime.files[1] as { name: string }).name = "OMP.EXE";
  assert.throws(() => parseUpdateIndex(duplicate), /Duplicate/);
});

test("update plans honor runtime channel and bundled main-process compatibility", () => {
  const index = createSampleIndex();
  assert.deepEqual(planRuntimeUpdate({ index, channel: "canary", platform: "win32-x64", appVersion: "0.1.3", studioProtocol: 1 }), { kind: "blocked", reason: "channel" });
  (index.app as { version: string }).version = "0.1.5";
  (index.app.payload as { minAppVersion: string }).minAppVersion = "0.1.4";
  const plan = planAppUpdate({ index, currentAppVersion: "0.1.4", bundledAppVersion: "0.1.3", runtime: index.app.payload!.abi, platform: "win32-x64", skippedVersion: "", preferHot: true });
  assert.equal(plan.kind, "full");
  if (plan.kind === "full") assert.equal(plan.reason, "min-app-version");
});
