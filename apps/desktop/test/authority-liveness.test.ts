import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensurePrivateSocketDirectory } from "@omp-studio/studio-host";

import { createPosixAuthorityLiveness, createWin32AuthorityLiveness } from "../src/authority-liveness.js";
import { darwinUserTempDir } from "../src/platform/desktop-paths.js";

const windowsOnly = { skip: process.platform === "win32" ? false : "named pipes" };
const posixOnly = { skip: process.platform === "win32" ? "unix sockets" : false };

async function posixPair() {
  const directory = await ensurePrivateSocketDirectory(`authority-test-${process.pid}-${Math.random()}`, {
    tmpRoot: await mkdtemp(join(tmpdir(), "omp-auth-")),
  });
  const options = { socketDirectory: async () => directory, probeTimeoutMs: 300 };
  return { directory, first: createPosixAuthorityLiveness(options), second: createPosixAuthorityLiveness(options) };
}

test("Windows proof: one owner at a time, released with its owner", windowsOnly, async () => {
  const key = `test-${process.pid}-${Date.now()}`;
  const first = createWin32AuthorityLiveness(), second = createWin32AuthorityLiveness();
  assert.equal(await first.acquire(key), true);
  assert.equal(await second.isHeld(key), true);
  assert.equal(await second.acquire(key), false);
  await first.release(key);
  assert.equal(await second.isHeld(key), false);
  assert.equal(await second.acquire(key), true);
  await second.release(key);
});

test("POSIX proof: a live owner blocks others and a release frees the address", posixOnly, async () => {
  const { directory, first, second } = await posixPair();
  assert.equal(await first.acquire("desktop"), true);
  assert.equal(await second.isHeld("desktop"), true);
  assert.equal(await second.acquire("desktop"), false);
  await first.release("desktop");
  await assert.rejects(() => lstat(join(directory, "authority-desktop.sock")));
  assert.equal(await second.isHeld("desktop"), false);
  assert.equal(await second.acquire("desktop"), true);
  await second.release("desktop");
});

test("POSIX proof: a socket left by a crashed owner does not block the next start", posixOnly, async () => {
  const { directory, second } = await posixPair();
  const path = join(directory, "authority-desktop.sock");
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.ok((await lstat(path)).isSocket(), "the crash left the socket file behind");
  assert.equal(await second.isHeld("desktop"), false);
  assert.equal(await second.acquire("desktop"), true);
  await second.release("desktop");
});

test("POSIX proof: a foreign file or another user's socket is never removed", posixOnly, async () => {
  const { directory, first } = await posixPair();
  await writeFile(join(directory, "authority-desktop.sock"), "not a socket");
  await assert.rejects(() => first.acquire("desktop"), /not a socket/u);
  assert.equal((await lstat(join(directory, "authority-desktop.sock"))).isFile(), true);

  const other = await posixPair();
  const path = join(other.directory, "authority-desktop.sock");
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const foreign = createPosixAuthorityLiveness({ socketDirectory: async () => other.directory, uid: process.getuid!() + 1 });
  await assert.rejects(() => foreign.acquire("desktop"), /another user/u);
});

test("the macOS temp root comes from getconf and falls back to TMPDIR", () => {
  assert.equal(darwinUserTempDir(() => "/var/folders/zz/abc123/T/\n"), "/var/folders/zz/abc123/T/");
  assert.equal(darwinUserTempDir(() => { throw new Error("no getconf"); }), tmpdir());
  assert.equal(darwinUserTempDir(() => "garbage"), tmpdir());
});
