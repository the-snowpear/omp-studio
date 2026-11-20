import { modelConfigHasUnsavedChanges } from "../models/modelConfigState";
import { PLATFORM } from "../platform";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { StudioClientImpl } from "@omp-studio/client";
import type { StudioClient } from "@omp-studio/client-contract";
import type { RemoteApi, RemoteTargetKind, WslInventory, RemoteInventory, RemoteConnectionProfile, RemoteCredentials } from "../../../desktop/src/remote/shared";
import { SshPasswordDialog } from "./SshPasswordDialog";
import { SshPreparationDialog } from "./SshPreparationDialog";
import { createRemoteTransport, type RemoteTransportState } from "./remoteTransport";

interface ExecutionTargetContextValue {
  kind: RemoteTargetKind | "local";
  wsl: WslInventory | undefined;
  refreshWsl(): void;
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
const Context = createContext<ExecutionTargetContextValue>({ id: null, kind: "local", wsl: undefined, refreshWsl() {}, name: "This computer", inventory: { profiles: [], statuses: [] }, api: undefined, inventoryError: "", syncRevision: 0, syncError: "", refresh: async () => {}, connect: async () => {}, cancelConnection: async () => {}, select: async () => {}, openDirectory: () => {}, directoryRequest: 0, memory: new Map() });
export function useExecutionTarget() { return useContext(Context); }
interface TargetRegistry {
  client(id: string | null): StudioClient;
  readyClient(id: string | null): Promise<StudioClient>;
  scope(id: string | null, memoryKey: string): ExecutionTargetContextValue;
}
const Registry = createContext<TargetRegistry | null>(null);
export function useExecutionTargets() {
  const value = useContext(Registry);
  if (!value) throw new Error("ExecutionTargets is required");
  return value;
}
export function ExecutionTargetScope({ id, memoryKey, onSelect, children }: { id: string | null; memoryKey: string; onSelect?: (id: string | null) => Promise<void>; children: ReactNode }) {
  const registry = useExecutionTargets();
  const value = registry.scope(id, memoryKey);
  return <Context.Provider value={onSelect ? { ...value, select: onSelect } : value}>{children}</Context.Provider>;
}
export function useTargetMemory<T>(key: string, initial: () => T) {
  const { memory } = useExecutionTarget();
  const [slot, setSlot] = useState<{ memory: Map<string, unknown>; key: string; value: T }>(() => ({
    memory,
    key,
    value: memory.has(key) ? (memory.get(key) as T) : initial(),
  }));
  const aligned = slot.memory === memory && slot.key === key;
  const resolved = aligned ? slot.value : memory.has(key) ? (memory.get(key) as T) : initial();
  const current = useRef(resolved);
  current.current = resolved;
  useEffect(() => {
    if (!aligned) setSlot({ memory, key, value: current.current });
  }, [aligned, memory, key]);
  const update = useCallback<Dispatch<SetStateAction<T>>>(action => {
    const next = typeof action === "function" ? (action as (previous: T) => T)(current.current) : action;
    current.current = next;
    memory.set(key, next);
    setSlot({ memory, key, value: next });
  }, [memory, key]);
  return [resolved, update] as const;
}

export function ExecutionTargets({ client, children }: { client: StudioClient; children(client: StudioClient, key: string): ReactNode }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const text = useCallback((zhText: string, enText: string) => (zhRef.current ? zhText : enText), []);
  const api = globalThis.ompStudioRemote;
  const { preview } = usePreviewMode();
  const [wslInventory, setWslInventory] = useState<WslInventory>();
  const wslSequence = useRef(0);
  const discover = !preview && PLATFORM === "win32" ? api?.wslDistributions : undefined;
  const refreshWsl = useCallback(() => {
    if (!discover) return;
    const sequence = ++wslSequence.current;
    void discover().then(value => {
      if (sequence === wslSequence.current) setWslInventory(value);
    }, () => {
      if (sequence === wslSequence.current) setWslInventory(last => last ?? { available: false, distributions: [] });
    });
  }, [discover]);
  useEffect(() => { refreshWsl(); return () => { wslSequence.current++; }; }, [refreshWsl]);
  const [id, setId] = useState<string | null>(null);
  const [ready, setReady] = useState(!api);
  const [generation, setGeneration] = useState(0);
  const [rawInventory, setInventory] = useState<RemoteInventory>({ profiles: [], statuses: [] });
  const profilesRef = useRef(rawInventory.profiles);
  const noun = (targetId: string) => profilesRef.current.find(item => item.id === targetId)?.kind === "wsl" ? "WSL" : "SSH";
  const [inventoryError, setInventoryError] = useState("");
  const [directoryRequest, setDirectoryRequest] = useState(0);
  const [passwordProfile, setPasswordProfile] = useState<RemoteConnectionProfile>();
  const passwordRequest = useRef<{ id: string; resolve(password: string | null): void } | undefined>(undefined);
  const connectionLock = useRef<{ id: string; token: symbol } | undefined>(undefined);
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
      if (!state.available) value.transportLost(text(`${noun(targetId)} 尚未同步，暂停写操作`, `${noun(targetId)} not synchronized; write operations paused`));
    }
    return value;
  }, [api, stateFor]);
  const synchronize = useCallback(async (targetId: string, force = false) => {
    const state = stateFor(targetId);
    if (!state.available) throw new Error(text(`${noun(targetId)} 通道尚未恢复，请稍候或重新连接`, `${noun(targetId)} channel is still recovering; please wait or reconnect`));
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
        if (targetClient.getState().connection.resyncRequired) throw new Error(text("同步期间事件发生缺口，请重新同步", "An event gap occurred during sync; please resync"));
        state.synchronized = true;
        state.syncRevision++;
      } catch (error) {
        if (mounted.current && state.revision === revision && state.available) {
          state.error = error instanceof Error ? error.message : text("无法同步远端状态", "Unable to sync remote state");
          targetClient.transportLost(text("远端状态同步失败，写操作仍暂停", "Remote state sync failed; write operations remain paused"));
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
    profilesRef.current = next.profiles;
    for (const status of next.statuses) {
      const state = stateFor(status.id);
      const available = status.state === "connected";
      const nextGeneration = status.generation ?? 0;
      if (state.available !== available || state.generation !== nextGeneration) {
        state.revision++;
        state.synchronized = false;
        delete state.error;
        clients.current.get(status.id)?.transportLost(text(`${noun(status.id)} 连接已改变，命令结果未知，未自动重发`, `${noun(status.id)} connection changed; command outcome unknown and was not resent`));
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
    catch (error) { if (mounted.current && sequence === refreshSequence.current) setInventoryError(error instanceof Error ? error.message : text("无法读取工作位置", "Unable to read execution targets")); throw error; }
    if (!mounted.current || sequence !== refreshSequence.current) return;
    adoptInventory(next);
    await Promise.allSettled(next.statuses.filter(status => {
      const state = stateFor(status.id);
      return status.state === "connected" && clients.current.has(status.id) && !state.synchronized;
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
      } catch (error) { if (active) setInventoryError(error instanceof Error ? error.message : text("无法读取当前工作位置", "Unable to read the active execution target")); }
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
      const activeLock = connectionLock.current;
      connectionLock.current = undefined;
      if (activeLock) {
        void api?.disconnect(activeLock.id).catch(() => {});
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
    if (!api) throw new Error(text("远程连接需要桌面客户端", "Remote connections require the desktop app"));
    if (connectionLock.current) throw new Error(text("另一个连接正在准备中", "Another connection is already being prepared"));
    const token = Symbol();
    connectionLock.current = { id: targetId, token };
    let credentials: RemoteCredentials | undefined;
    try {
      let inventory = rawInventory;
      if (!inventory.profiles.some(value => value.id === targetId)) inventory = await api.list();
      if (connectionLock.current?.token !== token) throw new Error(text("连接已取消", "Connection cancelled"));
      const profile = inventory.profiles.find(value => value.id === targetId);
      if (!profile) throw new Error(text("工作位置不存在", "Execution target does not exist"));
      const status = inventory.statuses.find(value => value.id === targetId);
      if (status?.state === "connected") { await synchronize(targetId); return; }
      if (status && ["connecting", "awaiting-approval", "recovering", "degraded", "synchronizing"].includes(status.state)) throw new Error(text(`${noun(targetId)} 正在恢复或同步，请等待或取消`, `${noun(targetId)} is recovering or synchronizing. Wait or cancel.`));
      if (profile.authMode === "password") {
        let password = await new Promise<string | null>(resolve => {
          passwordRequest.current = { id: targetId, resolve };
          setPasswordProfile(profile);
        });
        if (password === null) throw new Error(text("连接已取消", "Connection cancelled"));
        credentials = { password };
        password = null;
      }
      if (connectionLock.current?.token !== token) throw new Error(text("连接已取消", "Connection cancelled"));
      const pending = api.connect(targetId, credentials);
      if (credentials) credentials.password = "";
      await pending;
      if (connectionLock.current?.token !== token) throw new Error(text("连接已取消", "Connection cancelled"));
      await refresh();
    } finally {
      if (credentials) credentials.password = "";
      if (connectionLock.current?.token === token) {
        connectionLock.current = undefined;
        finishPassword(null);
      }
    }
  }, [api, rawInventory, refresh, finishPassword, synchronize]);
  const cancelConnection = useCallback(async (targetId: string) => {
    if (connectionLock.current?.id === targetId) connectionLock.current = undefined;
    if (passwordRequest.current?.id === targetId) { finishPassword(null); return; }
    const state = stateFor(targetId);
    state.available = false; state.synchronized = false; state.revision++;
    clients.current.get(targetId)?.transportLost(text(`${noun(targetId)} 连接已取消，已发送命令未重发`, `${noun(targetId)} connection cancelled; in-flight commands were not resent`));
    await api?.disconnect(targetId);
    await refresh();
  }, [api, finishPassword, refresh, stateFor]);

  const select = useCallback(async (next: string | null) => {
    if (!api) return;
    if (selecting.current) throw new Error(text("正在切换工作位置，请稍候", "Switching workspace location, please wait"));
    if (next !== id && modelConfigHasUnsavedChanges()) throw new Error(text("请先保存或放弃模型配置更改，再切换工作位置", "Save or discard model configuration changes before switching workspace location"));
    selecting.current = true;
    try {
      if (next !== null) {
        await synchronize(next, true);
        if (!clientFor(next).getState().connection.selected?.workspaceId) throw new Error(text("请先选择远端项目目录", "Please select a remote project directory first"));
      }
      await api.select(next);
      if (next !== id) { setId(next); setGeneration(value => value + 1); }
    } finally { selecting.current = false; }
  }, [api, clientFor, id, synchronize]);
  const inventory: RemoteInventory = { ...rawInventory, statuses: rawInventory.statuses.map(status => {
    const state = transports.current.get(status.id);
    return status.state === "connected" && clients.current.has(status.id) && state && !state.synchronized
      ? { ...status, state: state.error ? "failed" as const : "synchronizing" as const, message: state.error ? (zh ? `状态同步失败：${state.error}` : `Status sync failed: ${state.error}`) : (zh ? `${noun(status.id)} 已连通，正在同步页面；写操作仍暂停` : `${noun(status.id)} connected, syncing pages; write operations remain paused`) }
      : status;
  }) };
  const profile = inventory.profiles.find(value => value.id === id);
  const syncRevision = id === null ? 0 : transports.current.get(id)?.syncRevision ?? 0;
  const syncError = id === null ? "" : transports.current.get(id)?.error ?? "";
  const kind: RemoteTargetKind | "local" = id === null ? "local" : profile?.kind ?? "ssh";
  const value = useMemo(() => ({ kind, wsl: discover ? wslInventory : undefined, refreshWsl, localClient: client, id, name: id === null ? (zh ? "此计算机" : "This computer") : profile?.name ?? "SSH", inventory, api, inventoryError, syncRevision, syncError, refresh, connect, cancelConnection, select, openDirectory: () => setDirectoryRequest(value => value + 1), directoryRequest, memory }), [client, id, kind, discover, wslInventory, refreshWsl, profile?.name, inventory, api, inventoryError, syncRevision, syncError, refresh, connect, cancelConnection, select, directoryRequest, memory, zh]);
  const preparing = rawInventory.statuses.find(status => ["connecting", "awaiting-approval", "synchronizing"].includes(status.state) && connectionLock.current?.id === status.id);
  const preparingProfile = preparing && rawInventory.profiles.find(profile => profile.id === preparing.id);
  const activeClient = id === null ? client : clientFor(id);
  const registry: TargetRegistry = {
    client: target => target === null ? client : clientFor(target),
    readyClient: async target => { if (target === null) return client; await synchronize(target); return clientFor(target); },
    scope: (target, key) => {
      const memoryKey = `${target ?? "local"}:document:${key}`;
      if (!memories.current.has(memoryKey)) memories.current.set(memoryKey, new Map());
      const state = target === null ? undefined : stateFor(target);
      const targetProfile = inventory.profiles.find(item => item.id === target);
      return { ...value, kind: target === null ? "local" : targetProfile?.kind ?? "ssh", id: target, name: target === null ? (zh ? "此计算机" : "This computer") : targetProfile?.name ?? "SSH",
        memory: memories.current.get(memoryKey)!, syncRevision: state?.syncRevision ?? 0, syncError: state?.error ?? "" };
    },
  };
  return <Registry.Provider value={registry}><Context.Provider value={value}>
    {ready ? children(activeClient, `${id ?? "local"}:${generation}`) : <div className="empty" role="status"><p>{inventoryError || (zh ? "正在恢复工作位置…" : "Restoring workspace location…")}</p>{inventoryError ? <button className="btn outline" onClick={() => globalThis.location.reload()}>{zh ? "重新加载" : "Reload"}</button> : null}</div>}
    {passwordProfile ? <SshPasswordDialog profile={passwordProfile} onSubmit={finishPassword} onCancel={() => finishPassword(null)} /> : null}
    {preparing && preparingProfile && !passwordProfile ? <SshPreparationDialog profile={preparingProfile} status={preparing} onApprove={() => { void api?.approveDeployment(preparing.id).catch(() => {}); }} onCancel={() => { void cancelConnection(preparing.id).catch(() => {}); }} /> : null}
  </Context.Provider></Registry.Provider>;
}
