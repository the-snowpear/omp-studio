import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientEvent } from "@omp-studio/client-contract";
import { attachRemote, deployRemote, probeRemote, type RemoteEnvironment, type RemoteInstallation } from "./deploy.js";
import { sshArguments } from "./platform.js";
import type { RemoteConnectionProfile, RemoteConnectionStatus, RemoteCredentials, RemoteDirectoryList, RemoteInventory } from "./shared.js";
import type { SshRemoteTransport } from "./transport.js";
import { createPasswordAuthentication, type SshAuthentication } from "./authentication.js";
import { connectionCancelled, connectionFailure, RemoteConnectionError } from "./errors.js";
import { RemoteRequestTimeout, type RemoteAttachment } from "./wire.js";

interface PreparedRemote extends RemoteInstallation { environment: RemoteEnvironment; attachment: RemoteAttachment; instanceId?: string; }
interface LiveRemote extends RemoteInstallation { transport: SshRemoteTransport; environment: RemoteEnvironment; generation: number; connectedAt: number; healthVersion: number; hostRestarted: boolean; }
interface ConnectionAttempt { promise: Promise<void>; controller: AbortController; }
interface RecoveryBudget { startedAt: number; attempts: number; }
export interface RemoteRecoveryPolicy { maxAttempts: number; budgetMs: number; delaysMs: readonly number[]; stableMs: number; random(): number; }
export const REMOTE_RECOVERY_POLICY: RemoteRecoveryPolicy = { maxAttempts: 5, budgetMs: 120_000, delaysMs: [1_000, 2_000, 4_000, 8_000, 15_000], stableMs: 60_000, random: Math.random };
export interface RemoteMaintenance {
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  progress(message: string): void;
}
const backend = { probeRemote, deployRemote, attachRemote, createPasswordAuthentication };

export class RemoteConnectionManager {
  readonly #profiles = new Map<string, RemoteConnectionProfile>();
  readonly #status = new Map<string, RemoteConnectionStatus>();
  readonly #prepared = new Map<string, PreparedRemote>();
  readonly #live = new Map<string, LiveRemote>();
  readonly #connecting = new Map<string, ConnectionAttempt>();
  readonly #disconnecting = new Map<string, Promise<void>>();
  readonly #wanted = new Set<string>();
  readonly #budgets = new Map<string, RecoveryBudget>();
  readonly #listeners = new Set<() => void>();
  readonly #events = new Set<(value: { id: string; generation: number; event: ClientEvent }) => void>();
  readonly #maintenance = new Map<string, Promise<unknown>>();
  readonly #authentication = new Map<string, SshAuthentication>();
  #loaded: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();
  #closed = false;
  #generation = 0;
  activeId: string | null = null;

  constructor(readonly path: string, readonly bundleDirectory: string, readonly services = backend, readonly helperDirectory = join(dirname(bundleDirectory), "ssh-askpass"), readonly recovery = REMOTE_RECOVERY_POLICY) {}
  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  onEvent(listener: (value: { id: string; generation: number; event: ClientEvent }) => void): () => void { this.#events.add(listener); return () => { this.#events.delete(listener); }; }
  async list(): Promise<RemoteInventory> { await this.#load(); return { profiles: [...this.#profiles.values()], statuses: [...this.#status.values()], activeId: this.activeId }; }

  async save(input: Omit<RemoteConnectionProfile, "id"> & { id?: string }): Promise<RemoteConnectionProfile> {
    await this.#load();
    sshArguments(input);
    if (!input.name?.trim() || input.name.length > 80 || !["linux", "win32", "darwin"].includes(input.platform)) throw new Error("Connection name and target system are required");
    if (input.authMode !== undefined && input.authMode !== "agent" && input.authMode !== "password") throw new Error("Unsupported SSH authentication method");
    if (input.authMode === "password" && !input.user?.trim()) throw new Error("账密连接需要填写用户名");
    if (input.user?.trim() && input.host.includes("@")) throw new Error("使用独立用户名字段时，主机中请勿重复填写 user@");
    const id = input.id ?? randomUUID();
    this.assertWritable(id);
    if (input.id && !this.#profiles.has(input.id)) throw new Error("Unknown SSH connection");
    if (this.#live.has(id) || this.#connecting.has(id) || this.#disconnecting.has(id) || this.#wanted.has(id) || this.activeId === id) throw new Error("Switch away and disconnect before editing this connection");
    const profile: RemoteConnectionProfile = { id, name: input.name.trim(), host: input.host, platform: input.platform, authMode: input.authMode ?? "agent", ...(input.user ? { user: input.user.trim() } : {}), ...(input.port ? { port: input.port } : {}) };
    this.#profiles.set(id, profile);
    this.#prepared.delete(id);
    this.#budgets.delete(id);
    this.#status.set(id, { id, state: "disconnected" });
    await this.#flush();
    this.#changed();
    return profile;
  }

  async remove(id: string): Promise<void> {
    await this.#load();
    this.assertWritable(id);
    if (this.#live.has(id) || this.#connecting.has(id) || this.#disconnecting.has(id) || this.#wanted.has(id) || this.activeId === id) throw new Error("Switch away and disconnect before removing this connection");
    this.#profiles.delete(id);
    this.#status.delete(id);
    this.#prepared.delete(id);
    this.#budgets.delete(id);
    await this.#flush();
    this.#changed();
  }

  async connect(id: string, credentials?: RemoteCredentials, signal?: AbortSignal): Promise<void> {
    try { this.assertWritable(id); await this.#connect(id, credentials, signal); }
    finally { if (credentials) credentials.password = ""; }
  }

  async #connect(id: string, credentials?: RemoteCredentials, signal?: AbortSignal, automatic = false, redeploy = false): Promise<void> {
    await this.#load();
    await this.#disconnecting.get(id);
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("Application is shutting down");
    if (this.#live.has(id)) return;
    const pending = this.#connecting.get(id);
    if (pending) return pending.promise;
    if (automatic && !this.#wanted.has(id)) return;
    const profile = this.profile(id);
    this.#wanted.add(id);
    if (!automatic) this.#budgets.delete(id);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const budget = automatic ? this.#budgets.get(id)! : undefined;
    let exhausted = false;
    const deadline = budget ? setTimeout(() => { exhausted = true; controller.abort(); }, Math.max(0, budget.startedAt + this.recovery.budgetMs - Date.now())) : undefined;
    deadline?.unref();
    const run = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        let authentication = this.#authentication.get(id);
        if (profile.authMode === "password" && !authentication) {
          if (automatic || !credentials || typeof credentials.password !== "string") throw new RemoteConnectionError("authentication", "请在应用内重新输入 SSH 密码");
          const preparing = this.services.createPasswordAuthentication(profile, credentials.password, this.helperDirectory, controller.signal);
          credentials.password = "";
          authentication = await preparing;
          this.#authentication.set(id, authentication);
          controller.signal.throwIfAborted();
        }
        if (budget) {
          const prepared = this.#prepared.get(id)!;
          while (budget.attempts < this.recovery.maxAttempts && Date.now() < budget.startedAt + this.recovery.budgetMs) {
            const base = this.recovery.delaysMs[Math.min(budget.attempts, this.recovery.delaysMs.length - 1)] ?? 1_000;
            const wait = Math.round(base * (0.8 + this.recovery.random() * 0.4));
            budget.attempts++;
            this.#setStatus({ id, state: "recovering", arch: prepared.environment.arch, attempt: budget.attempts, maxAttempts: this.recovery.maxAttempts, retryAt: Date.now() + wait, message: "网络连接中断，正在等待重新附加原 Host；命令不会自动重发" });
            await delay(wait, undefined, { signal: controller.signal });
            this.#setStatus({ id, state: "recovering", arch: prepared.environment.arch, attempt: budget.attempts, maxAttempts: this.recovery.maxAttempts, message: "正在重新附加原 Host，不重新部署或启动任务" });
            try { await this.#attach(id, profile, prepared, controller.signal, authentication); return; }
            catch (error) { controller.signal.throwIfAborted(); if (connectionFailure(error).connectionCode !== "network") throw error; }
          }
          exhausted = true;
          throw new RemoteConnectionError("network", "自动恢复已达到次数或时间上限");
        }
        this.#setStatus({ id, state: "connecting", message: "正在连接 SSH" });
        const prepared = this.#prepared.get(id);
        if (prepared && !redeploy) {
          try { await this.#attach(id, profile, prepared, controller.signal, authentication); return; }
          catch (error) {
            controller.signal.throwIfAborted();
            if (!["host-unavailable", "protocol"].includes(connectionFailure(error).connectionCode)) throw error;
          }
        }
        this.#setStatus({ id, state: "connecting", message: "正在检查 SSH 和远端环境" });
        const environment = await this.services.probeRemote(profile, controller.signal, authentication);
        controller.signal.throwIfAborted();
        if (environment.platform !== profile.platform) throw new RemoteConnectionError("environment", `目标系统是 ${environment.platform}，请修改连接配置`);
        this.#setStatus({ id, state: "connecting", message: "正在准备远端 Host" });
        const installation = await this.services.deployRemote(profile, environment, this.bundleDirectory, controller.signal, authentication);
        controller.signal.throwIfAborted();
        const next: PreparedRemote = { ...installation, environment, attachment: prepared?.attachment ?? { key: randomBytes(32).toString("base64url"), sequence: 0 }, ...(prepared?.instanceId ? { instanceId: prepared.instanceId } : {}) };
        this.#prepared.set(id, next);
        await this.#attach(id, profile, next, controller.signal, authentication);
      } catch (error) {
        this.#wanted.delete(id);
        await this.#clearAuthentication(id);
        const failure = exhausted ? new RemoteConnectionError("network", `自动恢复已停止（最多 ${this.recovery.maxAttempts} 次 / ${Math.round(this.recovery.budgetMs / 1_000)} 秒）；请手动重连核对任务，未重发命令`) : controller.signal.aborted ? connectionCancelled() : connectionFailure(error);
        this.#setStatus({ id, state: failure.connectionCode === "cancelled" ? "disconnected" : "failed", message: failure.message });
        throw failure;
      }
    });
    const attempt = { promise: run, controller };
    this.#connecting.set(id, attempt);
    try { await run; }
    finally {
      clearTimeout(deadline);
      if (this.#connecting.get(id) === attempt) this.#connecting.delete(id);
      signal?.removeEventListener("abort", cancel);
    }
  }

  async #attach(id: string, profile: RemoteConnectionProfile, prepared: PreparedRemote, signal: AbortSignal, authentication?: SshAuthentication): Promise<void> {
    let transport: SshRemoteTransport | undefined;
    try {
      const attachment = { key: prepared.attachment.key, sequence: ++prepared.attachment.sequence };
      transport = await this.services.attachRemote(profile, prepared.environment, prepared, signal, authentication, attachment);
      signal.throwIfAborted();
      this.#setStatus({ id, state: "synchronizing", arch: prepared.environment.arch, message: "SSH 已连通，正在核对远端快照" });
      await transport.bootstrap();
      signal.throwIfAborted();
      if (this.#closed || !this.#wanted.has(id)) throw connectionCancelled();
      const hostRestarted = Boolean(prepared.instanceId && transport.hello?.instanceId !== prepared.instanceId);
      const live: LiveRemote = { ...prepared, transport, generation: ++this.#generation, connectedAt: Date.now(), healthVersion: 0, hostRestarted };
      this.#live.set(id, live);
      transport.subscribe({ scope: "all" }, event => {
        if (this.#live.get(id) !== live || this.#status.get(id)?.state !== "connected") return;
        for (const listener of this.#events) listener({ id, generation: live.generation, event });
      });
      transport.onHealth(healthy => { void this.#healthChanged(id, live, healthy); });
      transport.onDisconnect(error => this.#transportLost(id, live, error));
      if (this.#live.get(id) !== live) throw new RemoteConnectionError("network", "SSH 在同步期间断开");
      if (transport.hello) prepared.instanceId = transport.hello.instanceId;
      this.#connected(id, live);
      transport.startHealthChecks();
    } catch (error) {
      if (this.#live.get(id)?.transport === transport) this.#live.delete(id);
      await transport?.close();
      if (error instanceof RemoteRequestTimeout) throw new RemoteConnectionError("network", "远端快照同步超时，尚未恢复写操作");
      throw error;
    }
  }

  #connected(id: string, live: LiveRemote): void {
    this.#setStatus({ id, state: "connected", generation: live.generation, arch: live.environment.arch, hostRestarted: live.hostRestarted, ...(live.hostRestarted ? { message: "远端 Host 已更换实例；已重新读取状态，不能保证原任务仍在运行" } : {}) });
  }
  async #healthChanged(id: string, live: LiveRemote, healthy: boolean): Promise<void> {
    if (this.#live.get(id) !== live || this.#closed) return;
    const version = ++live.healthVersion;
    if (!healthy) { this.#setStatus({ id, state: "degraded", generation: live.generation, arch: live.environment.arch, message: "远端响应迟缓，暂停新的写操作并检查通道；不重启 Host" }); return; }
    this.#setStatus({ id, state: "synchronizing", generation: live.generation, arch: live.environment.arch, message: "通道已恢复响应，正在同步远端状态" });
    try {
      await live.transport.bootstrap();
      if (this.#live.get(id) !== live || version !== live.healthVersion || this.#closed) return;
      live.generation = ++this.#generation;
      live.connectedAt = Date.now();
      this.#connected(id, live);
    } catch (error) {
      if (this.#live.get(id) === live && version === live.healthVersion) live.transport.peer.close(error instanceof RemoteRequestTimeout ? new RemoteConnectionError("network", "远端快照同步超时") : connectionFailure(error));
    }
  }
  #transportLost(id: string, live: LiveRemote, error: Error): void {
    if (this.#live.get(id) !== live) return;
    this.#live.delete(id);
    if (this.#closed || !this.#wanted.has(id) || this.#maintenance.has(id)) {
      this.#setStatus({ id, state: "disconnected", message: "SSH 已断开；未停止远端任务" });
      return;
    }
    const failure = connectionFailure(error);
    if (failure.connectionCode !== "network") {
      this.#wanted.delete(id);
      void this.#clearAuthentication(id);
      this.#setStatus({ id, state: "failed", message: failure.message });
      return;
    }
    if (!this.#budgets.has(id) || Date.now() - live.connectedAt >= this.recovery.stableMs) this.#budgets.set(id, { startedAt: Date.now(), attempts: 0 });
    this.#setStatus({ id, state: "recovering", generation: live.generation, arch: live.environment.arch, message: "连接中断，正在恢复；已发送命令结果未知，未自动重发" });
    void (async () => {
      await this.#connecting.get(id)?.promise.catch(() => {});
      if (!this.#closed && this.#wanted.has(id) && !this.#live.has(id) && !this.#maintenance.has(id)) await this.#connect(id, undefined, undefined, true);
    })().catch(() => {});
  }

  async disconnect(id: string): Promise<void> {
    this.assertWritable(id);
    const existing = this.#disconnecting.get(id);
    if (existing) return existing;
    this.#wanted.delete(id);
    this.#budgets.delete(id);
    const pending = this.#connecting.get(id);
    pending?.controller.abort();
    const live = this.#live.get(id);
    this.#live.delete(id);
    this.#setStatus({ id, state: "disconnected", message: "连接已取消或断开；未停止远端任务" });
    const run = Promise.resolve().then(async () => {
      await live?.transport.close();
      await pending?.promise.catch(() => {});
      await this.#clearAuthentication(id);
    });
    this.#disconnecting.set(id, run);
    try { await run; } finally { if (this.#disconnecting.get(id) === run) this.#disconnecting.delete(id); }
  }

  async cancelPending(): Promise<void> {
    const ids = new Set([...this.#connecting.keys(), ...[...this.#status.values()].filter(status => ["recovering", "degraded", "synchronizing"].includes(status.state)).map(status => status.id)]);
    await Promise.all([...ids].filter(id => !this.#maintenance.has(id)).map(id => this.disconnect(id)));
  }
  authentication(id: string): SshAuthentication | undefined { return this.#authentication.get(id); }
  async #clearAuthentication(id: string): Promise<void> {
    const authentication = this.#authentication.get(id);
    this.#authentication.delete(id);
    await authentication?.close();
  }

  async maintenance<T>(id: string, action: (controls: RemoteMaintenance) => Promise<T>): Promise<T> {
    this.assertWritable(id);
    if (this.#connecting.has(id)) throw new Error("Wait for SSH preparation to finish");
    this.get(id);
    const run = Promise.resolve().then(() => action({
      disconnect: async () => { const live = this.#live.get(id); this.#live.delete(id); await live?.transport.close(); this.#setStatus({ id, state: "disconnected", message: "正在维护远端 Runtime" }); },
      reconnect: async () => { if (!this.#closed) await this.#connect(id, undefined, undefined, false, true); },
      progress: message => this.#setStatus({ ...this.#status.get(id)!, id, message }),
    }));
    this.#maintenance.set(id, run);
    this.#setStatus({ ...this.#status.get(id)!, id, message: "正在验证 Runtime 制品" });
    try { return await run; }
    finally {
      this.#maintenance.delete(id);
      if (!this.#live.has(id)) { this.#wanted.delete(id); await this.#clearAuthentication(id); }
      const status = this.#status.get(id);
      if (status) { const { operation: _operation, ...rest } = status; this.#status.set(id, rest); }
      this.#changed();
    }
  }

  assertWritable(id: string): void {
    if (this.#closed) throw new Error("Application is shutting down");
    if (this.#maintenance.has(id)) throw new Error("远端正在安装 Runtime，暂时不能修改工作区");
  }
  select(id: string | null): void { if (id !== null) { this.assertWritable(id); this.get(id); } this.activeId = id; this.#changed(); }
  get(id: string): LiveRemote {
    const remote = this.#live.get(id);
    if (!remote || this.#status.get(id)?.state !== "connected") throw new Error("SSH 已断开或正在恢复，请等待同步完成；不会回落到本机");
    return remote;
  }
  profile(id: string): RemoteConnectionProfile { const profile = this.#profiles.get(id); if (!profile) throw new Error("Unknown SSH connection"); return profile; }
  directories(id: string, path?: string): Promise<RemoteDirectoryList> { return this.get(id).transport.peer.request("directories", path ? { path } : {}); }

  async close(): Promise<void> {
    this.#closed = true;
    this.#wanted.clear();
    for (const pending of this.#connecting.values()) pending.controller.abort();
    await Promise.allSettled([...this.#connecting.values()].map(value => value.promise));
    await Promise.allSettled([...this.#disconnecting.values()]);
    await Promise.allSettled([...this.#maintenance.values()]);
    const live = [...this.#live.values()]; this.#live.clear();
    await Promise.all(live.map(value => value.transport.close()));
    await Promise.all([...this.#authentication.keys()].map(id => this.#clearAuthentication(id)));
    await this.#writes;
  }
  #setStatus(status: RemoteConnectionStatus): void {
    const previous = this.#status.get(status.id);
    const value = { ...(previous?.generation !== undefined ? { generation: previous.generation } : {}), ...status };
    this.#status.set(status.id, this.#maintenance.has(status.id) ? { ...value, operation: "installing-runtime" } : value);
    this.#changed();
  }
  #changed(): void { for (const listener of this.#listeners) listener(); }
  #load(): Promise<void> {
    return this.#loaded ??= (async () => {
      const text = await readFile(this.path, "utf8").catch(error => { if (error.code === "ENOENT") return "[]"; throw error; });
      const values = JSON.parse(text) as RemoteConnectionProfile[];
      for (const value of values) { sshArguments(value); this.#profiles.set(value.id, value); this.#status.set(value.id, { id: value.id, state: "disconnected" }); }
    })();
  }
  #flush(): Promise<void> {
    const text = JSON.stringify([...this.#profiles.values()], null, 2);
    return this.#writes = this.#writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, this.path);
    });
  }
}
