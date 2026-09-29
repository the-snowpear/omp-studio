import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { RuntimeInstaller, createRuntimeArchive, updateSigningBytes, type ComponentRelease, type SignedUpdateManifest, type UpdateFile, type UpdateManifest } from "@omp-studio/runtime-installer";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";

import { UpdateCoordinator, type DesktopInstallOutcome, type UpdateCoordinatorOptions } from "../src/update-coordinator.js";
import { DEFAULT_UPDATE_PREFS } from "../src/update-prefs-store.js";

const PLATFORM = "darwin-arm64";
const pair = generateKeyPairSync("ed25519");
const keys = { test: pair.publicKey.export({ type: "spki", format: "pem" }) };
const map = gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums: ["checksum"], sizes: [3] }] }));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function file(asset: string, bytes: Buffer): UpdateFile {
  return { asset, url: `https://github.com/owner/repo/releases/download/v/${asset}`, size: bytes.length, sha256: hash(bytes), sha512: createHash("sha512").update(bytes).digest("base64") };
}

/** Every served file by asset name. */
const served = new Map<string, Buffer>();

function release(asset: string, version: string, sequence: number, extra: Partial<ComponentRelease> = {}): ComponentRelease {
  const bytes = served.get(asset) ?? Buffer.from(`${asset}-bytes`);
  served.set(asset, bytes);
  served.set(`${asset}.blockmap`, map);
  return { version, sequence, channel: "stable", file: file(asset, bytes), blockmap: file(`${asset}.blockmap`, map), minAppVersion: "1.0.0", studioProtocol: { min: 1, max: 1 }, ...extra };
}

const appRelease = (version: string, sequence: number) => release(`OMP-Studio-${version}-macos-arm64.zip`, version, sequence);

function signed(parts: Partial<Pick<UpdateManifest, "app" | "runtime">>): SignedUpdateManifest {
  const manifest: UpdateManifest = { schema: 2, repo: "owner/repo", platform: PLATFORM, generatedAt: "2026-09-29T00:00:00Z", releaseNotesUrl: "https://github.com/owner/repo/releases/tag/v", ...parts };
  return { manifest, signature: { algorithm: "ed25519", keyId: "test", value: sign(null, updateSigningBytes(manifest), pair.privateKey).toString("base64url") } };
}

function fetcher(releases: SignedUpdateManifest[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      return new Response(JSON.stringify(releases.map((_, i) => ({ assets: [{ name: `updates-${PLATFORM}.json`, browser_download_url: `https://github.com/owner/repo/releases/download/r${i}/updates-${PLATFORM}.json` }] }))));
    }
    const index = /\/r(\d+)\/updates-/u.exec(u);
    if (index) return new Response(JSON.stringify(releases[Number(index[1])]));
    const bytes = served.get(u.split("/").at(-1)!);
    return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch;
}

interface Harness {
  readonly installs: { path: string; version: string }[];
  quits: number;
  restarts: number;
  options(appVersion: string, extra?: Partial<UpdateCoordinatorOptions>): UpdateCoordinatorOptions;
}

async function harness(releases: SignedUpdateManifest[], runtimeRoot?: string): Promise<{ root: string; journal: () => Promise<Record<string, any>>; h: Harness }> {
  const root = await mkdtemp(join(tmpdir(), "omp-update-mac-"));
  const h: Harness = {
    installs: [],
    quits: 0,
    restarts: 0,
    options(appVersion, extra = {}) {
      return {
        root, runtimeRoot: runtimeRoot ?? join(root, "runtimes"), repo: "owner/repo", platform: PLATFORM, appVersion, keys,
        prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {},
        installDesktop: async (path, next) => { h.installs.push({ path, version: next.version }); },
        restart: () => { h.restarts++; }, quit: () => { h.quits++; },
        fetcher: fetcher(releases), desktopCommit: "confirmed", trackAppBaselineWithoutBase: true,
        activateOptions: { selfCheck: { run: async () => {} } },
        ...extra,
      };
    },
  };
  return { root, journal: async () => JSON.parse(await readFile(join(root, "transaction-v2.json"), "utf8")), h };
}

async function installFromV1(h: Harness, extra?: Partial<UpdateCoordinatorOptions>): Promise<void> {
  const v1 = new UpdateCoordinator(h.options("1.0.0", extra));
  await v1.initialize(); await v1.check(); await v1.prepare("all");
  assert.deepEqual(await v1.apply(), { ok: true });
}

test("a macOS desktop update commits only once the new version confirms it is healthy", async () => {
  const { h, journal } = await harness([signed({ app: appRelease("1.0.0", 1) }), signed({ app: appRelease("2.0.0", 2) })]);
  await installFromV1(h);
  assert.deepEqual(h.installs.map((install) => install.version), ["2.0.0"]);
  assert.equal(h.quits, 1);

  const v2 = new UpdateCoordinator(h.options("2.0.0"));
  await v2.initialize();
  assert.equal(v2.state.app.phase, "verifying");
  assert.equal((await journal()).pending.app.manifest.app.version, "2.0.0", "still revocable by the swap helper");
  assert.deepEqual(await v2.apply(), { ok: false, message: "没有待应用的更新" }, "the running version is never installed again");
  assert.equal(h.installs.length, 1);

  await v2.confirmDesktopStartup();
  const saved = await journal();
  assert.equal(saved.pending.app, undefined);
  assert.equal(saved.previous.app.manifest.app.version, "2.0.0");
  assert.equal(v2.state.app.phase, "idle");
  assert.equal(v2.state.rollbackAppVersion, "1.0.0", "the dmg install had no zip, yet the previous version is restorable");
});

test("a version the helper had to swap back is dropped and that exact file is never offered again", async () => {
  const releases = [signed({ app: appRelease("1.0.0", 1) }), signed({ app: appRelease("2.0.0", 2) })];
  const { h, journal } = await harness(releases);
  await installFromV1(h);
  const outcome: DesktopInstallOutcome = { status: "rolled-back", version: "2.0.0", message: "新版本没有启动，已恢复上一版本" };
  const back = new UpdateCoordinator(h.options("1.0.0", { desktopInstallOutcome: async () => outcome }));
  await back.initialize();
  assert.equal(back.state.app.phase, "failed");
  assert.match(back.state.app.message ?? "", /已恢复上一版本/u);
  const saved = await journal();
  assert.equal(saved.pending.app, undefined);
  assert.equal(saved.authorized, false);
  assert.deepEqual(saved.failedApp, { version: "2.0.0", sha256: releases[1]!.manifest.app!.file.sha256 });

  await back.check();
  assert.equal(back.state.app.version, undefined, "the failed file is not offered again");
  await back.prepare("app");
  assert.equal((await journal()).pending.app, undefined);

  releases.push(signed({ app: appRelease("2.0.1", 3) }));
  await back.check();
  assert.equal(back.state.app.version, "2.0.1", "a newer file is");
});

test("a swap that replaced nothing keeps the prepared update for another try", async () => {
  const { h, journal } = await harness([signed({ app: appRelease("2.0.0", 2) })]);
  await installFromV1(h);
  const again = new UpdateCoordinator(h.options("1.0.0", { desktopInstallOutcome: async () => ({ status: "failed", version: "2.0.0", message: "macOS 不允许替换应用" }) }));
  await again.initialize();
  const saved = await journal();
  assert.equal(saved.pending.app.manifest.app.version, "2.0.0");
  assert.equal(saved.authorized, false);
  assert.equal(saved.failedApp, undefined);
  assert.match(again.state.error ?? "", /不允许替换/u);
  assert.deepEqual(await again.apply(), { ok: true });
  assert.equal(h.installs.length, 2);
});

test("a copy that cannot replace itself skips the desktop but still prepares the Runtime", async () => {
  const reason = "OMP Studio 正从 macOS 的隔离位置运行（App Translocation），无法自行更新。";
  const { h, journal } = await harness([signed({ app: appRelease("2.0.0", 2), runtime: release("OMP-Studio-Runtime-18.0.0-studio.9-macos-arm64.zip", "18.0.0-studio.9", 2) })]);
  const coordinator = new UpdateCoordinator(h.options("1.0.0", { preflightDesktop: async () => reason }));
  await coordinator.initialize(); await coordinator.check();
  await coordinator.prepare("all");
  assert.equal(coordinator.state.app.phase, "failed");
  assert.equal(coordinator.state.app.message, reason);
  assert.equal(coordinator.state.runtime.phase, "ready");
  const saved = await journal();
  assert.equal(saved.pending.app, undefined);
  assert.equal(saved.pending.runtime.manifest.runtime.version, "18.0.0-studio.9");
  await assert.rejects(() => coordinator.prepare("app"), { message: reason });
});

test("without trackAppBaselineWithoutBase the installed version is only a baseline when its bytes exist (Windows)", async () => {
  const { h, journal } = await harness([signed({ app: appRelease("1.0.0", 1) }), signed({ app: appRelease("2.0.0", 2) })]);
  const coordinator = new UpdateCoordinator(h.options("1.0.0", { trackAppBaselineWithoutBase: false, desktopCommit: "startup" }));
  await coordinator.initialize(); await coordinator.check();
  assert.equal((await journal()).previous.app, undefined);
});

async function darwinRuntime(parent: string, version: string, protocol: { min: number; max: number } = { min: 1, max: 1 }): Promise<string> {
  const directory = join(parent, version);
  await mkdir(directory, { recursive: true });
  const executable = Buffer.from(`fixture-${version}`);
  const manifest = Buffer.from(JSON.stringify({ runtimeVersion: version, upstreamVersion: "18.0.0", upstreamCommit: "a".repeat(40), patchsetVersion: "studio.1", studioProtocol: protocol, profile: "full-parity-v1", capabilityHash: "fixture", commandManifestHash: "fixture", platform: PLATFORM, entrypoint: "omp", channel: "stable" }));
  const checksums = Buffer.from(JSON.stringify({ algorithm: "sha256", files: { "runtime-manifest.json": hash(manifest), omp: hash(executable) } }));
  const payload = Buffer.concat([manifest, Buffer.from("\0"), checksums]);
  await writeFile(join(directory, "omp"), executable, { mode: 0o755 });
  await writeFile(join(directory, "runtime-manifest.json"), manifest);
  await writeFile(join(directory, "checksums.json"), checksums);
  await writeFile(join(directory, "runtime-signature.json"), JSON.stringify({ algorithm: "ed25519", keyId: "test", payloadSha256: hash(payload), signature: sign(null, payload, pair.privateKey).toString("base64url") }));
  return directory;
}

test("a Runtime prepared with the desktop activates when the new desktop starts, before it is confirmed", async () => {
  const fixtures = await mkdtemp(join(tmpdir(), "omp-update-mac-runtime-"));
  const runtimeRoot = join(fixtures, "installed");
  const installer = new RuntimeInstaller(runtimeRoot, { trustedKeys: keys });
  const selfCheck = { run: async () => {} };
  await installer.install(await darwinRuntime(fixtures, "18.0.0-studio.1"));
  await installer.activate("18.0.0-studio.1", { selfCheck });
  const zip = join(fixtures, "runtime.zip");
  await createRuntimeArchive(await darwinRuntime(fixtures, "18.0.0-studio.2"), zip);
  const asset = "OMP-Studio-Runtime-18.0.0-studio.2-macos-arm64.zip";
  served.set(asset, await readFile(zip));
  const { h } = await harness([signed({ app: appRelease("2.0.0", 2), runtime: release(asset, "18.0.0-studio.2", 2) })], runtimeRoot);

  await installFromV1(h);
  assert.equal((await installer.current())?.runtimeVersion, "18.0.0-studio.1");
  const v2 = new UpdateCoordinator(h.options("2.0.0"));
  await v2.initialize();
  assert.equal((await installer.current())?.runtimeVersion, "18.0.0-studio.2");
  assert.equal(v2.state.app.phase, "verifying");
});

test("after a swap-back, a Runtime the restored desktop cannot talk to is rolled back too", async () => {
  const fixtures = await mkdtemp(join(tmpdir(), "omp-update-mac-protocol-"));
  const runtimeRoot = join(fixtures, "installed");
  const installer = new RuntimeInstaller(runtimeRoot, { trustedKeys: keys });
  const selfCheck = { run: async () => {} };
  const next = STUDIO_PROTOCOL_VERSION + 1;
  await installer.install(await darwinRuntime(fixtures, "18.0.0-studio.1"));
  await installer.activate("18.0.0-studio.1", { selfCheck });
  // The new desktop started, activated its newer-protocol Runtime, then died before it was healthy.
  await installer.install(await darwinRuntime(fixtures, "18.0.0-studio.2", { min: next, max: next }));
  await installer.activate("18.0.0-studio.2", { selfCheck });
  const { root, h } = await harness([], runtimeRoot);
  await writeFile(join(root, "transaction-v2.json"), JSON.stringify({ schema: 2, authorized: false, pending: { app: signed({ app: appRelease("2.0.0", 2) }) }, previous: {}, watermarks: {} }));
  const back = new UpdateCoordinator(h.options("1.0.0", { desktopInstallOutcome: async () => ({ status: "rolled-back", version: "2.0.0", message: "新版本启动后异常退出，已恢复上一版本" }) }));
  await back.initialize();
  assert.equal((await installer.current())?.runtimeVersion, "18.0.0-studio.1");
});
