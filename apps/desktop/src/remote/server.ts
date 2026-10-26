import { timingSafeEqual, randomBytes } from "node:crypto";
import { chmod, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import { parseClientCommandRequest, parseClientQueryRequest, parseSubscriptionScope } from "@omp-studio/transport-desktop";
import { createWindowsBridgeAclPort, ensurePrivateSocketDirectory, privateSocketPath } from "@omp-studio/studio-host";
import type { ClientBootstrap } from "@omp-studio/client-contract";
import type { RemoteHost } from "./host.js";
import { remotePlatform, secureRemoteDirectory } from "./platform.js";
import { RemotePeer, REMOTE_PROTOCOL_VERSION, type RemoteAttachment } from "./wire.js";
import { RemoteConnectionError } from "./errors.js";

export interface RemoteHello {
  readonly protocolVersion: number;
  readonly platform: "linux" | "win32" | "darwin";
  readonly arch: string;
  readonly bundleVersion: string;
  readonly instanceId: string;
}

export function hasActiveRemoteWork(bootstrap: ClientBootstrap): boolean {
  return Boolean(bootstrap.pendingInteraction || bootstrap.snapshot?.isStreaming || bootstrap.snapshot?.isCompacting || bootstrap.residents?.residents.some(row => row.phase !== "idle" || row.pendingMessages > 0));
}

interface EndpointFile { endpoint: string; token: string }
const ENDPOINT_FILE = "remote-endpoint.json";

export async function serveRemoteHost(host: RemoteHost, stateDirectory: string, onShutdown?: () => void, bundleVersion = "development"): Promise<{ close(): Promise<void> }> {
  await secureRemoteDirectory(stateDirectory);
  const name = randomBytes(12).toString("hex");
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\omp-studio-remote-${name}`
    : privateSocketPath(await ensurePrivateSocketDirectory(`remote-wire:${stateDirectory}`), `${name}.sock`);
  const token = randomBytes(32).toString("base64url");
  const peers = new Set<RemotePeer>();
  let attached: RemotePeer | undefined;
  let lastAttachment: RemoteAttachment | undefined;
  let stopping = false;
  let pendingWrites = 0;
  let idleSince = Date.now();
  let checkingIdle = false;
  const busy = async (): Promise<boolean> => {
    const snapshot = await host.composition.transport.bootstrap();
    return pendingWrites > 0 || host.composition.facade.hasPendingCommands || host.composition.isBusy() || hasActiveRemoteWork(snapshot);
  };
  const idleTimer = setInterval(() => {
    if (peers.size || stopping) { idleSince = Date.now(); return; }
    if (checkingIdle) return;
    checkingIdle = true;
    void busy().then(active => {
      if (active || peers.size) idleSince = Date.now();
      else if (Date.now() - idleSince > 30 * 60_000) { stopping = true; onShutdown?.(); }
    }).catch(() => { idleSince = Date.now(); }).finally(() => { checkingIdle = false; });
  }, 60_000);
  idleTimer.unref();
  const hello: RemoteHello = { protocolVersion: REMOTE_PROTOCOL_VERSION, platform: remotePlatform(process.platform), arch: process.arch, bundleVersion, instanceId: name };
  const server = createServer(socket => {
    const peer = new RemotePeer(socket, socket);
    peers.add(peer);
    let authenticated = false;
    let observer = false;
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => peer.close(new Error("Remote authentication timed out")), 5_000);
    peer.onClose(() => { clearTimeout(timer); unsubscribe?.(); peers.delete(peer); if (attached === peer) attached = undefined; });
    peer.handle(async (method, input) => {
      if (stopping) throw new Error("Remote Host is shutting down");
      if (!authenticated) {
        const supplied = input && typeof input === "object" && "token" in input ? input.token : undefined;
        if (method !== "hello" || typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          peer.close(new Error("Remote authentication failed"));
          throw new Error("Remote authentication failed");
        }
        observer = Boolean(input && typeof input === "object" && "observe" in input && input.observe === true);
        const attachment = input && typeof input === "object" && "attachment" in input ? input.attachment as RemoteAttachment | undefined : undefined;
        if (attachment && (typeof attachment.key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(attachment.key) || !Number.isSafeInteger(attachment.sequence) || attachment.sequence < 1)) throw new RemoteConnectionError("protocol", "Invalid remote attachment identity");
        if (!observer) {
          const sameOwner = attachment && lastAttachment && attachment.key === lastAttachment.key;
          if (sameOwner && attachment && lastAttachment && attachment.sequence <= lastAttachment.sequence) throw new RemoteConnectionError("replaced", "这条 SSH 通道已被更新的连接取代");
          // Only a newer channel holding this desktop's attachment key may replace its orphaned attach.
          if (attached && !sameOwner) throw new RemoteConnectionError("host-busy", "远端 Host 已被其他桌面连接占用；不会强制断开对方");
          attached?.close(new RemoteConnectionError("replaced", "这条 SSH 通道已被更新的连接取代"));
          attached = peer;
          lastAttachment = attachment;
        }
        authenticated = true;
        clearTimeout(timer);
        return hello;
      }
      if (observer && method !== "hello" && method !== "shutdown") throw new Error("A status connection cannot access the workspace");
      switch (method) {
        case "hello": return hello;
        case "ping": return { instanceId: hello.instanceId };
        case "bootstrap":
          await host.composition.transport.query({ queryName: "projects.list", input: {} });
          return host.composition.transport.bootstrap();
        case "query": return host.composition.transport.query(parseClientQueryRequest(input));
        case "command":
          pendingWrites++;
          try { return await host.composition.transport.command(parseClientCommandRequest(input)); }
          finally { pendingWrites--; }
        case "subscribe":
          unsubscribe?.();
          unsubscribe = host.composition.transport.subscribe(parseSubscriptionScope(input), event => peer.publish(event));
          return { subscribed: true };
        case "workspace.path":
          if (!input || typeof input !== "object" || !("workspaceId" in input) || typeof input.workspaceId !== "string") throw new Error("Workspace identity is required");
          return { path: host.workspacePath(input.workspaceId) };
        case "directories": {
          const requested = input && typeof input === "object" && "path" in input && typeof input.path === "string" ? input.path : homedir();
          if (requested !== "~" && !isAbsolute(requested)) throw new Error("Remote directory must be an absolute path");
          const path = await realpath(resolve(requested === "~" ? homedir() : requested));
          const entries = await readdir(path, { withFileTypes: true });
          return { path, parent: dirname(path), directories: entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, 1000).map(entry => ({ name: entry.name, path: join(path, entry.name) })).sort((a, b) => a.name.localeCompare(b.name)) };
        }
        case "shutdown":
          if (observer && attached) throw new Error("Disconnect the other desktop before updating the remote Host");
          stopping = true;
          try {
            if (await busy()) throw new Error("Remote work or an approval is still pending; finish it before stopping the Host");
          } catch (error) { stopping = false; throw error; }
          setTimeout(() => onShutdown?.(), 50);
          return { stopping: true };
        case "workspace.register":
          if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") throw new Error("Remote workspace path is required");
          pendingWrites++;
          try { return await host.registerWorkspace(input.path); }
          finally { pendingWrites--; }
      }
    });
  });
  try {
    await listen(server, endpoint);
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    const contents = JSON.stringify({ endpoint, token } satisfies EndpointFile);
    const path = join(stateDirectory, ENDPOINT_FILE);
    // The Host authority lease protects replacement of stale endpoint metadata.
    await rm(path, { force: true });
    if (process.platform === "win32") await createWindowsBridgeAclPort().createSecureTokenFile(path, contents);
    else await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    clearInterval(idleTimer);
    for (const peer of peers) peer.close();
    await closeServer(server);
    throw error;
  }
  let closed = false;
  return { async close() {
    if (closed) return;
    closed = true;
    stopping = true;
    clearInterval(idleTimer);
    for (const peer of peers) peer.close();
    await closeServer(server);
    await host.close();
    const path = join(stateDirectory, ENDPOINT_FILE);
    const current = await readFile(path, "utf8").catch(() => "");
    if (current === JSON.stringify({ endpoint, token })) await rm(path, { force: true });
  } };
}

export async function connectRemoteEndpoint(stateDirectory: string, observe = false, attachment?: RemoteAttachment): Promise<RemotePeer> {
  let data: EndpointFile;
  try { data = JSON.parse(await readFile(join(stateDirectory, ENDPOINT_FILE), "utf8")) as EndpointFile; }
  catch (error) { if (!observe && (error as NodeJS.ErrnoException).code === "ENOENT") throw new RemoteConnectionError("host-unavailable", "远端 Host 已停止或端点不存在；请手动重新连接，自动恢复不会重启任务"); throw error; }
  if (typeof data.endpoint !== "string" || typeof data.token !== "string") throw new Error("Invalid remote Host endpoint file");
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = connect(data.endpoint);
    const timer = setTimeout(() => { connection.destroy(); reject(new Error("Remote Host connection timed out")); }, 5_000);
    connection.once("connect", () => { clearTimeout(timer); resolve(connection); });
    connection.once("error", error => {
      clearTimeout(timer);
      reject(!observe && ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") ? new RemoteConnectionError("host-unavailable", "远端 Host 已停止；请手动重新连接，自动恢复不会重启任务") : error);
    });
  });
  const peer = new RemotePeer(socket, socket);
  try { await peer.request("hello", { token: data.token, observe, ...(attachment ? { attachment } : {}) }); return peer; }
  catch (error) { peer.close(); throw error; }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
}
function closeServer(server: Server): Promise<void> { return new Promise(resolve => server.close(() => resolve())); }
