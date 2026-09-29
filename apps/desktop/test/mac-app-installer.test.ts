import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import type { ComponentRelease } from "@omp-studio/runtime-installer";

import { MAC_APP_ID, MacAppInstaller, macBundlePath, type RunFile } from "../src/mac-app-installer.js";
import { macSwapPaths, type MacSwapPlan } from "../src/mac-app-swap.js";

function machO(cpuType = 0x0100000c): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

const release = { version: "2.0.0" } as ComponentRelease;

async function fixture(info: Record<string, unknown> = {}, options: { cpuType?: number; codesign?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-mac-installer-"));
  const applications = join(root, "Applications");
  const bundlePath = join(applications, "OMP Studio.app");
  await mkdir(join(bundlePath, "Contents", "MacOS"), { recursive: true });
  const zip = join(root, "OMP-Studio-2.0.0-macos-arm64.zip");
  await writeFile(zip, Buffer.alloc(1024));
  const calls: string[] = [];
  const run: RunFile = async (file, args) => {
    calls.push(`${basename(file)} ${args.join(" ")}`);
    if (file === "/usr/bin/ditto") {
      const app = join(args.at(-1)!, "OMP Studio.app");
      await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(app, "Contents", "MacOS", "OMP Studio"), machO(options.cpuType));
      return "";
    }
    if (file === "/usr/bin/codesign" && options.codesign === false) throw new Error("codesign failed: a sealed resource is missing or invalid");
    if (file === "/usr/bin/plutil") {
      return JSON.stringify({ CFBundleIdentifier: "com.ompstudio.desktop", CFBundleShortVersionString: "2.0.0", CFBundleExecutable: "OMP Studio", ...info });
    }
    return "";
  };
  const spawned: { execPath: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const installer = new MacAppInstaller({
    bundlePath,
    swapDirectory: join(root, "updates-v2", "mac-swap"),
    appId: "com.ompstudio.desktop",
    execPath: join(bundlePath, "Contents", "MacOS", "OMP Studio"),
    pid: 4242,
    run,
    spawnHelper: async (execPath, args, env) => { spawned.push({ execPath, args, env }); },
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
  });
  return { root, applications, bundlePath, zip, calls, spawned, installer, swap: macSwapPaths(join(root, "updates-v2", "mac-swap")) };
}

test("the bundle id the updater checks is the one the app is packaged with", async () => {
  const yml = await readFile(new URL("../../../../packaging/electron-builder.yml", import.meta.url), "utf8");
  assert.match(yml, new RegExp(`^appId: ${MAC_APP_ID.replaceAll(".", "\.")}$`, "mu"));
});

test("the bundle path comes from the main executable inside Contents/MacOS", () => {
  assert.equal(macBundlePath("/Applications/OMP Studio.app/Contents/MacOS/OMP Studio"), "/Applications/OMP Studio.app");
  assert.equal(macBundlePath("/usr/local/bin/electron"), undefined);
});

test("preflight refuses App Translocation, an unwritable folder and a full disk", async () => {
  const { installer, bundlePath, root } = await fixture();
  assert.equal(await installer.preflight(), undefined);
  const translocated = new MacAppInstaller({ bundlePath: "/private/var/folders/x/T/AppTranslocation/ABC/d/OMP Studio.app", swapDirectory: root, appId: "a", execPath: "e", pid: 1 });
  assert.match(await translocated.preflight() ?? "", /App Translocation/u);
  const missingParent = new MacAppInstaller({ bundlePath: join(root, "missing", "OMP Studio.app"), swapDirectory: root, appId: "a", execPath: "e", pid: 1 });
  assert.match(await missingParent.preflight() ?? "", /权限/u);
  const full = new MacAppInstaller({ bundlePath, swapDirectory: root, appId: "a", execPath: "e", pid: 1, freeBytes: async () => 10 });
  assert.match(await full.preflight(1_000) ?? "", /空间不足/u);
});

test("install verifies the staged bundle, writes the plan and starts the helper as Node", async () => {
  const { installer, zip, calls, spawned, swap, applications, bundlePath } = await fixture();
  await installer.install(zip, release);
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["ditto", "codesign", "plutil"]);
  assert.ok(calls[0]!.startsWith(`ditto -x -k --noqtn ${zip} `));
  assert.ok(calls[1]!.startsWith("codesign --verify --deep --strict "));

  const plan = JSON.parse(await readFile(swap.plan, "utf8")) as MacSwapPlan;
  assert.equal(plan.target, bundlePath);
  assert.equal(plan.pid, 4242);
  assert.equal(plan.version, "2.0.0");
  assert.equal(dirname(plan.stagingRoot), applications);
  assert.equal(dirname(plan.backup), applications);
  assert.match(basename(plan.stagingRoot), /^\.OMP Studio\.update-/u);
  assert.match(basename(plan.backup), /^\.OMP Studio\.previous-/u);
  assert.equal(plan.staged, join(plan.stagingRoot, "OMP Studio.app"));
  assert.deepEqual(plan.markers, { started: swap.started, healthy: swap.healthy, cleanExit: swap.cleanExit });
  assert.match(await readFile(swap.helper, "utf8"), /runMacAppSwap/u);

  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]!.args, [swap.helper, swap.plan]);
  assert.equal(spawned[0]!.env.ELECTRON_RUN_AS_NODE, "1");
});

for (const [name, info, options, message] of [
  ["another app", { CFBundleIdentifier: "com.example.other" }, {}, /应用标识/u],
  ["another version", { CFBundleShortVersionString: "1.9.9" }, {}, /版本/u],
  ["an Intel executable", {}, { cpuType: 0x01000007 }, /arm64/u],
  ["a broken signature", {}, { codesign: false }, /codesign/u],
] as const) {
  test(`install refuses ${name} and leaves nothing behind`, async () => {
    const { installer, zip, spawned, swap, applications } = await fixture(info, options);
    await assert.rejects(() => installer.install(zip, release), message);
    assert.deepEqual(spawned, []);
    assert.deepEqual((await readdir(applications)).sort(), ["OMP Studio.app"]);
    await assert.rejects(() => readFile(swap.plan, "utf8"), { code: "ENOENT" });
  });
}

test("the helper's outcome is read once, and a malformed one is ignored", async () => {
  const { installer, swap } = await fixture();
  await mkdir(dirname(swap.outcome), { recursive: true });
  await writeFile(swap.outcome, JSON.stringify({ status: "rolled-back", version: "2.0.0", message: "新版本没有启动，已恢复上一版本" }));
  assert.deepEqual(await installer.consumeOutcome(), { status: "rolled-back", version: "2.0.0", message: "新版本没有启动，已恢复上一版本" });
  assert.equal(await installer.consumeOutcome(), undefined);
  await writeFile(swap.outcome, JSON.stringify({ status: "exploded", version: "2.0.0" }));
  assert.equal(await installer.consumeOutcome(), undefined);
});

test("cleanup removes leftover staging and backup folders unless a swap is still running", async () => {
  const { installer, applications, swap } = await fixture();
  for (const name of [".OMP Studio.update-x", ".OMP Studio.previous-y", ".OMP Studio.previous-y.failed", "Other.app"]) await mkdir(join(applications, name), { recursive: true });
  await mkdir(dirname(swap.plan), { recursive: true });
  await writeFile(swap.plan, "{}");
  await installer.cleanup();
  assert.equal((await readdir(applications)).length, 5, "a pending swap keeps its folders");
  await writeFile(swap.plan, "");
  const { rm } = await import("node:fs/promises");
  await rm(swap.plan);
  await installer.cleanup();
  assert.deepEqual((await readdir(applications)).sort(), ["OMP Studio.app", "Other.app"]);
});
