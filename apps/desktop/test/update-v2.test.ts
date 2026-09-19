import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { createRuntimeArchive, RuntimeInstaller, updateSigningBytes, type ComponentRelease, type UpdateFile, type UpdateManifest, type SignedUpdateManifest } from "@omp-studio/runtime-installer";
import { downloadDifferentialArtifact, cachedUpdatePath } from "../src/differential-artifact.js";
import { discoverUpdates } from "../src/update-discovery.js";
import { UpdateCoordinator } from "../src/update-coordinator.js";
import { DEFAULT_UPDATE_PREFS } from "../src/update-prefs-store.js";
import { migrateLegacyRuntime } from "../src/migrate-runtime.js";

const pair = generateKeyPairSync("ed25519"), keys = { test: pair.publicKey.export({ type: "spki", format: "pem" }) };
function file(asset: string, bytes: Buffer): UpdateFile { return { asset, url: `https://github.com/owner/repo/releases/download/v2/${asset}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") }; }
const map = gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums: ["checksum"], sizes: [3] }] }));
const binary = Buffer.from("new");
function component(name = "setup.exe", version = "2.0.0"): ComponentRelease { return { version, sequence: 2, channel: "stable", file: file(name, binary), blockmap: file(`${name}.blockmap`, map), minAppVersion: "1.0.0", studioProtocol: { min: 1, max: 1 } }; }
function signed(parts: Partial<Pick<UpdateManifest, "app" | "runtime">>): SignedUpdateManifest {
  const manifest: UpdateManifest = { schema: 2, repo: "owner/repo", platform: "win32-x64", generatedAt: "2026-09-17T00:00:00Z", releaseNotesUrl: "https://github.com/owner/repo/releases/tag/v2", ...parts };
  return { manifest, signature: { algorithm: "ed25519", keyId: "test", value: sign(null, updateSigningBytes(manifest), pair.privateKey).toString("base64url") } };
}
function fetcher(envelopes: SignedUpdateManifest[], counter: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url); counter.push(u);
    if (u.includes("api.github.com")) return new Response(JSON.stringify(envelopes.map((e, i) => ({ assets: [{ name: "updates-win32-x64.json", browser_download_url: `https://github.com/owner/repo/releases/download/v${i}/updates-win32-x64.json` }] }))));
    if (u.endsWith("updates-win32-x64.json")) { const index = Number(/\/v(\d+)\//.exec(u)![1]); return new Response(JSON.stringify(envelopes[index])); }
    const bytes = u.endsWith("blockmap") ? map : binary;
    return new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch;
}
test("differential reconstruction falls back exactly once and never executes unverified bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-diff-test-"));
  const previous = component("old.exe", "1.0.0"), next = component();
  const path = cachedUpdatePath(root, previous.file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, binary);
  const events: string[] = [], requests: string[] = [];
  let attempts = 0;
  const result = await downloadDifferentialArtifact({ root, previous, release: next, mirror: "", signal: new AbortController().signal, fetcher: fetcher([], requests), progress: method => events.push(method), differential: async () => { attempts++; throw new Error("Range unsupported"); } });
  assert.equal(attempts, 1); assert.ok(events.includes("differential")); assert.ok(events.includes("full"));
  assert.deepEqual(await readFile(result), binary);
  assert.equal(requests.filter(u => u.endsWith("setup.exe")).length, 1);
});
test("cancelled differential download never triggers full fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-cancel-diff-")), previous = component("old.exe");
  const path = cachedUpdatePath(root, previous.file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, binary);
  const controller = new AbortController(), requests: string[] = [];
  await assert.rejects(() => downloadDifferentialArtifact({ root, previous, release: component(), mirror: "", signal: controller.signal, fetcher: fetcher([], requests), progress: () => {}, differential: async () => { controller.abort(new Error("cancelled")); throw new Error("cancelled"); } }), /cancelled/);
  assert.equal(requests.filter(u => u.endsWith("setup.exe")).length, 0);
});
test("discovery combines desktop and independent Runtime, rejecting sequence rollback", async () => {
  const app = signed({ app: component() }), runtime = signed({ runtime: component("runtime.zip", "18.0.0-studio.2") });
  const input = { repo: "owner/repo", platform: "win32-x64", channel: "stable" as const, mirror: "", keys, signal: new AbortController().signal, fetcher: fetcher([runtime, app]), watermarks: {} };
  const found = await discoverUpdates(input);
  assert.equal(found.app?.manifest.app?.version, "2.0.0"); assert.equal(found.runtime?.manifest.runtime?.version, "18.0.0-studio.2");
  await assert.rejects(() => discoverUpdates({ ...input, watermarks: { "app:stable:win32-x64": 3 } }), /rollback/);
});
test("discovery routes both the release catalog and manifests through the mirror", async () => {
  const requests: string[] = [];
  const app = signed({ app: component() });
  const mirror = "https://mirror.example.com/";
  const found = await discoverUpdates({ repo: "owner/repo", platform: "win32-x64", channel: "stable", mirror, keys, signal: new AbortController().signal, fetcher: fetcher([app], requests), watermarks: {} });
  assert.equal(found.app?.manifest.app?.version, "2.0.0");
  assert.ok(requests.length > 0);
  assert.ok(requests.every(u => u.startsWith(mirror)), `unmirrored request: ${requests.find(u => !u.startsWith(mirror))}`);
});
test("discovery skips a release whose manifest fails verification and still finds a later valid one", async () => {
  const broken = signed({ app: { ...component("old.exe", "1.5.0"), sequence: 1 } });
  broken.manifest.app!.version = "9.9.9"; // Mutating after signing breaks the signature.
  const valid = signed({ app: { ...component(), sequence: 3 } });
  const found = await discoverUpdates({ repo: "owner/repo", platform: "win32-x64", channel: "stable", mirror: "", keys, signal: new AbortController().signal, fetcher: fetcher([broken, valid]), watermarks: {} });
  assert.equal(found.app?.manifest.app?.version, "2.0.0");
  assert.equal(found.app?.manifest.app?.sequence, 3);
});
test("discovery still rejects conflicting signed sequences for one component", async () => {
  const first = signed({ app: { ...component(), sequence: 2 } });
  const conflicting = signed({ app: { ...component(), version: "2.1.0", sequence: 2 } });
  await assert.rejects(() => discoverUpdates({ repo: "owner/repo", platform: "win32-x64", channel: "stable", mirror: "", keys, signal: new AbortController().signal, fetcher: fetcher([first, conflicting]), watermarks: {} }), /Conflicting signed update sequence/);
});
test("prepared updates survive restart; busy sessions and tampered cache prevent apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-update-journal-"));
  let busy = false, shutdowns = 0, installs = 0;
  const options = { root, runtimeRoot: join(root, "runtimes"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => busy, beforeQuit: async () => { shutdowns++; }, installDesktop: async () => { installs++; }, restart: () => {}, quit: () => {}, fetcher: fetcher([signed({ app: component() })]) };
  const first = new UpdateCoordinator(options); await first.initialize(); await first.check(); await first.prepare("app");
  assert.equal(first.state.app.phase, "ready");
  const second = new UpdateCoordinator(options); await second.initialize(); assert.equal(second.state.app.phase, "ready");
  busy = true; assert.equal((await second.apply()).deferred, true); assert.equal(shutdowns, 0);
  busy = false;
  await writeFile(cachedUpdatePath(join(root, "cache"), component().file), "bad");
  assert.equal((await second.apply()).ok, false); assert.equal(installs, 0); assert.equal(shutdowns, 0);
});
test("apply re-verifies the desktop artifact after shutdown and never launches a tampered installer", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-update-tampered-quit-"));
  let installs = 0, quits = 0, restarts = 0;
  const options = { root, runtimeRoot: join(root, "runtimes"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false,
    beforeQuit: async () => { await writeFile(cachedUpdatePath(join(root, "cache"), component().file), "tampered"); },
    installDesktop: async () => { installs++; }, restart: () => { restarts++; }, quit: () => { quits++; }, fetcher: fetcher([signed({ app: component() })]) };
  const coordinator = new UpdateCoordinator(options);
  await coordinator.initialize(); await coordinator.check(); await coordinator.prepare("app");
  assert.equal(coordinator.state.app.phase, "ready");
  assert.equal((await coordinator.apply()).ok, false);
  assert.equal(installs, 0); assert.equal(quits, 0);
  assert.equal(restarts, 1); // The stopped Host is brought back instead of quitting.
  assert.equal(JSON.parse(await readFile(join(root, "transaction-v2.json"), "utf8")).authorized, false);
});
test("downloading and ordinary startup never authorize applying an update", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-no-auto-apply-")); let installs = 0;
  const options = { root, runtimeRoot: join(root, "runtimes"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {}, installDesktop: async () => { installs++; }, restart: () => {}, quit: () => {}, fetcher: fetcher([signed({ app: component() })]) };
  const first = new UpdateCoordinator(options); await first.initialize(); await first.prepare("all");
  const second = new UpdateCoordinator(options); await second.initialize(); assert.equal(installs, 0);
  assert.equal((await second.apply()).ok, true); assert.equal(installs, 1);
});
test("a failed desktop installation surfaces the incomplete transaction and keeps the pending Runtime prepared", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-incomplete-transaction-"));
  const journal = { schema: 2, authorized: true,
    pending: { app: signed({ app: component() }), runtime: signed({ runtime: component("runtime.zip", "18.0.0-studio.2") }) },
    previous: {}, watermarks: {} };
  await writeFile(join(root, "transaction-v2.json"), JSON.stringify(journal));
  const options = { root, runtimeRoot: join(root, "runtimes"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {}, installDesktop: async () => {}, restart: () => {}, quit: () => {}, fetcher: fetcher([]) };
  const coordinator = new UpdateCoordinator(options);
  await coordinator.initialize();
  assert.match(coordinator.state.error ?? "", /事务不完整/);
  const saved = JSON.parse(await readFile(join(root, "transaction-v2.json"), "utf8"));
  assert.equal(saved.authorized, false);
  assert.equal(saved.pending.runtime.manifest.runtime.version, "18.0.0-studio.2");
  assert.equal(coordinator.state.runtime.phase, "ready");
});

async function runtimeFixture(root: string, version: string): Promise<string> {
  const directory = join(root, version); await mkdir(directory, { recursive: true });
  const executable = Buffer.from(`fixture-${version}`);
  const manifest = Buffer.from(JSON.stringify({ runtimeVersion: version, upstreamVersion: "18.0.0", upstreamCommit: "a".repeat(40), patchsetVersion: "studio.1", studioProtocol: { min: 1, max: 1 }, profile: "full-parity-v1", capabilityHash: "fixture", commandManifestHash: "fixture", platform: "win32-x64", entrypoint: "omp.exe", channel: "stable" }));
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const checksums = Buffer.from(JSON.stringify({ algorithm: "sha256", files: { "runtime-manifest.json": hash(manifest), "omp.exe": hash(executable) } }));
  const payload = Buffer.concat([manifest, Buffer.from("\0"), checksums]);
  for (const [name, bytes] of [["omp.exe", executable], ["runtime-manifest.json", manifest], ["checksums.json", checksums], ["runtime-signature.json", Buffer.from(JSON.stringify({ algorithm: "ed25519", keyId: "test", payloadSha256: hash(payload), signature: sign(null, payload, pair.privateKey).toString("base64url") }))]] as const) await writeFile(join(directory, name), bytes);
  return directory;
}
test("authorized Runtime activates after restart and failed session startup restores the verified previous Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-transaction-")), runtimeRoot = join(root, "installed");
  const installer = new RuntimeInstaller(runtimeRoot, { trustedKeys: keys });
  const selfCheck = { run: async () => {} };
  await installer.install(await runtimeFixture(root, "18.0.0-studio.1"));
  await installer.activate("18.0.0-studio.1", { selfCheck });
  const newDirectory = await runtimeFixture(root, "18.0.0-studio.2"), zipPath = join(root, "runtime.zip");
  await createRuntimeArchive(newDirectory, zipPath);
  const bytes = await readFile(zipPath), release = { ...component("runtime.zip", "18.0.0-studio.2"), file: file("runtime.zip", bytes) };
  const envelope = signed({ runtime: release });
  const source = fetcher([envelope]);
  const runtimeFetch = (async (...args: Parameters<typeof fetch>) => String(args[0]).endsWith("runtime.zip") ? new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }) : source(...args)) as typeof fetch;
  const options = { root: join(root, "updates"), runtimeRoot, repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {}, installDesktop: async () => {}, restart: () => {}, quit: () => {}, fetcher: runtimeFetch, activateOptions: { selfCheck } };
  const first = new UpdateCoordinator(options); await first.initialize(); await first.prepare("runtime");
  assert.equal((await installer.current())?.runtimeVersion, "18.0.0-studio.1");
  assert.equal((await first.apply()).ok, true);
  const second = new UpdateCoordinator(options); await second.initialize();
  assert.equal((await installer.current())?.runtimeVersion, "18.0.0-studio.2");
  assert.equal(await second.completeStartup(false, true), true);
  assert.equal((await installer.current())?.runtimeVersion, "18.0.0-studio.1");
  assert.equal(second.state.runtime.phase, "failed");
});
test("migration copies only a verified Runtime and preserves a newer per-user installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-migration-"));
  const legacyInstallRoot = join(root, "machine"), userRuntimeRoot = join(root, "user");
  const old = new RuntimeInstaller(join(legacyInstallRoot, "runtime"), { trustedKeys: keys }), target = new RuntimeInstaller(userRuntimeRoot, { trustedKeys: keys });
  const activateOptions = { selfCheck: { run: async () => {} } };
  await old.install(await runtimeFixture(root, "18.0.0-studio.1")); await old.activate("18.0.0-studio.1", activateOptions);
  await migrateLegacyRuntime({ legacyInstallRoot, userRuntimeRoot, trustedKeys: keys, activateOptions });
  assert.equal((await target.current())?.runtimeVersion, "18.0.0-studio.1");
  await target.install(await runtimeFixture(root, "18.0.0-studio.2")); await target.activate("18.0.0-studio.2", activateOptions);
  await migrateLegacyRuntime({ legacyInstallRoot, userRuntimeRoot, trustedKeys: keys, activateOptions });
  assert.equal((await target.current())?.runtimeVersion, "18.0.0-studio.2");
  await writeFile(join(legacyInstallRoot, "runtime", "versions", "18.0.0-studio.1", "omp.exe"), "tampered");
  await assert.rejects(() => migrateLegacyRuntime({ legacyInstallRoot, userRuntimeRoot, trustedKeys: keys, activateOptions }), /Checksum/);
});

for (const checkpoint of ["before-activate", "after-activate", "after-journal-save"] as const) {
  test(`Runtime rollback survives a process exit ${checkpoint}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-runtime-checkpoint-")), runtimeRoot = join(root, "installed");
    const installer = new RuntimeInstaller(runtimeRoot, { trustedKeys: keys });
    const selfCheck = { run: async () => {} };
    const oldVersion = "18.0.0-studio.1", version = "18.0.0-studio.2";
    await installer.install(await runtimeFixture(root, oldVersion)); await installer.activate(oldVersion, { selfCheck });
    const next = await runtimeFixture(root, version), archive = join(root, "runtime.zip");
    await createRuntimeArchive(next, archive);
    const bytes = await readFile(archive), release = { ...component("runtime.zip", version), file: file("runtime.zip", bytes) };
    const source = fetcher([signed({ runtime: release })]);
    const runtimeFetch = (async (...args: Parameters<typeof fetch>) => String(args[0]).endsWith("runtime.zip") ? new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }) : source(...args)) as typeof fetch;
    const options = { root: join(root, "updates"), runtimeRoot, repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {}, installDesktop: async () => {}, restart: () => {}, quit: () => {}, fetcher: runtimeFetch, activateOptions: { selfCheck } };
    const first = new UpdateCoordinator(options); await first.initialize(); await first.prepare("runtime"); await first.apply();
    const path = join(options.root, "transaction-v2.json");
    if (checkpoint === "after-journal-save") {
      await new UpdateCoordinator(options).initialize();
    } else {
      const journal = JSON.parse(await readFile(path, "utf8"));
      journal.runtimeTrial = { version, previousVersion: oldVersion };
      await writeFile(path, JSON.stringify(journal));
      await installer.install(next);
      if (checkpoint === "after-activate") await installer.activate(version, { selfCheck });
    }
    const resumed = new UpdateCoordinator(options); await resumed.initialize();
    assert.equal(JSON.parse(await readFile(path, "utf8")).runtimeTrial.previousVersion, oldVersion);
    assert.equal(await resumed.completeStartup(false, true), true);
    assert.equal((await installer.current())?.runtimeVersion, oldVersion);
  });
}

test("a legacy journal carrying the removed trial attempts counter still rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-legacy-trial-")), runtimeRoot = join(root, "installed");
  const installer = new RuntimeInstaller(runtimeRoot, { trustedKeys: keys });
  const selfCheck = { run: async () => {} };
  const oldVersion = "18.0.0-studio.1", version = "18.0.0-studio.2";
  await installer.install(await runtimeFixture(root, oldVersion)); await installer.activate(oldVersion, { selfCheck });
  const updates = join(root, "updates"); await mkdir(updates, { recursive: true });
  const path = join(updates, "transaction-v2.json");
  await writeFile(path, JSON.stringify({
    schema: 2, authorized: false, pending: {}, previous: {}, watermarks: {},
    runtimeTrial: { version, previousVersion: oldVersion, attempts: 0 },
  }));
  const options = { root: updates, runtimeRoot, repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {}, installDesktop: async () => {}, restart: () => {}, quit: () => {}, fetcher: fetcher([]), activateOptions: { selfCheck } };
  const coordinator = new UpdateCoordinator(options); await coordinator.initialize();
  assert.equal(coordinator.hasRuntimeTrial, true);
  assert.equal(coordinator.state.error, undefined);
  assert.equal(JSON.parse(await readFile(path, "utf8")).runtimeTrial.attempts, undefined);
  await installer.install(await runtimeFixture(root, version)); await installer.activate(version, { selfCheck });
  assert.equal(await coordinator.completeStartup(false, true), true);
  assert.equal((await installer.current())?.runtimeVersion, oldVersion);
});

for (const target of ["app", "all"] as const) {
  test(`apply rejects an incompatible pair after preparing ${target} over a pending Runtime`, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-final-compat-"));
    const runtime = component("runtime.zip", "18.0.0-studio.2");
    const catalogs = [signed({ runtime })];
    let stopped = 0, installed = 0;
    const options = { root, runtimeRoot: join(root, "runtime"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => { stopped++; }, installDesktop: async () => { installed++; }, restart: () => {}, quit: () => {}, fetcher: fetcher(catalogs) };
    const coordinator = new UpdateCoordinator(options); await coordinator.initialize(); await coordinator.prepare("runtime");
    catalogs.unshift(signed({ app: { ...component(), studioProtocol: { min: 2, max: 2 } } }));
    await coordinator.check();
    if (target === "all") await assert.rejects(() => coordinator.prepare(target), /兼容/);
    else await coordinator.prepare(target);
    const resumed = new UpdateCoordinator(options); await resumed.initialize();
    assert.equal((await resumed.apply()).ok, false);
    assert.equal(stopped, 0); assert.equal(installed, 0);
    assert.equal(JSON.parse(await readFile(join(root, "transaction-v2.json"), "utf8")).authorized, false);
  });
}

test("a prepared desktop rollback survives restart and cannot be overwritten by update preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-desktop-rollback-"));
  const old = signed({ app: { ...component("old.exe", "1.0.0"), sequence: 1 } });
  const initialInstallerPath = join(root, "installer.exe"); await writeFile(initialInstallerPath, binary);
  let installs = 0;
  const options = { root, initialInstallerPath, runtimeRoot: join(root, "runtime"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => {}, installDesktop: async () => { installs++; }, restart: () => {}, quit: () => {}, fetcher: fetcher([signed({ app: component() }), old]) };
  const first = new UpdateCoordinator(options); await first.initialize(); await first.prepare("app"); await first.apply();
  const upgraded = new UpdateCoordinator({ ...options, appVersion: "2.0.0" }); await upgraded.initialize();
  assert.equal(upgraded.state.rollbackAppVersion, "1.0.0");
  assert.equal((await upgraded.rollbackDesktop()).ok, true);
  assert.equal(installs, 1); // Preparing rollback never installs it.
  const resumed = new UpdateCoordinator({ ...options, appVersion: "2.0.0" }); await resumed.initialize();
  assert.equal(resumed.state.rollbackAppPending, true);
  assert.equal(resumed.state.app.version, "1.0.0");
  await resumed.check();
  await assert.rejects(() => resumed.prepare("all"), /回滚已准备/);
  assert.equal((await resumed.apply()).ok, true); assert.equal(installs, 2);
  const restored = new UpdateCoordinator(options); await restored.initialize();
  assert.equal(restored.state.rollbackAppPending, false);
});

test("apply rechecks a pending Runtime minimum desktop version after an external desktop change", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-min-app-"));
  let stopped = 0;
  const options = { root, runtimeRoot: join(root, "runtime"), repo: "owner/repo", platform: "win32-x64", appVersion: "1.0.0", keys, prefs: { read: async () => DEFAULT_UPDATE_PREFS }, snapshotChanged: () => {}, isBusy: () => false, beforeQuit: async () => { stopped++; }, installDesktop: async () => {}, restart: () => {}, quit: () => {}, fetcher: fetcher([signed({ runtime: component("runtime.zip", "18.0.0-studio.2") })]) };
  const first = new UpdateCoordinator(options); await first.initialize(); await first.prepare("runtime");
  const downgraded = new UpdateCoordinator({ ...options, appVersion: "0.9.0" }); await downgraded.initialize();
  assert.equal((await downgraded.apply()).ok, false);
  assert.equal(stopped, 0);
});
