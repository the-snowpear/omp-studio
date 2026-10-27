import { modelConfigHasUnsavedChanges } from "../ModelConfigPage";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { StudioClientImpl } from "@omp-studio/client";
import type { StudioClient } from "@omp-studio/client-contract";
import type { RemoteApi, RemoteInventory, RemoteConnectionProfile, RemoteCredentials } from "../../../desktop/src/remote/shared";
import { SshPasswordDialog } from "./SshPasswordDialog";
import { SshPreparationDialog } from "./SshPreparationDialog";
import { createRemoteTransport, type RemoteTransportState } from "./remoteTransport";

interface ExecutionTargetContextValue {
  localClient?: StudioClient;
  id: string | null;
  name: string;
  inventory: RemoteInventory;
  api: RemoteApi | undefined;
  inventoryError: string;
  syncRevision: number;
  syncError: string;
  refresh(): Promise<void>;
  connect(id: string): Promise<void>;
  cancelConnection(id: string): Promise<void>;
  select(id: string | null): Promise<void>;
  openDirectory(): void;
  directoryRequest: number;
  memory: Map<string, unknown>;
}
const Context = createContext<ExecutionTargetContextValue>({ id: null, name: "此计算机", inventory: { profiles: [], statuses: [] }, api: undefined, inventoryError: "", syncRevision: 0, syncError: "", refresh: async () => {}, connect: async () => {}, cancelConnection: async () => {}, select: async () => {}, openDirectory: () => {}, directoryRequest: 0, memory: new Map() });
export function useExecutionTarget() { return useContext(Context); }
export function useTargetMemory<T>(key: string, initial: () => T) {
  const { memory } = useExecutionTarget();
  const [value, setValue] = useState<T>(() => memory.has(key) ? memory.get(key) as T : initial());
  const current = useRef(value);
  current.current = value;
  const update = useCallback<Dispatch<SetStateAction<T>>>(action => {
    const next = typeof action === "function" ? (action as (previous: T) => T)(current.current) : action;
    current.current = next;
    memory.set(key, next);
    setValue(next);
  }, [memory, key]);
  return [value, update] as const;
}

export function ExecutionTargets({ client, children }: { client: StudioClient; children(client: StudioClient, key: string): ReactNode }) {
  const api = globalThis.ompStudioRemote;
  const [id, setId] = useState<string | null>(null);
  const [ready, setReady] = useState(!api);
  const [generation, setGeneration] = useState(0);
  const [rawInventory, setInventory] = useState<RemoteInventory>({ profiles: [], statuses: [] });
  const [inventoryError, setInventoryError] = useState("");
  const [directoryRequest, setDirectoryRequest] = useState(0);
  const [passwordProfile, setPasswordProfile] = useState<RemoteConnectionProfile>();
  const passwordRequest = useRef<{ id: string; resolve(password: string | null): void } | undefined>(undefined);
  const connectionLock = useRef<string | undefined>(undefined);
  const cancelledConnection = useRef<string | undefined>(undefined);
  const clients = useRef(new Map<string, StudioClientImpl>());
  const transports = useRef(new Map<string, RemoteTransportState>());
  const synchronizing = useRef(new Map<string, { revision: number; promise: Promise<void> }>());
  const memories = useRef(new Map<string, Map<string, unknown>>());
  const selecting = useRef(false);
  const refreshSequence = useRef(0);
  const mounted = useRef(true);
  const memoryKey = id ?? "local";
  if (!memories.current.has(memoryKey)) memories.current.set(memoryKey, new Map());
  const memory = memories.current.get(memoryKey)!;
  const stateFor = useCallback((targetId: string) => {
    let state = transports.current.get(targetId);
    if (!state) { state = { available: false, generation: 0, revision: 0, synchronized: false, syncRevision: 0 }; transports.current.set(targetId, state); }
    return state;
  }, []);
  const clientFor = useCallback((targetId: string) => {
    let value = clients.current.get(targetId);
    if (!value) {
      const state = stateFor(targetId);
      value = new StudioClientImpl(createRemoteTransport(api!, targetId, state));
      clients.current.set(targetId, value);
      if (!state.available) value.transportLost("SSH 尚未同步，暂停写操作");
    }
    return value;
  }, [api, stateFor]);
  const synchronize = useCallback(async (targetId: string, force = false) => {
    const state = stateFor(targetId);
    if (!state.available) throw new Error("SSH 通道尚未恢复，请稍候或重新连接");
    if (state.synchronized && !force) return;
    const revision = state.revision;
    const pending = synchronizing.current.get(targetId);
    if (pending?.revision === revision) return pending.promise;
    delete state.error;
    const targetClient = clientFor(targetId);
    state.synchronized = false;
    setInventory(value => ({ ...value }));
    const run = Promise.resolve().then(async () => {
      try {
        await targetClient.bootstrap();
        if (!mounted.current || state.revision !== revision || !state.available) return;
        if (targetClient.getState().connection.resyncRequired) throw new Error("同步期间事件发生缺口，请重新同步");
        state.synchronized = true;
        state.syncRevision++;
      } catch (error) {
        if (mounted.current && state.revision === revision && state.available) {
          state.error = error instanceof Error ? error.message : "无法同步远端状态";
          targetClient.transportLost("远端状态同步失败，写操作仍暂停");
        }
        throw error;
      } finally {
        if (mounted.current && state.revision === revision) setInventory(value => ({ ...value }));
      }
    });
    const attempt = { revision, promise: run };
    synchronizing.current.set(targetId, attempt);
    try { await run; } finally { if (synchronizing.current.get(targetId) === attempt) synchronizing.current.delete(targetId); }
  }, [clientFor, stateFor]);
  const adoptInventory = useCallback((next: RemoteInventory) => {
    for (const status of next.statuses) {
      const state = stateFor(status.id);
      const available = status.state === "connected";
      const nextGeneration = status.generation ?? 0;
      if (state.available !== available || state.generation !== nextGeneration) {
        state.revision++;
        state.synchronized = false;
        delete state.error;
        clients.current.get(status.id)?.transportLost("SSH 连接已改变；命令结果未知，未自动重发");
      }
      state.available = available;
      state.generation = nextGeneration;
    }
    for (const [targetId, state] of transports.current) if (!next.profiles.some(profile => profile.id === targetId)) {
      state.available = false; state.revision++;
      void clients.current.get(targetId)?.close();
      clients.current.delete(targetId); transports.current.delete(targetId); memories.current.delete(targetId);
    }
    setInventory(next);
    setInventoryError("");
  }, [stateFor]);
  const refresh = useCallback(async () => {
    if (!api) return;
    const sequence = ++refreshSequence.current;
    let next: RemoteInventory;
    try { next = await api.list(); }
    catch (error) { if (mounted.current && sequence === refreshSequence.current) setInventoryError(error instanceof Error ? error.message : "无法读取 SSH 连接"); throw error; }
    if (!mounted.current || sequence !== refreshSequence.current) return;
    adoptInventory(next);
    await Promise.allSettled(next.statuses.filter(status => {
      const state = stateFor(status.id);
      return status.state === "connected" && clients.current.has(status.id) && !state.synchronized && !state.error;
    }).map(status => synchronize(status.id)));
  }, [api, adoptInventory, stateFor, synchronize]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const initialize = async () => {
      try {
        const next = await api.list();
        if (!active) return;
        adoptInventory(next);
        if (next.activeId) {
          clientFor(next.activeId); setId(next.activeId);
          if (stateFor(next.activeId).available) void synchronize(next.activeId).catch(() => {});
        }
        setReady(true);
      } catch (error) { if (active) setInventoryError(error instanceof Error ? error.message : "无法读取当前工作位置"); }
    };
    void initialize();
    const off = api.onChanged(() => { void refresh().catch(() => {}); });
    return () => { active = false; off(); };
  }, [api, adoptInventory, clientFor, refresh, stateFor, synchronize]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshSequence.current++;
      passwordRequest.current?.resolve(null);
      const targetId = connectionLock.current;
      if (targetId) {
        cancelledConnection.current = targetId;
        void api?.disconnect(targetId).catch(() => {});
      }
      for (const state of transports.current.values()) { state.available = false; state.revision++; state.synchronized = false; }
      for (const value of clients.current.values()) void value.close();
      clients.current.clear();
    };
  }, [api]);

  const finishPassword = useCallback((password: string | null) => {
    const pending = passwordRequest.current;
    passwordRequest.current = undefined;
    setPasswordProfile(undefined);
    pending?.resolve(password);
  }, []);
  const connect = useCallback(async (targetId: string) => {
    if (!api) throw new Error("SSH 连接需要桌面客户端");
    if (connectionLock.current) throw new Error("另一个 SSH 连接正在准备中");
    connectionLock.current = targetId;
    cancelledConnection.current = undefined;
    let credentials: RemoteCredentials | undefined;
    try {
      let inventory = rawInventory;
      if (!inventory.profiles.some(value => value.id === targetId)) inventory = await api.list();
      const profile = inventory.profiles.find(value => value.id === targetId);
      if (!profile) throw new Error("SSH 连接不存在");
      const status = inventory.statuses.find(value => value.id === targetId);
      if (status?.state === "connected") { await synchronize(targetId); return; }
      if (status && ["connecting", "awaiting-approval", "recovering", "degraded", "synchronizing"].includes(status.state)) throw new Error("SSH 正在恢复或同步；可以等待或取消，不会重复连接");
      if (profile.authMode === "password") {
        let password = await new Promise<string | null>(resolve => {
          passwordRequest.current = { id: targetId, resolve };
          setPasswordProfile(profile);
        });
        if (password === null) throw new Error("连接已取消");
        credentials = { password };
        password = null;
      }
      if (cancelledConnection.current === targetId) throw new Error("连接已取消");
      const pending = api.connect(targetId, credentials);
      if (credentials) credentials.password = "";
      await pending;
      if (cancelledConnection.current === targetId) throw new Error("连接已取消");
      await refresh();
    } finally {
      if (credentials) credentials.password = "";
      connectionLock.current = undefined;
      finishPassword(null);
    }
  }, [api, rawInventory, refresh, finishPassword, synchronize]);
  const cancelConnection = useCallback(async (targetId: string) => {
    cancelledConnection.current = targetId;
    if (passwordRequest.current?.id === targetId) { finishPassword(null); return; }
    const state = stateFor(targetId);
    state.available = false; state.synchronized = false; state.revision++;
    clients.current.get(targetId)?.transportLost("SSH 连接已取消；已发送命令未重发");
    await api?.disconnect(targetId);
    await refresh();
  }, [api, finishPassword, refresh, stateFor]);

  const select = useCallback(async (next: string | null) => {
    if (!api) return;
    if (selecting.current) throw new Error("正在切换工作位置，请稍候");
    if (next !== id && modelConfigHasUnsavedChanges()) throw new Error("请先保存或放弃模型配置更改，再切换工作位置");
    selecting.current = true;
    try {
      if (next !== null) {
        await synchronize(next, true);
        if (!clientFor(next).getState().connection.selected?.workspaceId) throw new Error("请先选择远端项目目录");
      }
      await api.select(next);
      if (next !== id) { setId(next); setGeneration(value => value + 1); }
    } finally { selecting.current = false; }
  }, [api, clientFor, id, synchronize]);
  const inventory: RemoteInventory = { ...rawInventory, statuses: rawInventory.statuses.map(status => {
    const state = transports.current.get(status.id);
    return status.state === "connected" && clients.current.has(status.id) && state && !state.synchronized
      ? { ...status, state: state.error ? "failed" as const : "synchronizing" as const, message: state.error ? `状态同步失败：${state.error}` : "SSH 已连通，正在同步页面；写操作仍暂停" }
      : status;
  }) };
  const profile = inventory.profiles.find(value => value.id === id);
  const syncRevision = id === null ? 0 : transports.current.get(id)?.syncRevision ?? 0;
  const syncError = id === null ? "" : transports.current.get(id)?.error ?? "";
  const value = useMemo(() => ({ localClient: client, id, name: id === null ? "此计算机" : profile?.name ?? "SSH", inventory, api, inventoryError, syncRevision, syncError, refresh, connect, cancelConnection, select, openDirectory: () => setDirectoryRequest(value => value + 1), directoryRequest, memory }), [client, id, profile?.name, inventory, api, inventoryError, syncRevision, syncError, refresh, connect, cancelConnection, select, directoryRequest, memory]);
  const preparing = rawInventory.statuses.find(status => ["connecting", "awaiting-approval", "synchronizing"].includes(status.state) && connectionLock.current === status.id);
  const preparingProfile = preparing && rawInventory.profiles.find(profile => profile.id === preparing.id);
  const activeClient = id === null ? client : clientFor(id);
  return <Context.Provider value={value}>
    {ready ? children(activeClient, `${id ?? "local"}:${generation}`) : <div className="empty" role="status"><p>{inventoryError || "正在恢复工作位置…"}</p>{inventoryError ? <button className="btn outline" onClick={() => globalThis.location.reload()}>重新加载</button> : null}</div>}
    {passwordProfile ? <SshPasswordDialog profile={passwordProfile} onSubmit={finishPassword} onCancel={() => finishPassword(null)} /> : null}
    {preparing && preparingProfile && !passwordProfile ? <SshPreparationDialog profile={preparingProfile} status={preparing} onApprove={() => { void api?.approveDeployment(preparing.id).catch(() => {}); }} onCancel={() => { void cancelConnection(preparing.id).catch(() => {}); }} /> : null}
  </Context.Provider>;
}
