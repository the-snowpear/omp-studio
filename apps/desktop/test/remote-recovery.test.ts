import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ClientBootstrap } from "@omp-studio/client-contract";
import { RemoteConnectionManager, type RemoteRecoveryPolicy } from "../src/remote/manager.js";
import { RemoteConnectionError, connectionCancelled, sshFailure } from "../src/remote/errors.js";
import { RemotePeer, REMOTE_PROTOCOL_VERSION, type RemoteAttachment } from "../src/remote/wire.js";
import { SshRemoteTransport } from "../src/remote/transport.js";
import type { RemoteConnectionStatus } from "../src/remote/shared.js";
import type { RemoteEnvironment } from "../src/remote/deploy.js";

const snapshot = { contractVersion: 2, authority: { authorityId: "remote-test", authorityEpoch: 1 }, runtime: { status: "unavailable", classification: "unavailable" }, selected: { workspaceId: "workspace" } } as unknown as ClientBootstrap;
const network = () => new RemoteConnectionError("network", "injected network loss");
function channel(instanceId = "original-host") {
  const toServer = new PassThrough(); const toClient = new PassThrough();
  const peer = new RemotePeer(toClient, toServer);
  const server = new RemotePeer(toServer, toClient);
  const writes: unknown[] = [];
  server.handle(async (method, input) => {
    if (method === "bootstrap") return snapshot;
    if (method === "command") { writes.push(input); return new Promise(() => {}); }
    return {};
  });
  const transport = new SshRemoteTransport(peer);
  transport.hello = { protocolVersion: REMOTE_PROTOCOL_VERSION, platform: "linux", arch: "x64", bundleVersion: "bundle", instanceId };
  return { transport, server, writes };
}
async function fixture(t: TestContext, overrides: Partial<RemoteRecoveryPolicy> = {}, password = false) {
  const root = await mkdtemp(join(tmpdir(), "omp-recovery-"));
  const channels: ReturnType<typeof channel>[] = [];
  const attachments: RemoteAttachment[] = [];
  const calls = { probe: 0, deploy: 0, attach: 0, authentication: 0, clearAuthentication: 0 };
  let attach = async (_signal?: AbortSignal) => { const next = channel(); channels.push(next); return next.transport; };
  let probe = async () => ({ platform: "linux", arch: "x64", home: "/home/test", node: "/bin/node", version: "22", root: "/home/test/remote" }) as RemoteEnvironment;
  const services = {
    probeRemote: async () => { calls.probe++; return probe(); },
    deployRemote: async () => { calls.deploy++; return { entry: "/home/test/remote/host.mjs", state: "/home/test/remote/state", bundleVersion: "bundle" }; },
    attachRemote: async (_profile: unknown, _environment: unknown, _installation: unknown, signal?: AbortSignal, _authentication?: unknown, attachment?: RemoteAttachment) => {
      calls.attach++; if (attachment) attachments.push(attachment); return attach(signal);
    },
    createPasswordAuthentication: async () => { calls.authentication++; return { request: () => ({ env: {}, dispose: () => {} }), close: async () => { calls.clearAuthentication++; } }; },
  };
  const policy = { maxAttempts: 3, budgetMs: 2_000, delaysMs: [2], stableMs: 60_000, random: () => 0.5, ...overrides };
  const manager = new RemoteConnectionManager(join(root, "profiles.json"), root, services, root, policy);
  const profile = await manager.save({ name: "Recovery test", host: "example.invalid", platform: "linux", ...(password ? { authMode: "password", user: "test" } : {}) });
  t.after(async () => { await manager.close(); for (const c of channels) c.server.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, profile, calls, channels, attachments, setAttach: (fn: typeof attach) => { attach = fn; }, setProbe: (fn: typeof probe) => { probe = fn; }, connect: () => manager.connect(profile.id, password ? { password: "test-only" } : undefined) };
}
function status(manager: RemoteConnectionManager, id: string, accept: (value: RemoteConnectionStatus) => boolean): Promise<RemoteConnectionStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Timed out waiting for connection state")); }, 3_000);
    const check = () => { void manager.list().then(inventory => { const value = inventory.statuses.find(row => row.id === id); if (value && accept(value)) { clearTimeout(timer); off(); resolve(value); } }); };
    const off = manager.onChanged(check);
    check();
  });
}

test("a dropped mutation is never replayed and recovery only attaches the original Host", async t => {
  const f = await fixture(t);
  await f.connect(); f.manager.select(f.profile.id);
  const first = f.channels[0]!;
  const generation = f.manager.get(f.profile.id).generation;
  const request = first.transport.peer.request("command", { commandName: "git.execute" });
  const rejected = assert.rejects(request, /network loss/);
  await delay(0);
  let failures = 1;
  f.setAttach(async () => {
    if (failures-- > 0) throw network();
    const next = channel(); f.channels.push(next); return next.transport;
  });
  first.transport.peer.close(network());
  assert.throws(() => f.manager.get(f.profile.id), /正在恢复/);
  await rejected;
  await status(f.manager, f.profile.id, row => row.state === "connected" && row.generation! > generation);
  assert.equal(f.manager.activeId, f.profile.id);
  assert.equal(f.calls.probe, 1); assert.equal(f.calls.deploy, 1); assert.equal(f.calls.attach, 3);
  assert.equal(first.writes.length, 1); assert.equal(f.channels[1]!.writes.length, 0);
  assert.equal(f.attachments[0]!.key, f.attachments[2]!.key);
  assert.deepEqual(f.attachments.map(value => value.sequence), [1, 2, 3]);
});

test("brief successful reconnects do not reset a flapping connection's attempt budget", async t => {
  const f = await fixture(t, { maxAttempts: 2 });
  await f.connect();
  for (let index = 0; index < 2; index++) {
    const generation = f.manager.get(f.profile.id).generation;
    f.manager.get(f.profile.id).transport.peer.close(network());
    await status(f.manager, f.profile.id, row => row.state === "connected" && row.generation! > generation);
  }
  f.manager.get(f.profile.id).transport.peer.close(network());
  const failed = await status(f.manager, f.profile.id, row => row.state === "failed");
  assert.match(failed.message!, /自动恢复已停止/);
  assert.equal(f.calls.attach, 3); assert.equal(f.calls.deploy, 1);
});

test("network recovery keeps a verified password only until it stops or is cancelled", async t => {
  const f = await fixture(t, {}, true);
  await f.connect();
  const generation = f.manager.get(f.profile.id).generation;
  f.manager.get(f.profile.id).transport.peer.close(network());
  await status(f.manager, f.profile.id, row => row.state === "connected" && row.generation! > generation);
  assert.equal(f.calls.authentication, 1); assert.equal(f.calls.clearAuthentication, 0);
  await f.manager.disconnect(f.profile.id);
  assert.equal(f.manager.authentication(f.profile.id), undefined);
  assert.equal(f.calls.clearAuthentication, 1);
});

for (const code of ["authentication", "host-key", "configuration", "protocol", "host-busy", "host-unavailable"] as const) {
  test(`${code} stops recovery without repeated authentication attempts`, async t => {
    const f = await fixture(t, {}, true);
    await f.connect();
    f.setAttach(async () => { throw new RemoteConnectionError(code, `safe ${code} reason`); });
    f.manager.get(f.profile.id).transport.peer.close(network());
    const failed = await status(f.manager, f.profile.id, row => row.state === "failed");
    assert.equal(f.calls.attach, 2); assert.equal(f.calls.deploy, 1);
    assert.equal(failed.message, `safe ${code} reason`);
    assert.equal(f.manager.authentication(f.profile.id), undefined); assert.equal(f.calls.clearAuthentication, 1);
  });
}

test("cancelling backoff prevents later SSH children and clears authentication", async t => {
  const f = await fixture(t, { delaysMs: [80] }, true);
  await f.connect();
  f.manager.get(f.profile.id).transport.peer.close(network());
  await status(f.manager, f.profile.id, row => row.state === "recovering" && row.attempt === 1);
  await f.manager.disconnect(f.profile.id);
  await delay(100);
  assert.equal(f.calls.attach, 1); assert.equal(f.calls.clearAuthentication, 1);
  await status(f.manager, f.profile.id, row => row.state === "disconnected");
});

test("a late attach result cannot make a cancelled connection live again", async t => {
  const f = await fixture(t);
  let release!: (value: SshRemoteTransport) => void;
  f.setAttach(() => new Promise(resolve => { release = resolve; }));
  const connecting = f.connect();
  const rejected = assert.rejects(connecting, /取消/);
  while (!release) await delay(1);
  const stopping = f.manager.disconnect(f.profile.id);
  const late = channel(); f.channels.push(late); release(late.transport);
  await stopping; await rejected;
  assert.throws(() => f.manager.get(f.profile.id), /SSH 已断开/);
  await assert.rejects(late.transport.peer.request("ping"), /取消/);
});

test("the overall recovery deadline aborts a hung attachment and releases its password", async t => {
  const f = await fixture(t, { budgetMs: 40 }, true);
  await f.connect();
  f.setAttach(signal => new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(connectionCancelled()), { once: true }); }));
  f.manager.get(f.profile.id).transport.peer.close(network());
  const failed = await status(f.manager, f.profile.id, row => row.state === "failed");
  assert.match(failed.message!, /自动恢复已停止/);
  assert.equal(f.calls.attach, 2); assert.equal(f.calls.clearAuthentication, 1);
});

test("auto-detected system overrides legacy profile metadata and handshake mismatch clears the password", async t => {
  const f = await fixture(t, {}, true);
  f.setProbe(async () => ({ platform: "win32", arch: "x64", home: "C:\\Users\\test", node: "node", version: "24", root: "C:\\remote" }));
  const credentials = { password: "test-only" };
  await assert.rejects(f.manager.connect(f.profile.id, credentials), /体检结果 win32\/x64/);
  assert.equal(credentials.password, ""); assert.equal(f.calls.probe, 1); assert.equal(f.calls.attach, 1);
  assert.equal(f.calls.clearAuthentication, 1);
});

test("manual reconnect reuses installation and flags a changed Host instance", async t => {
  const f = await fixture(t);
  await f.connect(); await f.manager.disconnect(f.profile.id);
  f.setAttach(async () => { const next = channel("new-host"); f.channels.push(next); return next.transport; });
  await f.connect();
  assert.equal(f.calls.probe, 1); assert.equal(f.calls.deploy, 1);
  assert.equal((await f.manager.list()).statuses[0]!.hostRestarted, true);
});

test("Runtime maintenance does not race with automatic recovery or discard its credentials", async t => {
  const f = await fixture(t, {}, true);
  await f.connect();
  await f.manager.maintenance(f.profile.id, async controls => {
    await controls.disconnect(); await delay(20);
    assert.equal(f.calls.attach, 1); assert.equal(f.calls.clearAuthentication, 0);
    await controls.reconnect();
  });
  assert.equal(f.calls.attach, 2); assert.equal(f.calls.deploy, 2);
  assert.equal(f.calls.authentication, 1); assert.equal(f.calls.clearAuthentication, 0);
  assert.equal((await f.manager.list()).statuses[0]!.operation, undefined);
});

test("safe SSH errors identify the failure without returning arbitrary stderr", () => {
  assert.equal(sshFailure("ssh: connect to host test port 22: Connection timed out", undefined, 255).connectionCode, "network");
  assert.equal(sshFailure("Permission denied (password).", undefined, 255).connectionCode, "authentication");
  assert.equal(sshFailure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", undefined, 255).connectionCode, "host-key");
  const marker = randomBytes(12).toString("hex");
  assert.equal(sshFailure(`unrecognized server output ${marker}`, undefined, 1).message.includes(marker), false);
});

test("unresolved Windows SSH aliases and remote directory conflicts show actionable errors", () => {
  const unresolved = sshFailure("ssh: Could not resolve hostname testserver: 不知道这样的主机。", undefined, 255);
  assert.equal(unresolved.connectionCode, "configuration");
  assert.match(unresolved.message, /主机地址.*Host 别名/);
  const temporary = sshFailure("ssh: Could not resolve hostname example: Temporary failure in name resolution", undefined, 255);
  assert.equal(temporary.connectionCode, "network");
  const conflict = sshFailure("Error: ENOTDIR: not a directory, mkdir '/home/ubuntu/.local/share/omp-studio/remote/versions/hash'", undefined, 1);
  assert.equal(conflict.connectionCode, "environment");
  assert.match(conflict.message, /同名文件占用/);
});
