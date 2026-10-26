import { parseClientCommandRequest, parseClientQueryRequest } from "@omp-studio/transport-desktop";
import { REMOTE_CHANNELS, type RemoteConnectionProfile, type RemoteCredentials } from "./shared.js";
import type { RemoteConnectionManager } from "./manager.js";
import { RemoteOperationError } from "./wire.js";

interface Sender { getURL(): string; isDestroyed(): boolean; send(channel: string, payload: unknown): void; }
interface Ipc { handle(channel: string, listener: (event: { sender: Sender }, ...args: unknown[]) => unknown): void; removeHandler(channel: string): void; }
export function registerRemoteIpc(options: { ipc: Ipc; manager: RemoteConnectionManager; isTrusted(sender: Sender): boolean; confirmDeployment(profile: RemoteConnectionProfile): Promise<boolean>; installRuntime(id: string): Promise<{ installed: boolean }> }): { cancelPending(): Promise<void>; dispose(): void } {
  const { ipc, manager } = options;
  let disposed = false;
  const senders = new Set<Sender>();
  const connecting = new Map<string, { controller: AbortController; clearCredentials(): void }>();
  const handle = (channel: string, action: (...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      if (disposed || event.sender.isDestroyed() || !options.isTrusted(event.sender)) throw new Error("Untrusted remote workspace client");
      senders.add(event.sender);
      return action(...args);
    });
  };
  const idOf = (id: unknown): string => { if (typeof id !== "string" || !id) throw new Error("Connection identity is required"); return id; };
  const read = async <T>(id: unknown, action: (remote: ReturnType<RemoteConnectionManager["get"]>) => Promise<T>): Promise<T> => {
    const target = idOf(id);
    const remote = manager.get(target);
    const generation = remote.generation;
    const result = await action(remote);
    if (manager.get(target) !== remote || remote.generation !== generation) throw new Error("SSH 通道已改变，请重新同步；已丢弃旧连接的读取结果");
    return result;
  };
  const cancelPending = async (): Promise<void> => {
    for (const attempt of connecting.values()) { attempt.controller.abort(); attempt.clearCredentials(); }
    connecting.clear();
    senders.clear();
    await manager.cancelPending();
  };
  handle(REMOTE_CHANNELS.list, () => manager.list());
  handle(REMOTE_CHANNELS.save, profile => manager.save(profile as Omit<RemoteConnectionProfile, "id"> & { id?: string }));
  handle(REMOTE_CHANNELS.remove, id => manager.remove(idOf(id)));
  handle(REMOTE_CHANNELS.connect, async (id, input) => {
    const credentials = input as RemoteCredentials | undefined;
    const target = idOf(id);
    if (connecting.has(target)) { if (credentials) credentials.password = ""; throw new Error("此 SSH 连接正在准备中"); }
    const attempt = { controller: new AbortController(), clearCredentials: () => { if (credentials) credentials.password = ""; } };
    connecting.set(target, attempt);
    let stopWaiting: (() => void) | undefined;
    try {
      await manager.list();
      attempt.controller.signal.throwIfAborted();
      const cancelled = new Promise<false>(resolve => {
        const onAbort = () => resolve(false);
        attempt.controller.signal.addEventListener("abort", onAbort, { once: true });
        stopWaiting = () => attempt.controller.signal.removeEventListener("abort", onAbort);
      });
      const confirmed = await Promise.race([options.confirmDeployment(manager.profile(target)), cancelled]);
      if (!confirmed || attempt.controller.signal.aborted || disposed) throw new Error("连接已取消");
      await manager.connect(target, credentials, attempt.controller.signal);
    } finally {
      stopWaiting?.();
      if (connecting.get(target) === attempt) connecting.delete(target);
      if (credentials && typeof credentials === "object") credentials.password = "";
    }
  });
  handle(REMOTE_CHANNELS.installRuntime, id => options.installRuntime(idOf(id)));
  handle(REMOTE_CHANNELS.disconnect, id => {
    const target = idOf(id);
    const attempt = connecting.get(target);
    if (attempt) { attempt.controller.abort(); attempt.clearCredentials(); }
    return manager.disconnect(target);
  });
  handle(REMOTE_CHANNELS.select, id => manager.select(id === null ? null : idOf(id)));
  handle(REMOTE_CHANNELS.bootstrap, id => read(id, remote => remote.transport.bootstrap()));
  handle(REMOTE_CHANNELS.query, (id: unknown, request: unknown) => read(id, remote => remote.transport.query(parseClientQueryRequest(request))));
  handle(REMOTE_CHANNELS.command, async (id: unknown, request: unknown) => {
    const target = idOf(id);
    manager.assertWritable(target);
    const transport = manager.get(target).transport;
    const command = parseClientCommandRequest(request);
    try { return { ok: true, accepted: await transport.command(command) }; }
    catch (error) { return { ok: false, error: { code: error instanceof RemoteOperationError ? "UNAVAILABLE" : "OUTCOME_UNKNOWN", message: error instanceof Error ? error.message : "命令结果未知；未自动重发，请重新连接核对" } }; }
  });
  handle(REMOTE_CHANNELS.directories, (id, path) => read(id, remote => remote.transport.peer.request("directories", typeof path === "string" ? { path } : {})));
  handle(REMOTE_CHANNELS.register, (id, path) => {
    if (typeof path !== "string" || !path) throw new Error("远端目录不能为空");
    manager.assertWritable(idOf(id));
    return manager.get(idOf(id)).transport.registerWorkspace(path);
  });
  const emit = (channel: string, payload: unknown): void => { for (const sender of senders) { if (sender.isDestroyed()) senders.delete(sender); else sender.send(channel, payload); } };
  const offEvent = manager.onEvent(event => emit(REMOTE_CHANNELS.event, event));
  const offChanged = manager.onChanged(() => emit(REMOTE_CHANNELS.changed, {}));
  return { cancelPending, dispose() {
    disposed = true;
    void cancelPending().catch(() => {});
    offEvent(); offChanged();
    for (const channel of Object.values(REMOTE_CHANNELS)) if (channel !== REMOTE_CHANNELS.event && channel !== REMOTE_CHANNELS.changed) ipc.removeHandler(channel);
  } };
}
