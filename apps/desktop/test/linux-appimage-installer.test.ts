import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComponentRelease } from "@omp-studio/runtime-installer";
import { LinuxAppImageInstaller } from "../src/linux-appimage-installer.js";
import { macSwapMarkers } from "../src/mac-app-swap.js";

function release(bytes: Buffer): ComponentRelease {
  const file = { asset: "OMP-Studio-2.0.0-linux-x64.AppImage", url: "https://github.com/owner/repo/releases/download/v2/app.AppImage", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("base64") };
  return { version: "2.0.0", sequence: 2, channel: "stable", file, blockmap: { ...file, asset: `${file.asset}.blockmap` }, minAppVersion: "0.0.0", studioProtocol: { min: 1, max: 1 } };
}

test("AppImage update stages verified bytes beside the installed file and starts a swap helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-appimage-update-"));
  const target = join(root, "OMP Studio.AppImage"), archive = join(root, "download"), swapDirectory = join(root, "swap");
  const bytes = Buffer.from("new signed AppImage");
  await writeFile(target, "old AppImage", { mode: 0o755 });
  await writeFile(archive, bytes);
  let args: readonly string[] = [];
  const installer = new LinuxAppImageInstaller({ target, swapDirectory, pid: 123, spawnHelper: async (_helper, value) => { args = value; } });
  await installer.install(archive, release(bytes));
  assert.equal(args[0], "123");
  assert.equal(args[1], target);
  assert.deepEqual(await readFile(args[2]!), bytes);
  assert.equal((await stat(args[2]!)).size, bytes.length);
  assert.equal(await readFile(target, "utf8"), "old AppImage");
  const markers = macSwapMarkers(swapDirectory, { version: "2.0.0", bundlePath: target });
  assert.equal(markers.started(456), true);
  assert.equal(markers.healthy(), true);
});

test("AppImage update refuses a modified downloaded artifact before starting the helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-appimage-invalid-"));
  const target = join(root, "old.AppImage"), archive = join(root, "download");
  await writeFile(target, "old", { mode: 0o755 });
  await writeFile(archive, "modified");
  let started = false;
  const installer = new LinuxAppImageInstaller({ target, swapDirectory: join(root, "swap"), pid: 123, spawnHelper: async () => { started = true; } });
  await assert.rejects(installer.install(archive, release(Buffer.from("expected"))), /checksum mismatch/u);
  assert.equal(started, false);
  assert.equal(await readFile(target, "utf8"), "old");
});

for (const healthy of [true, false]) test(`AppImage helper ${healthy ? "keeps a healthy update" : "restores the old image after startup failure"}`, { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-appimage-swap-"));
  const target = join(root, "OMP Studio.AppImage"), archive = join(root, "download"), swapDirectory = join(root, "swap");
  const old = Buffer.from("#!/bin/sh\nexit 0\n");
  const bytes = Buffer.from(healthy ? "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$OMP_TEST_ARGUMENTS\"\nprintf healthy > \"$OMP_TEST_HEALTH\"\nsleep 1\n" : "#!/bin/sh\nexit 1\n");
  await writeFile(target, old, { mode: 0o755 });
  await writeFile(archive, bytes);
  let done!: Promise<number | null>;
  const installer = new LinuxAppImageInstaller({ target, swapDirectory, pid: 99999999, launchArguments: ["--user-data-dir=a b", "--omp-restarted"], spawnHelper: async (helper, args) => {
    const child = spawn("/bin/sh", [helper, ...args], { env: { ...process.env, OMP_TEST_HEALTH: join(swapDirectory, "healthy"), OMP_TEST_ARGUMENTS: join(root, "arguments") }, stdio: "ignore" });
    done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  } });
  await installer.install(archive, release(bytes));
  await done;
  assert.deepEqual(await readFile(target), healthy ? bytes : old);
  assert.equal((await installer.consumeOutcome())?.status, healthy ? "installed" : "rolled-back");
  if (healthy) assert.equal(await readFile(join(root, "arguments"), "utf8"), "--user-data-dir=a b\n--omp-restarted\n");
});
