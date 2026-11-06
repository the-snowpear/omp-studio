import { connectTcp } from "./network-proxy.js";
import { NetworkStreams } from "./network-stream.js";
import { localNetworkConnect } from "./local-network.js";
import { attachRemote } from "./deploy.js";
import type { LocalCredentialVault } from "./local-vault.js";
import type { LiveRemote, RemoteConnectionManager } from "./manager.js";
import type { RemoteConnectionStatus } from "./shared.js";
import { RemoteConnectionError } from "./errors.js";
import type { MemoryCredentialStore } from "../memory-credentials.js";

export async function connectRemoteServices(manager: RemoteConnectionManager, id: string, remote: LiveRemote, signal: AbortSignal, report: (patch: Partial<RemoteConnectionStatus>) => void, vault: LocalCredentialVault, resolveProxy: (url: string) => Promise<string>, memoryCredentials?: MemoryCredentialStore): Promise<() => void> {
  const profile = manager.profile(id);
  const attachment = (remote as LiveRemote & { attachment: { key: string; sequence: number } }).attachment;
  const transport = await attachRemote(profile, remote.environment, remote, signal, manager.authentication(id), attachment, true);
  let closed = false;
  const streams = new NetworkStreams(transport.peer, async destination => {
    if (destination.service === "broker") { const endpoint = new URL((await vault.networkEndpoint()).url); return connectTcp(endpoint.hostname, Number(endpoint.port || 80)); }
    return localNetworkConnect(destination, profile.localProxyUrl, resolveProxy);
  });
  const offRoute = transport.peer.onEvent(event => {
    const value = event as { channel?: string; route?: "remote" | "local" };
    if (value?.channel === "network-route" && value.route) report({ networkRoute: value.route, networkMessage: value.route === "local" ? "正在通过本机联网" : "正在通过远端联网" });
  });
  const synchronize = async () => {
    if (closed) return;
    await remote.transport.peer.request("provisioning.apply", await vault.snapshot());
  };
  let syncing = Promise.resolve();
  let memorySync = Promise.resolve();
  const synchronizeMemory = async () => {
    if (!closed && memoryCredentials && remote.transport.hello?.capabilities?.includes("memory.credentials")) {
      await remote.transport.peer.request("memory.credentials.replace", await memoryCredentials.list(`ssh:${id}`));
    }
  };
  const offMemory = memoryCredentials?.subscribe(target => {
    if (target === `ssh:${id}`) memorySync = memorySync.catch(() => {}).then(synchronizeMemory).catch(() => { if (!closed) report({ networkMessage: "Hindsight 凭据同步失败，请重新连接" }); });
  });
  const off = vault.follow(() => { syncing = syncing.catch(() => {}).then(synchronize).catch(() => { if (!closed) report({ networkMessage: "模型配置同步失败，请重新连接以同步最新配置" }); }); });
  try {
    await remote.transport.peer.request("network.configure", { mode: profile.networkMode ?? "remote-first" });
    await synchronize();
    await synchronizeMemory().catch(() => { report({ networkMessage: "Hindsight 凭据同步失败，请检查加密存储" }); });
    transport.onDisconnect(() => { if (!closed) remote.transport.peer.close(new RemoteConnectionError("network", "本机联网通道已断开，需要重新同步")); });
  } catch (error) { closed = true; offMemory?.(); off(); offRoute(); streams.close(); await transport.close(); throw error; }
  return () => { closed = true; offMemory?.(); off(); offRoute(); streams.close(); void transport.close(); };
}
