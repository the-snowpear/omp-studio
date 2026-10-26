import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ClientTransport, WorkspaceId } from "@omp-studio/client-contract";
import type { RemoteHost } from "../src/remote/host.js";
import { remoteLaunchCommand, remoteStateRoot, sshArguments } from "../src/remote/platform.js";
import { RemotePeer } from "../src/remote/wire.js";
import { SshRemoteTransport } from "../src/remote/transport.js";
import { connectRemoteEndpoint, serveRemoteHost } from "../src/remote/server.js";

function peers() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  return { client: new RemotePeer(toClient, toServer), server: new RemotePeer(toServer, toClient) };
}

test("remote command acknowledgement and interleaved events use the typed channel", async () => {
  const { client, server } = peers();
  const transport = new SshRemoteTransport(client);
  const events: unknown[] = [];
  const commands: unknown[] = [];
  transport.subscribe({ scope: "all" }, event => events.push(event));
  server.handle(async (method, input) => {
    if (method === "subscribe") return { subscribed: true };
    if (method === "bootstrap") { server.publish({ kind: "test-event" }); return { selected: {} }; }
    if (method === "command") { commands.push(input); return { accepted: true }; }
    return {};
  });
  try {
    await transport.bootstrap();
    assert.equal(events.length, 1);
    await client.request("command", { commandName: "core.prompt", input: { text: "hello" } });
    assert.equal(commands.length, 1);
  } finally { await transport.close(); server.close(); }
});

test("disconnect does not retry an already dispatched mutation or route it to another peer", async () => {
  const first = peers();
  const second = peers();
  let firstWrites = 0;
  let secondWrites = 0;
  first.server.handle(async () => { firstWrites++; return new Promise(() => {}); });
  second.server.handle(async () => { secondWrites++; return {}; });
  const pending = first.client.request("command", { commandName: "git.execute" });
  const rejected = assert.rejects(pending, /unknown/);
  await new Promise(resolve => setImmediate(resolve));
  first.server.close();
  await rejected;
  assert.equal(firstWrites, 1);
  assert.equal(secondWrites, 0);
  second.client.close(); second.server.close();
});

test("independent target streams keep identical event identities isolated", async () => {
  const a = peers(); const b = peers();
  const first: unknown[] = []; const second: unknown[] = [];
  a.client.onEvent(event => first.push(event)); b.client.onEvent(event => second.push(event));
  const event = { sessionId: "same-session", authorityEpoch: 1 };
  a.server.publish(event);
  assert.deepEqual(first, [event]); assert.deepEqual(second, []);
  b.server.publish(event);
  assert.deepEqual(second, [event]);
  a.client.close(); a.server.close(); b.client.close(); b.server.close();
});

test("remote paths and launch commands follow the target OS rather than the client OS", () => {
  assert.equal(remoteStateRoot("linux", "/home/dev", {}), "/home/dev/.local/share/omp-studio/remote");
  assert.equal(remoteStateRoot("darwin", "/Users/dev", {}), "/Users/dev/Library/Application Support/omp-studio/remote");
  assert.equal(remoteStateRoot("win32", "C:\\Users\\dev", {}), "C:\\Users\\dev\\AppData\\Local\\omp-studio\\remote");
  assert.equal(remoteLaunchCommand("posix", "/opt/my host/node", ["/home/a'b/host.js"]), "exec '/opt/my host/node' '/home/a'\\''b/host.js'");
  assert.equal(remoteLaunchCommand("powershell", "C:\\Program Files\\node.exe", ["D:\\开发\\host.js"]), "& 'C:\\Program Files\\node.exe' 'D:\\开发\\host.js'");
  assert.equal(remoteLaunchCommand("cmd", "C:\\Program Files\\node.exe", ["D:\\开发\\host.js"]), '"C:\\Program Files\\node.exe" "D:\\开发\\host.js"');
  assert.throws(() => remoteLaunchCommand("cmd", "node", ["D:\\%PATH%\\host.js"]), /PowerShell/);
  const args = sshArguments({ host: "dev", user: "DOMAIN\\user", port: 2222, proxyJump: "bastion" });
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("ForwardAgent=no"));
  assert.deepEqual(args.slice(-3), ["-J", "bastion", "dev"]);
});

test("reconnecting to a live endpoint does not shut down the Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-endpoint-"));
  let closed = false;
  let opened = "";
  const host: RemoteHost = {
    composition: { facade: { hasPendingCommands: false }, isBusy: () => false, transport: { bootstrap: async () => ({ selected: {} }), query: async () => ({ ok: true, result: { workspaces: [] } }), subscribe: () => () => {} } as unknown as ClientTransport } as RemoteHost["composition"],
    workspacePath: () => root,
    registerWorkspace: async path => { opened = path; return { workspaces: [] }; },
    close: async () => { closed = true; },
  };
  const endpoint = await serveRemoteHost(host, root);
  try {
    const first = await connectRemoteEndpoint(root);
    await first.request("workspace.register", { path: "test-remote-root" });
    first.close();
    assert.equal(closed, false);
    const second = await connectRemoteEndpoint(root);
    await second.request("bootstrap");
    second.close();
    assert.equal(opened, "test-remote-root");
  } finally { await endpoint.close(); await rm(root, { recursive: true, force: true }); }
  assert.equal(closed, true);
});

test("a stdio attach process can reconnect without owning the Host lifetime", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-attach-"));
  let stopped = false;
  const host: RemoteHost = {
    composition: { facade: { hasPendingCommands: false }, isBusy: () => false, transport: { bootstrap: async () => ({ selected: {} }), query: async () => ({ ok: true, result: { workspaces: [] } }), subscribe: () => () => {} } as unknown as ClientTransport } as RemoteHost["composition"],
    workspacePath: () => root,
    registerWorkspace: async () => ({ workspaces: [] }),
    close: async () => { stopped = true; },
  };
  const endpoint = await serveRemoteHost(host, root);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../src/remote/main.js", import.meta.url)), "attach", "--state", root], { stdio: "pipe" });
      const exit = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(`attach exited ${code}`)));
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      const peer = new RemotePeer(child.stdout, child.stdin);
      try {
        const hello = await peer.request<{ platform: string }>("hello");
        assert.equal(hello.platform, process.platform);
        await peer.request("bootstrap");
      } finally { peer.close(); await exit; }
      assert.equal(stderr, "");
      assert.equal(stopped, false);
    }
  } finally { await endpoint.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending remote approval prevents shutdown and a status probe cannot steal the attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-wait-"));
  let stopped = false;
  const host = {
    composition: { facade: { hasPendingCommands: false }, isBusy: () => false, transport: { bootstrap: async () => ({ residents: { residents: [{ phase: "waiting", pendingMessages: 0 }] } }) } },
    close: async () => { stopped = true; },
  } as unknown as RemoteHost;
  const endpoint = await serveRemoteHost(host, root, () => { stopped = true; });
  try {
    const active = await connectRemoteEndpoint(root);
    const observer = await connectRemoteEndpoint(root, true);
    try {
      await observer.request("hello");
      await assert.rejects(observer.request("shutdown"), /other desktop/);
      await assert.rejects(active.request("shutdown"), /approval/);
      assert.equal(stopped, false);
    } finally { active.close(); observer.close(); }
  } finally { await endpoint.close(); await rm(root, { recursive: true, force: true }); }
});

test("only a newer channel from the same desktop can replace its orphaned attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-takeover-"));
  let closed = false;
  const host = {
    composition: { facade: { hasPendingCommands: false }, isBusy: () => false, transport: { bootstrap: async () => ({ selected: {} }), query: async () => ({ ok: true, result: { workspaces: [] } }) } },
    close: async () => { closed = true; },
  } as unknown as RemoteHost;
  const endpoint = await serveRemoteHost(host, root);
  const key = "a".repeat(43);
  let first: RemotePeer | undefined; let second: RemotePeer | undefined;
  try {
    first = await connectRemoteEndpoint(root, false, { key, sequence: 1 });
    const oldClosed = new Promise<void>(resolve => first!.onClose(() => resolve()));
    second = await connectRemoteEndpoint(root, false, { key, sequence: 2 });
    await oldClosed;
    await second.request("ping");
    await assert.rejects(connectRemoteEndpoint(root, false, { key, sequence: 1 }), /取代/);
    await assert.rejects(connectRemoteEndpoint(root, false, { key: "b".repeat(43), sequence: 3 }), /其他桌面/);
    await second.request("bootstrap");
    assert.equal(closed, false);
  } finally { first?.close(); second?.close(); await endpoint.close(); await rm(root, { recursive: true, force: true }); }
});

test("headless Host serves real workspace files without Electron or a fabricated Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-host-"));
  const keys = join(root, "keys"); const workspace = join(root, "project");
  await mkdir(keys); await mkdir(workspace);
  const key = generateKeyPairSync("ed25519");
  await writeFile(join(keys, "key-id.txt"), "remote-test");
  await writeFile(join(keys, "trusted-public.pem"), key.publicKey.export({ type: "spki", format: "pem" }));
  const { createRemoteHost } = await import("../src/remote/host.js");
  const host = await createRemoteHost({ stateDirectory: join(root, "state"), runtimeDirectory: join(root, "runtimes"), trustedKeysDirectory: keys });
  try {
    const list = await host.registerWorkspace(workspace);
    assert.equal(list.workspaces.length, 1);
    const bootstrap = await host.composition.transport.bootstrap();
    assert.equal(bootstrap.runtime.status, "unavailable");
    await writeFile(join(workspace, "远端文件.txt"), "actual bytes\r\n");
    const result = await host.composition.transport.query({ queryName: "workspace.fileTree", input: { workspaceId: list.activeWorkspaceId as WorkspaceId } });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.result.nodes[0]?.name, "远端文件.txt");
    assert.equal(await readFile(join(workspace, "远端文件.txt"), "utf8"), "actual bytes\r\n");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
