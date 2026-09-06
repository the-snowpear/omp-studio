import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { AppPayloadInstaller } from "@omp-studio/runtime-installer";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";

import { UPDATE_INDEX_SCHEMA, type UpdateIndex } from "../src/update-index.js";

import {
  CHROME_UPDATES_CHANNELS,
  type ChromeUpdatesCancelInput,
  type ChromeUpdatesImportInput,
  type ChromeUpdatesPrefsSetInput,
  type UpdateProgressEvent,
} from "../src/chrome-updates-shared.js";
import {
  registerChromeUpdatesIpc,
  type ChromeUpdatesIpcMain,
  type ChromeUpdatesIpcOptions,
  type ChromeUpdatesSender,
} from "../src/chrome-updates.js";
import { createPendingArtifactRegistry } from "../src/runtime-install.js";
import { createUpdatePrefsStore } from "../src/update-prefs-store.js";

const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKey = publicKey.export({ type: "spki", format: "pem" });
const testKeyId = "test-key-2026";
const trustedKeys = { [testKeyId]: trustedPublicKey };

async function createSignedArtifact(input: {
  parent: string;
  version?: string;
  platform?: string;
  channel?: "stable" | "canary";
  tamper?: boolean;
}): Promise<string> {
  const version = input.version ?? "1.0.0";
  const platform = input.platform ?? "win32-x64";
  const channel = input.channel ?? "stable";

  const directory = join(input.parent, `artifact-${version}-${platform}-${channel}`);
  await mkdir(directory, { recursive: true });

  const exeContent = "test-omp-binary";
  await writeFile(join(directory, "omp.exe"), exeContent);

  const manifest = `${JSON.stringify({
    runtimeVersion: version,
    upstreamVersion: "0.1.0",
    upstreamCommit: "abc1234567890",
    patchsetVersion: "0.1.0",
    studioProtocol: { min: 1, max: 1 },
    profile: "full-parity-v1",
    capabilityHash: "cap-hash",
    commandManifestHash: "cmd-hash",
    platform,
    entrypoint: "omp.exe",
    channel,
  })}\n`;
  await writeFile(join(directory, "runtime-manifest.json"), manifest);

  const exeSha = createHash("sha256").update(exeContent).digest("hex");
  const manifestSha = createHash("sha256").update(manifest).digest("hex");
  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "omp.exe": exeSha,
      "runtime-manifest.json": input.tamper ? "0".repeat(64) : manifestSha,
    },
  })}\n`;
  await writeFile(join(directory, "checksums.json"), checksums);

  const payload = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  const sig = sign(null, payload, signingKey).toString("base64url");
  const signatureManifest = `${JSON.stringify({
    algorithm: "ed25519",
    keyId: testKeyId,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    signature: sig,
  })}\n`;
  await writeFile(join(directory, "runtime-signature.json"), signatureManifest);

  return directory;
}

class FakeIpcMain implements ChromeUpdatesIpcMain {
  readonly handlers = new Map<
    string,
    (event: { sender: ChromeUpdatesSender }, payload?: unknown) => unknown
  >();

  handle(
    channel: string,
    listener: (event: { sender: ChromeUpdatesSender }, payload?: unknown) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, sender: ChromeUpdatesSender, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for channel ${channel}`);
    return handler({ sender }, payload);
  }
}


function buildTarHeader(opts: {
  name: string;
  size: number;
  typeflag?: string | undefined;
}): Buffer {
  const header = Buffer.alloc(512);
  const { name, size, typeflag = "0" } = opts;
  Buffer.from(name, "utf8").copy(header, 0, 0, 100);
  Buffer.from("0000644\0", "ascii").copy(header, 100);
  Buffer.from("0000000\0", "ascii").copy(header, 108);
  Buffer.from("0000000\0", "ascii").copy(header, 116);
  Buffer.from(size.toString(8).padStart(11, "0") + " ", "ascii").copy(header, 124);
  Buffer.from("14000000000 ", "ascii").copy(header, 136);
  header.fill(32, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  return header;
}

function createTarGz(entries: Array<{ name: string; content?: Buffer | string; typeflag?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const rawContent = entry.content ?? "";
    const contentBuf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, "utf8");
    const header = buildTarHeader({ name: entry.name, size: contentBuf.length, typeflag: entry.typeflag ?? "0" });
    blocks.push(header);
    if (contentBuf.length > 0) {
      blocks.push(contentBuf);
      const padLen = (512 - (contentBuf.length % 512)) % 512;
      if (padLen > 0) blocks.push(Buffer.alloc(padLen));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function createValidAppTarGz(version = "0.1.4"): { tarGz: Buffer; sha256: string; size: number } {
  const preloadContent = "console.log('preload');";
  const rendererContent = "<!DOCTYPE html><html><body>OMP</body></html>";
  const manifestObj = {
    payloadVersion: version,
    payloadFormat: 1,
    platform: "win32-x64",
    abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
    clientContractVersion: CLIENT_CONTRACT_VERSION,
    studioProtocol: { min: 1, max: 1 },
    entries: ["preload.cjs", "renderer"],
  };
  const manifest = `${JSON.stringify(manifestObj, null, 2)}\n`;
  const checksums = `${JSON.stringify({
    algorithm: "sha256",
    files: {
      "app-payload-manifest.json": createHash("sha256").update(manifest).digest("hex"),
      "preload.cjs": createHash("sha256").update(preloadContent).digest("hex"),
      "renderer/index.html": createHash("sha256").update(rendererContent).digest("hex"),
    },
  }, null, 2)}\n`;
  const payloadBytes = Buffer.concat([Buffer.from(manifest), Buffer.from("\0"), Buffer.from(checksums)]);
  const signature = `${JSON.stringify({
    algorithm: "ed25519",
    keyId: testKeyId,
    payloadSha256: createHash("sha256").update(payloadBytes).digest("hex"),
    signature: sign(null, payloadBytes, signingKey).toString("base64url"),
  })}
`;

  const tarGz = createTarGz([
    { name: "renderer/", typeflag: "5" },
    { name: "preload.cjs", content: preloadContent },
    { name: "renderer/index.html", content: rendererContent },
    { name: "app-payload-manifest.json", content: manifest },
    { name: "checksums.json", content: checksums },
    { name: "payload-signature.json", content: signature },
  ]);

  const sha256 = createHash("sha256").update(tarGz).digest("hex");
  return { tarGz, sha256, size: tarGz.length };
}

describe("registerChromeUpdatesIpc: untrusted sender rejection", () => {
  test("every channel rejects untrusted sender without side effects", async () => {
    const ipc = new FakeIpcMain();
    let dialogCalled = false;
    const progressEvents: UpdateProgressEvent[] = [];
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));

    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => false,
      send: (_ch, p) => progressEvents.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => {
        dialogCalled = true;
        return { canceled: false, filePaths: ["dummy"] };
      },
    });

    const untrustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "http://malicious.origin",
    };

    assert.equal(await ipc.invoke(CHROME_UPDATES_CHANNELS.check, untrustedSender), null);
    assert.deepEqual(await ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, untrustedSender), {
      ok: false,
      message: "Untrusted sender",
    });
    assert.deepEqual(await ipc.invoke(CHROME_UPDATES_CHANNELS.startRuntime, untrustedSender), {
      ok: false,
      message: "Untrusted sender",
    });
    assert.deepEqual(await ipc.invoke(CHROME_UPDATES_CHANNELS.importLocal, untrustedSender), {
      ok: false,
      message: "Untrusted sender",
    });
    assert.equal(await ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, untrustedSender), undefined);
    assert.deepEqual(await ipc.invoke(CHROME_UPDATES_CHANNELS.apply, untrustedSender), {
      ok: false,
      message: "Untrusted sender",
    });
    assert.deepEqual(await ipc.invoke(CHROME_UPDATES_CHANNELS.rollback, untrustedSender), {
      ok: false,
      message: "Untrusted sender",
    });
    assert.equal(await ipc.invoke(CHROME_UPDATES_CHANNELS.prefsGet, untrustedSender), null);
    assert.equal(
      await ipc.invoke(CHROME_UPDATES_CHANNELS.prefsSet, untrustedSender, { autoCheck: false }),
      null,
    );

    assert.equal(dialogCalled, false);
    assert.equal(progressEvents.length, 0);
    assert.equal(pending.peek(), undefined);

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });
});

async function createAppUpdateHarness(extra: Partial<ChromeUpdatesIpcOptions> = {}, full = false) {
  const dir = await mkdtemp(join(tmpdir(), "chrome-update-regression-"));
  const asset = createValidAppTarGz();
  const setupBytes = Buffer.from("signed-installer-bytes");
  const index: UpdateIndex = {
    schema: 1, sequence: 100, generatedAt: "2026-09-05T00:00:00Z", repo: "the-snowpear/omp-studio",
    app: {
      version: "0.1.4",
      setup: { asset: "setup.exe", url: "https://example.com/setup.exe", size: setupBytes.length, sha256: createHash("sha256").update(setupBytes).digest("hex") },
      ...(!full ? { payload: { asset: "payload.tar.gz", url: "https://example.com/payload.tar.gz", size: asset.size, sha256: asset.sha256, payloadFormat: 1, minAppVersion: "0.1.3", platform: "win32-x64", abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" }, clientContractVersion: CLIENT_CONTRACT_VERSION, studioProtocol: { min: 1, max: 1 } } } : {}),
    },
    runtime: { runtimeVersion: "2.0.0", channel: "stable", platform: "win32-x64", entrypoint: "omp.exe", minAppVersion: "0.1.3", studioProtocol: { min: 1, max: 1 }, files: [{ name: "omp.exe", url: "https://example.com/omp.exe", size: 1, sha256: "a".repeat(64) }] },
  };
  const indexText = JSON.stringify(index);
  const payload = Buffer.from(indexText);
  const signature = JSON.stringify({ algorithm: "ed25519", keyId: testKeyId, payloadSha256: createHash("sha256").update(payload).digest("hex"), signature: sign(null, payload, signingKey).toString("base64url") });
  const ipc = new FakeIpcMain();
  const prefs = createUpdatePrefsStore({ appDataDirectory: dir });
  const installer = new AppPayloadInstaller(join(dir, "payload"), { trustedKeys });
  const progress: UpdateProgressEvent[] = [];
  let resolveTerminal!: (event: UpdateProgressEvent) => void;
  const terminal = new Promise<UpdateProgressEvent>((resolve) => { resolveTerminal = resolve; });
  const handle = registerChromeUpdatesIpc({
    ipcMain: ipc, isTrustedSender: () => true,
    send: (_channel, payload) => {
      const event = payload as UpdateProgressEvent;
      progress.push(event);
      if (["failed", "cancelled", "awaiting-apply"].includes(event.phase)) resolveTerminal(event);
    },
    prefs, stagingRoot: join(dir, "staging"), trustedKeys, platform: "win32-x64", pendingArtifact: createPendingArtifactRegistry(),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    fetcher: async (url) => {
      const text = String(url);
      if (text.endsWith("update-index.json")) return new Response(indexText);
      if (text.endsWith("update-index.sig.json")) return new Response(signature);
      if (text.endsWith("setup.exe")) return new Response(setupBytes);
      return new Response(asset.tarGz);
    },
    appVersion: "0.1.3", runtime: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" }, appPayloadInstaller: installer,
    ...extra,
  });
  const sender = { isDestroyed: () => false, getURL: () => "file://app" };
  return { dir, setupBytes, ipc, prefs, installer, progress, terminal, sender, cleanup: async () => { handle.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

test("checking the same release twice still permits starting the advertised hot update", { timeout: 5000 }, async () => {
  const h = await createAppUpdateHarness();
  try {
    for (let i = 0; i < 2; i++) {
      const result = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.check, h.sender) as { error?: string; app: { plan: string } };
      assert.equal(result.error, undefined);
      assert.equal(result.app.plan, "hot");
    }
    const start = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, h.sender) as { ok: boolean };
    assert.equal(start.ok, true);
    assert.equal((await h.terminal).phase, "awaiting-apply");
    assert.equal((await h.prefs.read()).lastIndexSequence, 100);
  } finally { await h.cleanup(); }
});

test("unavailable canary metadata does not suppress the stable application update", async () => {
  const h = await createAppUpdateHarness();
  try {
    await h.prefs.write({ runtimeChannel: "canary", lastCanaryIndexSequence: 200 });
    const result = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.check, h.sender) as {
      app: { plan: string }; runtime: { plan: string }; error?: string;
    };
    assert.equal(result.error, undefined);
    assert.equal(result.app.plan, "hot");
    assert.equal(result.runtime.plan, "blocked");
    assert.equal((await h.prefs.read()).lastIndexSequence, 100);
    assert.equal((await h.prefs.read()).lastCanaryIndexSequence, 200);
  } finally { await h.cleanup(); }
});

test("a staged payload can be downloaded again after cancellation before activation", { timeout: 5000 }, async () => {
  const h = await createAppUpdateHarness();
  try {
    const first = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, h.sender) as { jobId: string };
    assert.equal((await h.terminal).phase, "awaiting-apply");
    await h.ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, h.sender, { jobId: first.jobId });
    const second = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, h.sender) as { ok: boolean; jobId: string };
    assert.equal(second.ok, true);
    const deadline = Date.now() + 3000;
    while (!h.progress.some((event) => event.jobId === second.jobId && ["failed", "awaiting-apply"].includes(event.phase))) {
      assert.ok(Date.now() < deadline, "retry must settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(h.progress.find((event) => event.jobId === second.jobId && event.phase === "failed"), undefined);
    assert.equal((await h.ipc.invoke(CHROME_UPDATES_CHANNELS.apply, h.sender) as { ok: boolean }).ok, true);
    assert.equal((await h.installer.current())?.payloadVersion, "0.1.4");
  } finally { await h.cleanup(); }
});

test("cancellation during payload verification retains the job slot and cannot publish a pending payload", { timeout: 5000 }, async () => {
  const h = await createAppUpdateHarness();
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const installing = new Promise<void>((resolve) => { entered = resolve; });
  const install = h.installer.install.bind(h.installer);
  h.installer.install = async (directory) => { entered(); await hold; return install(directory); };
  try {
    const start = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, h.sender) as { jobId: string };
    await installing;
    await h.ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, h.sender, { jobId: start.jobId });
    assert.equal((await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startRuntime, h.sender) as { ok: boolean }).ok, false);
    assert.equal((await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, h.sender) as { ok: boolean }).ok, false);
    release();
    for (let i = 0; i < 100 && h.progress.filter((event) => event.phase === "cancelled").length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.progress.some((event) => event.phase === "awaiting-apply"), false);
    assert.equal((await h.ipc.invoke(CHROME_UPDATES_CHANNELS.apply, h.sender) as { ok: boolean }).ok, false);
  } finally { release(); await h.cleanup(); }
});

test("full installer uses opaque job IDs, defers while busy, and rechecks bytes before launch", { timeout: 5000 }, async () => {
  let busy = true;
  let launches = 0;
  let quit = false;
  const h = await createAppUpdateHarness({ isBusy: () => busy, openPath: async () => { launches++; return ""; }, quit: () => { quit = true; } }, true);
  try {
    const start = await h.ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, h.sender) as { ok: boolean; jobId: string };
    assert.equal(start.ok, true);
    assert.equal(JSON.stringify(start).includes(h.dir), false);
    assert.equal((await h.terminal).phase, "awaiting-apply");
    assert.deepEqual(await h.ipc.invoke(CHROME_UPDATES_CHANNELS.apply, h.sender), { ok: true, deferred: true });
    assert.equal(launches, 0);
    busy = false;
    const installerPath = join(h.dir, "staging", "app", "0.1.4", "setup.exe");
    await writeFile(installerPath, "tampered");
    assert.equal((await h.ipc.invoke(CHROME_UPDATES_CHANNELS.apply, h.sender) as { ok: boolean }).ok, false);
    assert.equal(launches, 0);
    await writeFile(installerPath, h.setupBytes);
    assert.deepEqual(await h.ipc.invoke(CHROME_UPDATES_CHANNELS.apply, h.sender), { ok: true });
    assert.equal(launches, 1);
    assert.equal(quit, true);
  } finally { await h.cleanup(); }
});

describe("registerChromeUpdatesIpc: importLocal runtime", () => {
  test("importLocal user cancel returns cancelled: true", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: () => {},
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.importLocal, trustedSender, {
      kind: "runtime",
      source: "directory",
    } satisfies ChromeUpdatesImportInput)) as { ok: boolean; cancelled?: boolean };

    assert.deepEqual(res, { ok: false, cancelled: true });
    assert.equal(pending.peek(), undefined);

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("importLocal fails on invalid signature and does not leak absolute paths", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const progress: UpdateProgressEvent[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });

    const artifactDir = await createSignedArtifact({
      parent: tempDir,
      tamper: true, // Tamper checksum to trigger verification failure
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: false, filePaths: [artifactDir] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.importLocal, trustedSender, {
      kind: "runtime",
      source: "directory",
    })) as { ok: boolean; message?: string };

    assert.equal(res.ok, false);
    assert.ok(res.message !== undefined);
    assert.equal(pending.peek(), undefined);

    // Assert that no Windows absolute path or drive letter leaked in JSON representation
    assert.equal(/[A-Za-z]:\\/.test(JSON.stringify(res)), false);
    assert.ok(progress.some((p) => p.phase === "failed"));

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("importLocal rejects platform mismatch", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const progress: UpdateProgressEvent[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });

    const artifactDir = await createSignedArtifact({
      parent: tempDir,
      platform: "darwin-arm64",
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: false, filePaths: [artifactDir] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.importLocal, trustedSender, {
      kind: "runtime",
      source: "directory",
    })) as { ok: boolean; message?: string };

    assert.equal(res.ok, false);
    assert.match(res.message ?? "", /平台不匹配/);
    assert.equal(pending.peek(), undefined);

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("importLocal rejects channel mismatch", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const progress: UpdateProgressEvent[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    await prefs.write({ runtimeChannel: "stable" });

    const artifactDir = await createSignedArtifact({
      parent: tempDir,
      channel: "canary",
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: false, filePaths: [artifactDir] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.importLocal, trustedSender, {
      kind: "runtime",
      source: "directory",
    })) as { ok: boolean; message?: string };

    assert.equal(res.ok, false);
    assert.match(res.message ?? "", /通道不匹配/);
    assert.equal(pending.peek(), undefined);

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("importLocal preserves the verified canary channel through the install handoff", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const progress: UpdateProgressEvent[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    await prefs.write({ runtimeChannel: "canary" });

    const artifactDir = await createSignedArtifact({
      parent: tempDir,
      version: "2.5.0",
      platform: "win32-x64",
      channel: "canary",
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: false, filePaths: [artifactDir] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.importLocal, trustedSender, {
      kind: "runtime",
      source: "directory",
    })) as { ok: boolean; jobId?: string; runtimeVersion?: string; runtimeChannel?: string };

    assert.equal(res.ok, true);
    assert.equal(res.runtimeVersion, "2.5.0");
    assert.equal(res.runtimeChannel, "canary");
    assert.ok(typeof res.jobId === "string");
    assert.equal(pending.peek(), artifactDir);

    assert.ok(progress.some((p) => p.phase === "verifying"));
    assert.equal(progress.find((p) => p.phase === "awaiting-apply")?.runtimeChannel, "canary");

    // Cancel cleans up pendingArtifact
    await ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, trustedSender, {
      jobId: res.jobId!,
    } satisfies ChromeUpdatesCancelInput);
    assert.equal(pending.peek(), undefined);
    assert.ok(progress.some((p) => p.phase === "cancelled"));

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prefsSet rejects non-https mirror prefix", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: () => {},
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const rejectRes = await ipc.invoke(CHROME_UPDATES_CHANNELS.prefsSet, trustedSender, {
      mirrorPrefix: "http://insecure.example.com",
    } satisfies ChromeUpdatesPrefsSetInput);
    assert.equal(rejectRes, null);

    const acceptRes = (await ipc.invoke(CHROME_UPDATES_CHANNELS.prefsSet, trustedSender, {
      mirrorPrefix: "https://mirror.example.com/",
    })) as { mirrorPrefix?: string };
    assert.ok(acceptRes !== null);
    assert.equal(acceptRes.mirrorPrefix, "https://mirror.example.com/");

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("check returns error without throwing when fetch fails", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: () => {},
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      fetcher: async () => {
        throw new Error("network timeout simulated");
      },
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.check, trustedSender)) as {
      error?: string;
      app: { plan: string };
      runtime: { plan: string };
    };
    assert.ok(res !== null);
    assert.equal(res.app.plan, "none");
    assert.equal(res.runtime.plan, "none");
    assert.ok(res.error?.includes("network timeout simulated"));

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("check rejects sequence watermark rollback", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    await prefs.write({ lastIndexSequence: 50 });

    const testIndex: UpdateIndex = {
      schema: UPDATE_INDEX_SCHEMA,
      sequence: 20,
      generatedAt: "2026-09-04T00:00:00Z",
      repo: "the-snowpear/omp-studio",
      app: {
        version: "0.1.4",
        setup: {
          asset: "setup.exe",
          url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/setup.exe",
          size: 1000,
          sha256: "a".repeat(64),
        },
      },
      runtime: {
        runtimeVersion: "2.0.0",
        channel: "stable",
        platform: "win32-x64",
        entrypoint: "omp.exe",
        minAppVersion: "0.1.0",
        studioProtocol: { min: 1, max: 1 },
        files: [
          {
            name: "omp.exe",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/omp.exe",
            size: 1000,
            sha256: "c".repeat(64),
          },
        ],
      },
    };

    const indexJson = JSON.stringify(testIndex);
    const payload = Buffer.from(indexJson, "utf8");
    const sig = sign(null, payload, signingKey).toString("base64url");
    const sigJson = JSON.stringify({
      algorithm: "ed25519",
      keyId: testKeyId,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      signature: sig,
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: () => {},
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("update-index.json")) {
          return new Response(indexJson, { status: 200 });
        }
        if (url.endsWith("update-index.sig.json")) {
          return new Response(sigJson, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const res = (await ipc.invoke(CHROME_UPDATES_CHANNELS.check, trustedSender)) as {
      error?: string;
      app: { plan: string };
      runtime: { plan: string };
    };
    assert.ok(res.error?.includes("watermark"));

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("startRuntime downloads small files before big exe and verifies artifact", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    const progress: UpdateProgressEvent[] = [];

    const manifestContent = JSON.stringify({
      runtimeVersion: "2.0.0",
      upstreamVersion: "0.1.0",
      upstreamCommit: "abc1234567890",
      patchsetVersion: "0.1.0",
      studioProtocol: { min: 1, max: 1 },
      profile: "full-parity-v1",
      capabilityHash: "cap-hash",
      commandManifestHash: "cmd-hash",
      platform: "win32-x64",
      entrypoint: "omp.exe",
      channel: "stable",
    });
    const exeContent = "dummy-omp-exe-binary-content";
    const manifestSha = createHash("sha256").update(manifestContent).digest("hex");
    const exeSha = createHash("sha256").update(exeContent).digest("hex");

    const checksumsContent = JSON.stringify({
      algorithm: "sha256",
      files: {
        "runtime-manifest.json": manifestSha,
        "omp.exe": exeSha,
      },
    });

    const payload = Buffer.concat([Buffer.from(manifestContent), Buffer.from("\0"), Buffer.from(checksumsContent)]);
    const sig = sign(null, payload, signingKey).toString("base64url");
    const sigContent = JSON.stringify({
      algorithm: "ed25519",
      keyId: testKeyId,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      signature: sig,
    });

    const filesMap: Record<string, string> = {
      "runtime-manifest.json": manifestContent,
      "checksums.json": checksumsContent,
      "runtime-signature.json": sigContent,
      "omp.exe": exeContent,
    };

    const fetchedUrls: string[] = [];

    const testIndex: UpdateIndex = {
      schema: UPDATE_INDEX_SCHEMA,
      sequence: 10,
      generatedAt: "2026-09-04T00:00:00Z",
      repo: "the-snowpear/omp-studio",
      app: {
        version: "0.1.4",
        setup: {
          asset: "setup.exe",
          url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/setup.exe",
          size: 1000,
          sha256: "a".repeat(64),
        },
      },
      runtime: {
        runtimeVersion: "2.0.0",
        channel: "stable",
        platform: "win32-x64",
        entrypoint: "omp.exe",
        minAppVersion: "0.1.0",
        studioProtocol: { min: 1, max: 1 },
        files: [
          {
            name: "omp.exe",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/omp.exe",
            size: Buffer.byteLength(exeContent),
            sha256: exeSha,
          },
          {
            name: "runtime-manifest.json",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/runtime-manifest.json",
            size: Buffer.byteLength(manifestContent),
            sha256: manifestSha,
          },
          {
            name: "checksums.json",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/checksums.json",
            size: Buffer.byteLength(checksumsContent),
            sha256: createHash("sha256").update(checksumsContent).digest("hex"),
          },
          {
            name: "runtime-signature.json",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/runtime-signature.json",
            size: Buffer.byteLength(sigContent),
            sha256: createHash("sha256").update(sigContent).digest("hex"),
          },
        ],
      },
    };

    const indexJson = JSON.stringify(testIndex);
    const indexSig = sign(null, Buffer.from(indexJson, "utf8"), signingKey).toString("base64url");
    const indexSigJson = JSON.stringify({
      algorithm: "ed25519",
      keyId: testKeyId,
      payloadSha256: createHash("sha256").update(Buffer.from(indexJson, "utf8")).digest("hex"),
      signature: indexSig,
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      fetcher: async (input) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.endsWith("update-index.json")) return new Response(indexJson, { status: 200 });
        if (url.endsWith("update-index.sig.json")) return new Response(indexSigJson, { status: 200 });
        for (const [name, content] of Object.entries(filesMap)) {
          if (url.endsWith(name)) {
            return new Response(content, { status: 200 });
          }
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    const startRes = (await ipc.invoke(CHROME_UPDATES_CHANNELS.startRuntime, trustedSender)) as {
      ok: boolean;
      jobId?: string;
    };
    assert.equal(startRes.ok, true);

    for (let i = 0; i < 50; i++) {
      if (progress.some((p) => p.phase === "awaiting-apply" || p.phase === "failed")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(progress.some((p) => p.phase === "awaiting-apply"), "Should reach awaiting-apply");
    assert.equal(progress.find((p) => p.phase === "awaiting-apply")?.runtimeChannel, "stable");
    assert.ok(pending.peek() !== undefined, "pendingArtifact should be set");

    const exeIndex = fetchedUrls.findIndex((u) => u.endsWith("omp.exe"));
    const manifestIndex = fetchedUrls.findIndex((u) => u.endsWith("runtime-manifest.json"));
    const checksumsIndex = fetchedUrls.findIndex((u) => u.endsWith("checksums.json"));

    assert.ok(manifestIndex !== -1 && exeIndex !== -1);
    assert.ok(manifestIndex < exeIndex, "runtime-manifest.json must be fetched before omp.exe");
    assert.ok(checksumsIndex < exeIndex, "checksums.json must be fetched before omp.exe");

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("startRuntime rejects when downloaded manifest version mismatches index", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    const progress: UpdateProgressEvent[] = [];

    const manifestContent = JSON.stringify({
      runtimeVersion: "9.9.9",
      channel: "stable",
      platform: "win32-x64",
    });

    const fetchedUrls: string[] = [];

    const testIndex: UpdateIndex = {
      schema: UPDATE_INDEX_SCHEMA,
      sequence: 10,
      generatedAt: "2026-09-04T00:00:00Z",
      repo: "the-snowpear/omp-studio",
      app: {
        version: "0.1.4",
        setup: {
          asset: "setup.exe",
          url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/setup.exe",
          size: 1000,
          sha256: "a".repeat(64),
        },
      },
      runtime: {
        runtimeVersion: "2.0.0",
        channel: "stable",
        platform: "win32-x64",
        entrypoint: "omp.exe",
        minAppVersion: "0.1.0",
        studioProtocol: { min: 1, max: 1 },
        files: [
          {
            name: "runtime-manifest.json",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/runtime-manifest.json",
            size: Buffer.byteLength(manifestContent),
            sha256: createHash("sha256").update(manifestContent).digest("hex"),
          },
          {
            name: "omp.exe",
            url: "https://github.com/the-snowpear/omp-studio/releases/download/v0.1.4/omp.exe",
            size: 100,
            sha256: "e".repeat(64),
          },
        ],
      },
    };

    const indexJson = JSON.stringify(testIndex);
    const indexSig = sign(null, Buffer.from(indexJson, "utf8"), signingKey).toString("base64url");
    const indexSigJson = JSON.stringify({
      algorithm: "ed25519",
      keyId: testKeyId,
      payloadSha256: createHash("sha256").update(Buffer.from(indexJson, "utf8")).digest("hex"),
      signature: indexSig,
    });

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      fetcher: async (input) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.endsWith("update-index.json")) return new Response(indexJson, { status: 200 });
        if (url.endsWith("update-index.sig.json")) return new Response(indexSigJson, { status: 200 });
        if (url.endsWith("runtime-manifest.json")) return new Response(manifestContent, { status: 200 });
        return new Response("Not Found", { status: 404 });
      },
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "file://app",
    };

    await ipc.invoke(CHROME_UPDATES_CHANNELS.startRuntime, trustedSender);

    for (let i = 0; i < 50; i++) {
      if (progress.some((p) => p.phase === "failed")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const failEvent = progress.find((p) => p.phase === "failed");
    assert.ok(failEvent !== undefined, "Should fail on manifest mismatch");
    assert.ok(failEvent.message?.includes("不一致"));
    assert.ok(!fetchedUrls.some((u) => u.endsWith("omp.exe")), "omp.exe must not be fetched");

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("startup GC cleans directories older than 7 days and already installed versions", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-test-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    const stagingRoot = join(tempDir, "staging");

    const oldDir = join(stagingRoot, "runtime", "0.9.0-old");
    const installedDir = join(stagingRoot, "runtime", "1.0.0");
    const newerDir = join(stagingRoot, "runtime", "2.0.0");

    await mkdir(oldDir, { recursive: true });
    await mkdir(installedDir, { recursive: true });
    await mkdir(newerDir, { recursive: true });

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldDir, tenDaysAgo, tenDaysAgo);

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: () => {},
      prefs,
      stagingRoot,
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      getInstalledRuntimeVersion: async () => "1.0.0",
    });

    await new Promise((r) => setTimeout(r, 100));

    await assert.rejects(() => stat(oldDir));
    await assert.rejects(() => stat(installedDir));
    const newerStat = await stat(newerDir);
    assert.ok(newerStat.isDirectory());

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });
  test("startApp downloads, extracts, verifies signature, installs to appPayloadInstaller, and applies with busy check", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-app-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    const stagingRoot = join(tempDir, "staging");
    const payloadRoot = join(tempDir, "payload");
    const appPayloadInstaller = new AppPayloadInstaller(payloadRoot, { trustedKeys });

    const appAsset = createValidAppTarGz("0.1.4");

    const indexData: UpdateIndex = {
      schema: UPDATE_INDEX_SCHEMA,
      sequence: 15,
      generatedAt: "2026-09-05T00:00:00.000Z",
      repo: "the-snowpear/omp-studio",
      app: {
        version: "0.1.4",
        releaseNotesUrl: "https://example.com/notes",
        setup: {
          asset: "setup.exe",
          url: "https://example.com/setup.exe",
          size: 1000,
          sha256: "a".repeat(64),
        },
        payload: {
          asset: "payload.tar.gz",
          url: "https://example.com/payload.tar.gz",
          sha256: appAsset.sha256,
          size: appAsset.size,
          minAppVersion: "0.1.0",
          abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
          platform: "win32-x64",
          payloadFormat: 1,
          clientContractVersion: CLIENT_CONTRACT_VERSION,
          studioProtocol: { min: 1, max: 1 },
        },
      },
      runtime: {
        runtimeVersion: "2.0.0",
        channel: "stable",
        platform: "win32-x64",
        entrypoint: "omp.exe",
        minAppVersion: "0.1.0",
        studioProtocol: { min: 1, max: 1 },
        files: [
          {
            name: "omp.exe",
            url: "https://example.com/omp.exe",
            size: 1000,
            sha256: "c".repeat(64),
          },
        ],
      },
    };

    const indexJson = JSON.stringify(indexData, null, 2);
    const indexPayload = Buffer.from(indexJson, "utf8");
    const indexSig = {
      algorithm: "ed25519",
      keyId: testKeyId,
      payloadSha256: createHash("sha256").update(indexPayload).digest("hex"),
      signature: sign(null, indexPayload, signingKey).toString("base64url"),
    };

    const mockFetcher = async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("update-index.json")) {
        return new Response(indexJson, { status: 200 });
      }
      if (url.endsWith("update-index.sig.json")) {
        return new Response(JSON.stringify(indexSig), { status: 200 });
      }
      if (url.endsWith("payload.tar.gz")) {
        return new Response(appAsset.tarGz, {
          status: 200,
          headers: { "content-length": String(appAsset.size) },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let busy = true;
    let relaunchArgs: readonly string[] | undefined = undefined;
    let quitCalled = false;
    const progress: UpdateProgressEvent[] = [];

    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_channel, payload) => progress.push(payload as UpdateProgressEvent),
      prefs,
      stagingRoot,
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      fetcher: mockFetcher as any,
      appVersion: "0.1.3",
      runtime: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
      appPayloadInstaller,
      isBusy: () => busy,
      relaunch: (opts) => { relaunchArgs = opts?.args; },
      quit: () => { quitCalled = true; },
    });

    const startRes = (await ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    })) as any;

    assert.equal(startRes.ok, true);
    assert.ok(startRes.jobId?.startsWith("app-"));

    // Wait for background download and verification
    for (let i = 0; i < 40 && !progress.some((p) => p.phase === "awaiting-apply"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(progress.some((p) => p.phase === "downloading"));
    assert.ok(progress.some((p) => p.phase === "verifying"));
    assert.ok(progress.some((p) => p.phase === "awaiting-apply"));

    // 1. apply while busy -> deferred: true
    const applyRes1 = (await ipc.invoke(CHROME_UPDATES_CHANNELS.apply, {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    })) as any;
    assert.equal(applyRes1.ok, true);
    assert.equal(applyRes1.deferred, true);
    assert.equal(relaunchArgs, undefined);
    assert.equal(quitCalled, false);

    assert.equal(await appPayloadInstaller.current(), undefined);
    busy = false;
    const applyRes2 = await ipc.invoke(CHROME_UPDATES_CHANNELS.apply, {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    });
    assert.deepEqual(applyRes2, { ok: true });
    // Retrying when idle activates the prepared version and restarts.
    const cur = await appPayloadInstaller.current();
    assert.equal(cur?.payloadVersion, "0.1.4");

    // 2. rollback when idle -> calls relaunch and quit
    busy = false;
    const rollRes = (await ipc.invoke(CHROME_UPDATES_CHANNELS.rollback, {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    })) as any;
    assert.equal(rollRes.ok, true);
    assert.equal(rollRes.deferred, undefined);
    assert.ok((relaunchArgs as any)?.includes("--omp-restarted"));
    assert.equal(quitCalled, true);

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("cancel aborts active app update job and emits cancelled progress", async () => {
    const ipc = new FakeIpcMain();
    const pending = createPendingArtifactRegistry();
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-cancel-"));
    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    const stagingRoot = join(tempDir, "staging");
    const payloadRoot = join(tempDir, "payload");
    const appPayloadInstaller = new AppPayloadInstaller(payloadRoot, { trustedKeys });
    const appAsset = createValidAppTarGz("0.1.4");

    const indexData: UpdateIndex = {
      schema: UPDATE_INDEX_SCHEMA,
      sequence: 16,
      generatedAt: "2026-09-05T00:00:00.000Z",
      repo: "the-snowpear/omp-studio",
      app: {
        version: "0.1.4",
        setup: {
          asset: "setup.exe",
          url: "https://example.com/setup.exe",
          size: 1000,
          sha256: "a".repeat(64),
        },
        payload: {
          asset: "payload.tar.gz",
          url: "https://example.com/payload.tar.gz",
          sha256: appAsset.sha256,
          size: appAsset.size,
          minAppVersion: "0.1.0",
          abi: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
          platform: "win32-x64",
          payloadFormat: 1,
          clientContractVersion: CLIENT_CONTRACT_VERSION,
          studioProtocol: { min: 1, max: 1 },
        },
      },
      runtime: {
        runtimeVersion: "2.0.0",
        channel: "stable",
        platform: "win32-x64",
        entrypoint: "omp.exe",
        minAppVersion: "0.1.0",
        studioProtocol: { min: 1, max: 1 },
        files: [
          {
            name: "omp.exe",
            url: "https://example.com/omp.exe",
            size: 1000,
            sha256: "c".repeat(64),
          },
        ],
      },
    };
    const indexJson = JSON.stringify(indexData);
    const indexPayload = Buffer.from(indexJson, "utf8");
    const indexSig = {
      algorithm: "ed25519",
      keyId: testKeyId,
      payloadSha256: createHash("sha256").update(indexPayload).digest("hex"),
      signature: sign(null, indexPayload, signingKey).toString("base64url"),
    };

    const mockFetcher = async (url: string) => {
      if (url.endsWith("update-index.json")) return new Response(indexJson);
      if (url.endsWith("update-index.sig.json")) return new Response(JSON.stringify(indexSig));
      if (url.endsWith("payload.tar.gz")) {
        // Hang indefinitely
        return new Promise(() => {});
      }
      throw new Error("Unexpected");
    };

    const progress: UpdateProgressEvent[] = [];
    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_channel, payload) => progress.push(payload as UpdateProgressEvent),
      prefs,
      stagingRoot,
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      fetcher: mockFetcher as any,
      appVersion: "0.1.3",
      runtime: { electron: "43.4.0", modules: "143", nodePty: "1.1.0" },
      appPayloadInstaller,
    });

    const startRes = (await ipc.invoke(CHROME_UPDATES_CHANNELS.startApp, {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    })) as any;
    assert.equal(startRes.ok, true);

    // Cancel the job
    await ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    }, { jobId: startRes.jobId });

    assert.ok(progress.some((p) => p.phase === "cancelled" && p.kind === "app"));
    // The IPC acknowledgement precedes cooperative cancellation of file work.
    const deadline = Date.now() + 3000;
    while (progress.filter((event) => event.phase === "cancelled").length < 2) {
      assert.ok(Date.now() < deadline, "cancelled file work must settle before cleanup");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("cancel ignores unknown job IDs without clearing pending artifacts or emitting events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "omp-chrome-updates-cancel-prefix-"));
    const ipc = new FakeIpcMain();
    const progress: UpdateProgressEvent[] = [];
    const pending = createPendingArtifactRegistry();
    pending.set("some/runtime/path");

    const prefs = createUpdatePrefsStore({ appDataDirectory: tempDir });
    const handle = registerChromeUpdatesIpc({
      ipcMain: ipc,
      isTrustedSender: () => true,
      send: (_ch, p) => progress.push(p as UpdateProgressEvent),
      prefs,
      stagingRoot: join(tempDir, "staging"),
      trustedKeys,
      platform: "win32-x64",
      pendingArtifact: pending,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    });

    const trustedSender: ChromeUpdatesSender = {
      isDestroyed: () => false,
      getURL: () => "app://index.html",
    };

    // Cancel an app job that has already completed/cleared activeJob
    await ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, trustedSender, { jobId: "app-abc12345" });

    await ipc.invoke(CHROME_UPDATES_CHANNELS.cancel, trustedSender, { jobId: "unknown-runtime-id" });
    assert.deepEqual(progress, []);
    // Crucially, pendingArtifact for runtime must NOT have been cleared
    assert.equal(pending.peek(), "some/runtime/path");

    handle.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });
});
