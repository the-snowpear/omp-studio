import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { RemotePeer, REMOTE_PROTOCOL_VERSION } from "../src/remote/wire.js";
import { SshRemoteTransport } from "../src/remote/transport.js";

function fixture(timeout = 30_000) {
  const a = new PassThrough(); const b = new PassThrough();
  const peer = new RemotePeer(a, b, timeout); const server = new RemotePeer(b, a);
  const transport = new SshRemoteTransport(peer);
  return { peer, server, transport };
}

test("one missed heartbeat pauses writes but a response recovers without killing the transport", async () => {
  const f = fixture();
  let checks = 0;
  const health: boolean[] = [];
  f.server.handle(async () => ++checks === 1 ? new Promise(() => {}) : {});
  const recovered = new Promise<void>(resolve => f.transport.onHealth(value => { health.push(value); if (value) resolve(); }));
  f.transport.startHealthChecks({ intervalMs: 5, timeoutMs: 15, missedChecks: 2 });
  const guard = setTimeout(() => { f.peer.close(new Error("health test timeout")); }, 1_000);
  try { await recovered; assert.deepEqual(health, [false, true]); await f.peer.request("ping"); }
  finally { clearTimeout(guard); await f.transport.close(); f.server.close(); }
});

test("a stalled Host closes only its control channel after bounded missed checks", async () => {
  const f = fixture();
  f.server.handle(async () => new Promise(() => {}));
  let checks = 0;
  f.transport.onHealth(() => { checks++; });
  const stopped = new Promise<Error>(resolve => f.transport.onDisconnect(resolve));
  f.transport.startHealthChecks({ intervalMs: 5, timeoutMs: 15, missedChecks: 2 });
  const guard = setTimeout(() => f.peer.close(new Error("health test timeout")), 1_000);
  try { assert.match((await stopped).message, /连续未响应/); assert.equal(checks, 1); }
  finally { clearTimeout(guard); await f.transport.close(); f.server.close(); }
});

test("a timed-out mutation probes health without retrying that mutation", async () => {
  const f = fixture(15);
  let writes = 0; let pings = 0;
  f.server.handle(async method => { if (method === "command") { writes++; return new Promise(() => {}); } pings++; return {}; });
  f.transport.startHealthChecks({ intervalMs: 1_000, timeoutMs: 15, missedChecks: 2 });
  try {
    await assert.rejects(f.peer.request("command", {}), /not retried/);
    await delay(5);
    assert.equal(writes, 1); assert.equal(pings, 1);
    await f.peer.request("ping");
  } finally { await f.transport.close(); f.server.close(); }
});

function childProcessFixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: (_signal?: string) => true });
  child.kill = () => { setImmediate(() => { child.exitCode = 1; child.emit("close", 1); }); return true; };
  return child;
}

test("password handshake errors preserve the safe SSH reason even when stderr arrives after EOF", async () => {
  const child = childProcessFixture();
  const spawnProcess = (() => { setImmediate(() => { child.stdout.end(); setImmediate(() => { child.stderr.write("Permission denied (password).\n"); child.stderr.end(); child.exitCode = 255; child.emit("close", 255); }); }); return child; }) as unknown as typeof spawn;
  await assert.rejects(SshRemoteTransport.connect({ connection: { host: "example.invalid", user: "test", authMode: "password" }, authentication: { request: () => ({ env: {}, dispose: () => {} }), close: async () => {} }, shell: "posix", executable: "node", args: [], expectedPlatform: "linux", spawnProcess, sshExecutable: "ssh" }), /认证被拒绝/);
});

test("closing a connected transport waits for its SSH child to exit", async () => {
  const child = childProcessFixture();
  const server = new RemotePeer(child.stdin, child.stdout);
  server.handle(async () => ({ protocolVersion: REMOTE_PROTOCOL_VERSION, platform: "linux", arch: "x64", bundleVersion: "bundle", instanceId: "host" }));
  let released = false;
  child.kill = () => { setTimeout(() => { released = true; child.exitCode = 0; child.emit("close", 0); }, 15); return true; };
  const transport = await SshRemoteTransport.connect({ connection: { host: "example.invalid" }, shell: "posix", executable: "node", args: [], expectedPlatform: "linux", spawnProcess: (() => child) as unknown as typeof spawn, sshExecutable: "ssh" });
  await transport.close(); assert.equal(released, true); server.close();
});
