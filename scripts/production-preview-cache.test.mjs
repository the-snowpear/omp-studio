import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  inspectProductionPreviewCache,
  productionPreviewInputs,
  reusableProductionPreviewElectron,
  saveProductionPreviewCache,
} from "./production-preview-cache.mjs";

const runtime = {
  manifest: { runtimeVersion: "18.20.2-studio.9", entrypoint: "omp.exe" },
  checksums: { files: { "omp.exe": "123456789abcdef" } },
  keyId: "release", keys: { release: Buffer.from("public key") },
};
const options = { env: {}, platform: "win32", arch: "x64", nodeVersion: "v24.0.0" };
const electronDirectory = "outputs/production-preview/electrons/electron-test";

async function put(root, path, contents) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function removeFixture(root) {
  const [base, target] = await Promise.all([realpath(tmpdir()), realpath(root)]);
  const location = relative(base, target);
  assert.ok(location && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location) && location.startsWith("omp-preview-"));
  await rm(root, { recursive: true, force: true });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-preview-build-cache-"));
  t.after(() => removeFixture(root));
  for (const [path, contents] of Object.entries({
    "package.json": "{}",
    "package-lock.json": "{}",
    "apps/renderer/src/App.tsx": "original source",
    "apps/renderer/dist/index.html": "built renderer",
    "apps/renderer/dist/assets/entry.js": "built javascript",
    "apps/desktop/src/main.ts": "desktop source",
    "apps/desktop/dist/src/main.js": "built desktop",
    "apps/desktop/dist/preload.cjs": "built preload",
    "apps/desktop/dist/remote-host/host.json": "built remote host",
    "apps/desktop/dist/web-host/host.mjs": "built shared host",
    "apps/renderer/dist/web.html": "built web entry",
    "apps/desktop/dist/ssh-askpass/omp-ssh-askpass.exe": "built askpass",
    "apps/desktop/resources/icon.ico": "icon",
    "packages/client/src/index.ts": "client source",
    "packages/client/dist/index.js": "built client",
    "packages/runtime-installer/dist/artifacts/private-runtime/runtime-manifest.json": "preserve this artifact",
    "node_modules/.package-lock.json": "installed dependencies",
    "node_modules/example/index.js": "dependency",
    "node_modules/electron/dist/electron.exe": "electron source",
    "node_modules/electron-winstaller/vendor/rcedit.exe": "editor",
    [`${electronDirectory}/OMP Studio.exe`]: "staged electron",
    [`${electronDirectory}/runtime/versions/18.20.2-studio.9/omp.exe`]: "staged runtime",
  })) await put(root, path, contents);
  return root;
}

async function save(root) {
  const inputs = await productionPreviewInputs(root, options);
  await saveProductionPreviewCache(root, inputs, runtime, electronDirectory, options);
  return inputs;
}

test("production preview reuses a complete build only while source and dependencies match", async t => {
  const root = await fixture(t);
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, false);
  await save(root);
  const ready = await inspectProductionPreviewCache(root, options);
  assert.equal(ready.hit, true);
  assert.equal(await reusableProductionPreviewElectron(root, ready.record, runtime), join(root, electronDirectory, "OMP Studio.exe"));
  const newRuntime = { ...runtime, checksums: { files: { "omp.exe": "different" } } };
  assert.equal(await reusableProductionPreviewElectron(root, ready.record, newRuntime), undefined);

  await put(root, "apps/renderer/src/NewUntracked.tsx", "new source");
  const changed = await inspectProductionPreviewCache(root, options);
  assert.equal(changed.hit, false);
  assert.equal(await reusableProductionPreviewElectron(root, changed.record, runtime), join(root, electronDirectory, "OMP Studio.exe"));
  await unlink(join(root, "apps/renderer/src/NewUntracked.tsx"));
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, true);
  await put(root, "node_modules/example/index.js", "updated dependency");
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, false);
});

test("changed or missing build outputs trigger a rebuild without touching Runtime artifacts", async t => {
  const root = await fixture(t);
  await save(root);
  const saved = await inspectProductionPreviewCache(root, options);
  assert.equal(saved.hit, true);
  assert.equal(await readFile(join(root, saved.record.snapshot, "apps/renderer/dist/index.html"), "utf8"), "built renderer");
  await assert.rejects(readFile(join(root, saved.record.snapshot, "packages/runtime-installer/dist/artifacts/private-runtime/runtime-manifest.json")), { code: "ENOENT" });
  await put(root, "packages/runtime-installer/dist/artifacts/private-runtime/runtime-manifest.json", "independent runtime changed");
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, true);
  await put(root, "apps/renderer/dist/assets/entry.js", "overwritten by another build");
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, false);
  await put(root, "apps/renderer/dist/assets/entry.js", "built javascript");
  await unlink(join(root, saved.record.snapshot, "apps/renderer/dist/index.html"));
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, false);
  await put(root, `${saved.record.snapshot}/apps/renderer/dist/index.html`, "built renderer");
  await unlink(join(root, electronDirectory, "OMP Studio.exe"));
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, false);
  assert.equal(await readFile(join(root, "packages/runtime-installer/dist/artifacts/private-runtime/runtime-manifest.json"), "utf8"), "independent runtime changed");
});

test("a build invalidated by source changes retains the last successful snapshot", async t => {
  const root = await fixture(t);
  const initial = await save(root);
  const before = await inspectProductionPreviewCache(root, options);
  await put(root, "apps/desktop/src/main.ts", "changed while building");
  await assert.rejects(saveProductionPreviewCache(root, initial, runtime, electronDirectory, options), /changed during the build/);
  const after = await inspectProductionPreviewCache(root, options);
  assert.equal(after.hit, false);
  assert.equal(after.record.snapshot, before.record.snapshot);
  assert.equal(await readFile(join(root, before.record.snapshot, "apps/desktop/dist/src/main.js"), "utf8"), "built desktop");
  assert.equal((await readdir(join(root, "outputs/production-preview/build-snapshots"))).length, 1);
});

test("a later successful build replaces the cache only after preserving its outputs", async t => {
  const root = await fixture(t);
  await save(root);
  const first = await inspectProductionPreviewCache(root, options);
  await put(root, "apps/renderer/src/App.tsx", "new source");
  await put(root, "apps/renderer/dist/index.html", "new renderer");
  await save(root);
  const next = await inspectProductionPreviewCache(root, options);
  assert.equal(next.hit, true);
  assert.notEqual(next.record.snapshot, first.record.snapshot);
  assert.equal(await readFile(join(root, next.record.snapshot, "apps/renderer/dist/index.html"), "utf8"), "new renderer");
  assert.equal((await readdir(join(root, "outputs/production-preview/build-snapshots"))).length, 1);
});

test("build environment and source files in a nested build directory invalidate the cache", async t => {
  const root = await fixture(t);
  await save(root);
  assert.equal((await inspectProductionPreviewCache(root, { ...options, env: { VITE_API_URL: "example" } })).hit, false);
  await put(root, "apps/renderer/src/build/component.ts", "new source in build directory");
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, false);
});

test("accessing an installed native dependency does not force another build", async t => {
  const root = await fixture(t);
  const file = join(root, "node_modules/example/index.js");
  const original = new Date("2026-01-02T00:00:00Z");
  await utimes(file, original, original);
  await save(root);
  // Windows can update ctime along with access time when a native module loads.
  await utimes(file, new Date(), original);
  assert.equal((await inspectProductionPreviewCache(root, options)).hit, true);
});

test("the production launcher builds once, reuses it, and rebuilds when source changes", {
  timeout: 90_000,
  skip: process.platform !== "win32" || !existsSync(join(process.cwd(), "node_modules/electron-winstaller/vendor/rcedit.exe")),
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "omp-preview-launch-cache-"));
  t.after(() => removeFixture(root));
  const repo = process.cwd();
  const npmCli = process.env.OMP_NPM_CLI ?? process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await put(root, "package.json", JSON.stringify({ private: true, scripts: { build: "node fixture-build.cjs" } }));
  await put(root, "package-lock.json", "{}");
  await put(root, "packages/client/src/index.ts", "source");
  await put(root, "apps/renderer/src/App.tsx", "source");
  await put(root, "apps/desktop/package.json", JSON.stringify({ main: "launch.cjs" }));
  await put(root, "apps/desktop/launch.cjs", `require('node:fs').appendFileSync('launch-count.txt','1');`);
  await put(root, "node_modules/electron/package.json", "{}");
  await put(root, "node_modules/.bin/tsc.cmd", "");
  await put(root, "node_modules/.bin/vite.cmd", "");
  await mkdir(join(root, "node_modules/electron/dist"), { recursive: true });
  await mkdir(join(root, "node_modules/electron-winstaller/vendor"), { recursive: true });
  await mkdir(join(root, "apps/desktop/resources"), { recursive: true });
  await copyFile(process.execPath, join(root, "node_modules/electron/dist/electron.exe"));
  await copyFile(join(repo, "node_modules/electron-winstaller/vendor/rcedit.exe"), join(root, "node_modules/electron-winstaller/vendor/rcedit.exe"));
  await copyFile(join(repo, "apps/desktop/resources/icon.ico"), join(root, "apps/desktop/resources/icon.ico"));
  await mkdir(join(root, "scripts"));
  await copyFile(join(repo, "scripts/preview.mjs"), join(root, "scripts/preview.mjs"));
  await copyFile(join(repo, "scripts/production-preview-cache.mjs"), join(root, "scripts/production-preview-cache.mjs"));
  await put(root, "scripts/preload-bundle.mjs", `import {writeFileSync} from 'node:fs'; export function bundlePreload(){writeFileSync('apps/desktop/dist/preload.cjs','preload');}`);
  await put(root, "scripts/production-preview-runtime.mjs", `
import {mkdir,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
export async function prepareProductionPreviewRuntime(){return {directory:join(process.cwd(),'fixture-runtime'),stateDirectory:join(process.cwd(),'fixture-state'),manifest:{runtimeVersion:'1.0.0',entrypoint:'omp.exe'},checksums:{files:{'omp.exe':'1234'}},keyId:'fixture',keys:{fixture:Buffer.from('key')}};}
export async function stageProductionPreviewRuntime(runtime,directory){await mkdir(join(directory,'runtime'),{recursive:true});await writeFile(join(directory,'runtime','marker'),runtime.manifest.runtimeVersion);}
`);
  await put(root, "fixture-build.cjs", `
const fs=require('node:fs');const path=require('node:path');
fs.appendFileSync('build-count.txt','1');
for(const file of ['apps/renderer/dist/index.html','apps/renderer/dist/web.html','apps/desktop/dist/src/main.js','apps/desktop/dist/remote-host/host.json','apps/desktop/dist/web-host/host.mjs','apps/desktop/dist/ssh-askpass/omp-ssh-askpass.exe','packages/client/dist/index.js']){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'built');}
if(process.env.TEST_BUILD_FAIL==='1')process.exit(23);
`);
  const launch = promisify(execFile);
  const env = { ...process.env, APPDATA: "", OMP_PREVIEW_MODE: "production", OMP_PREVIEW_DATA: "", OMP_NPM_CLI: npmCli };
  const start = extra => launch(process.execPath, [join(root, "scripts/preview.mjs")], { cwd: root, env: { ...env, ...extra }, windowsHide: true });

  let started = Date.now();
  const first = await start();
  const firstMs = Date.now() - started;
  assert.match(first.stdout, /Building workspace/);
  const initialRecord = JSON.parse(await readFile(join(root, "outputs/production-preview/build-cache.json"), "utf8"));
  started = Date.now();
  const warm = await start();
  t.diagnostic(`Isolated fixture startup: first ${firstMs} ms, cached ${Date.now() - started} ms (mock Runtime and build).`);
  assert.match(warm.stdout, /reusing the previous production build/);
  assert.equal(await readFile(join(root, "build-count.txt"), "utf8"), "1");
  assert.equal(await readFile(join(root, "launch-count.txt"), "utf8"), "11");

  await put(root, "apps/renderer/src/New.tsx", "new untracked source");
  const changed = await start();
  assert.match(changed.stdout, /Building workspace/);
  assert.equal(await readFile(join(root, "build-count.txt"), "utf8"), "11");
  const updatedRecord = JSON.parse(await readFile(join(root, "outputs/production-preview/build-cache.json"), "utf8"));
  assert.equal(updatedRecord.electronDirectory, initialRecord.electronDirectory, "source-only changes reuse the Electron copy");

  await put(root, "apps/renderer/src/New.tsx", "changed again");
  await assert.rejects(start({ TEST_BUILD_FAIL: "1" }), /exited with 23/);
  const failedRecord = JSON.parse(await readFile(join(root, "outputs/production-preview/build-cache.json"), "utf8"));
  assert.equal(failedRecord.snapshot, updatedRecord.snapshot);
  assert.equal(await readFile(join(root, failedRecord.snapshot, "apps/renderer/dist/index.html"), "utf8"), "built");
});
