import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  createBridgeBootstrap,
  ensurePrivateSocketDirectory,
  liveAudioSocketName,
  privateSocketDirectoryPath,
  privateSocketPath,
  randomSocketName,
  socketPathFits,
  sweepStaleSockets,
} from "../src/index.js";

const posixOnly = { skip: process.platform === "win32" ? "unix sockets and POSIX modes only" : false };
// macOS $TMPDIR (/var/folders/.../T/) plus a mkdtemp segment already exceeds the
// socket budget and would take the /tmp fallback; Desktop's real root is shorter.
const shortRoot = () => mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "osr-"));

test("socket directory names are short, deterministic per scope and names are opaque", () => {
  const root = join(tmpdir(), "root");
  assert.equal(privateSocketDirectoryPath("profile:a", root), privateSocketDirectoryPath("profile:a", root));
  assert.notEqual(privateSocketDirectoryPath("profile:a", root), privateSocketDirectoryPath("profile:b", root));
  assert.match(privateSocketDirectoryPath("probe", root), /omp-[a-f0-9]{10}$/u);
  assert.match(randomSocketName("b"), /^b-[a-f0-9]{16}\.sock$/u);
  assert.notEqual(randomSocketName("p"), randomSocketName("p"));
});

test("live-audio socket names are short and match the Runtime overlay's vector", () => {
  // The same vector is asserted in the overlay's studio-live-audio.test.ts.
  assert.equal(liveAudioSocketName("00000000-0000-4000-8000-000000000000"), "a-db8055e0e0307d5a.sock");
  const darwinUserTemp = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";
  assert.equal(socketPathFits(`${privateSocketDirectoryPath("profile:x", darwinUserTemp)}/${liveAudioSocketName("f".repeat(36))}`), true);
});

test("the socket byte budget counts UTF-8 bytes, not characters", () => {
  const ascii = `/${"a".repeat(MAX_UNIX_SOCKET_PATH_BYTES - 1)}`;
  assert.equal(socketPathFits(ascii), true);
  assert.equal(socketPathFits(`${ascii}a`), false);
  // A CJK username costs three bytes per character.
  assert.equal(socketPathFits(`/Users/${"张".repeat(33)}/s`), false);
  assert.throws(() => privateSocketPath(join(tmpdir(), "x".repeat(MAX_UNIX_SOCKET_PATH_BYTES)), "b.sock"), /the limit is 103/u);
});

test("a POSIX Bridge socket moves to the short directory while the token stays private", async () => {
  const privateDirectory = await mkdtemp(join(tmpdir(), "omp-studio-bridge-short-"));
  const socketDirectory = await mkdtemp(join(tmpdir(), "omp-s-"));
  const bootstrap = await createBridgeBootstrap(privateDirectory, "darwin", undefined, { socketDirectory });
  assert.ok(bootstrap.endpoint.startsWith(socketDirectory));
  assert.match(bootstrap.endpoint, /b-[a-f0-9]{16}\.sock$/u);
  assert.ok(bootstrap.tokenFile.startsWith(privateDirectory));
  assert.equal(await readFile(bootstrap.tokenFile, "utf8"), bootstrap.token);
});

test("an over-long POSIX Bridge path fails with a clear error instead of EINVAL", async () => {
  const deep = join(await mkdtemp(join(tmpdir(), "omp-studio-bridge-long-")), "x".repeat(96));
  await assert.rejects(() => createBridgeBootstrap(deep, "darwin"), /Unix socket path is \d+ bytes/u);
});

test("Windows Bridge bootstrap ignores the socket directory and keeps its named pipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-bridge-pipe-"));
  const bootstrap = await createBridgeBootstrap(directory, "win32", {
    secureDirectory: async () => {},
    createSecureTokenFile: async (path, token) => writeFile(path, token, { encoding: "utf8", flag: "wx" }),
  }, { socketDirectory: join(directory, "unused") });
  assert.match(bootstrap.endpoint, /^\\\\\.\\pipe\\omp-studio-[a-f0-9]{36}$/u);
});

test("private socket directories need a POSIX uid", { skip: process.platform === "win32" ? false : "Windows-only guard" }, async () => {
  await assert.rejects(() => ensurePrivateSocketDirectory("probe"), /POSIX-only/u);
});

test("private socket directory is created 0700 and re-validated idempotently", posixOnly, async () => {
  const tmpRoot = await shortRoot();
  const directory = await ensurePrivateSocketDirectory("scope-a", { tmpRoot });
  assert.equal(directory, privateSocketDirectoryPath("scope-a", tmpRoot));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(await ensurePrivateSocketDirectory("scope-a", { tmpRoot }), directory);
});

test("a symlinked, shared or foreign socket directory fails closed", posixOnly, async () => {
  const tmpRoot = await shortRoot();
  const elsewhere = await mkdtemp(join(tmpdir(), "omp-sock-elsewhere-"));
  await symlink(elsewhere, privateSocketDirectoryPath("linked", tmpRoot));
  await assert.rejects(() => ensurePrivateSocketDirectory("linked", { tmpRoot }), /not a real directory/u);
  await mkdir(privateSocketDirectoryPath("shared", tmpRoot));
  await chmod(privateSocketDirectoryPath("shared", tmpRoot), 0o755);
  await assert.rejects(() => ensurePrivateSocketDirectory("shared", { tmpRoot }), /accessible to other users/u);
  await assert.rejects(() => ensurePrivateSocketDirectory("foreign", { tmpRoot, uid: process.getuid!() + 1 }), /owned by another user/u);
});

test("an over-long temp root falls back to a per-user directory under /tmp", posixOnly, async () => {
  const tmpRoot = join(tmpdir(), "y".repeat(MAX_UNIX_SOCKET_PATH_BYTES));
  const directory = await ensurePrivateSocketDirectory("fallback-scope", { tmpRoot });
  try {
    assert.match(directory, new RegExp(`^/tmp/omp-${process.getuid!()}-[a-f0-9]{10}$`, "u"));
    assert.ok(socketPathFits(join(directory, randomSocketName("b"))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sweep removes sockets left by a killed listener and keeps live ones", posixOnly, async () => {
  const directory = await ensurePrivateSocketDirectory("sweep", { tmpRoot: await shortRoot() });
  const live = privateSocketPath(directory, randomSocketName("b"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(live, resolve));
  const stale = privateSocketPath(directory, randomSocketName("b"));
  // libuv unlinks on a graceful close, so only a SIGKILLed owner leaves a file behind.
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(stale)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await writeFile(join(directory, "note.sock.txt"), "not a socket");
  try {
    assert.equal(await sweepStaleSockets(directory), 1);
    await assert.rejects(() => lstat(stale));
    assert.ok((await lstat(live)).isSocket());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
