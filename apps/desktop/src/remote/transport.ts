import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClientBootstrap, ClientCommandAccepted, ClientCommandRequest, ClientEvent, ClientQueryRequest, ClientQueryResponse, ClientTransport, CommandName, QueryName, SubscriptionScope, Unsubscribe, WorkspaceListReadModel } from "@omp-studio/client-contract";
import { eventMatchesScope } from "@omp-studio/client";
import { remoteLaunchCommand, sshArguments, systemSshExecutable, type RemotePlatform, type RemoteShell, type SshConnection } from "./platform.js";
import { RemotePeer, RemoteRequestTimeout, REMOTE_PROTOCOL_VERSION, type RemoteAttachment } from "./wire.js";
import type { RemoteHello } from "./server.js";
import { sshAuthenticationRequest, type SshAuthentication } from "./authentication.js";
import { RemoteConnectionError, connectionCancelled, sshFailure } from "./errors.js";

export interface SshRemoteOptions {
  readonly connection: SshConnection;
  readonly authentication?: SshAuthentication;
  readonly attachment?: RemoteAttachment;
  readonly shell: RemoteShell;
  readonly executable: string;
  readonly args: readonly string[];
  readonly expectedPlatform: RemotePlatform;
  readonly expectedBundleVersion?: string;
  readonly signal?: AbortSignal;
  readonly launchCommand?: string;
  readonly spawnProcess?: typeof spawn;
  readonly sshExecutable?: string;
}

export interface RemoteHealthPolicy { intervalMs: number; timeoutMs: number; missedChecks: number; }
const HEALTH_POLICY: RemoteHealthPolicy = { intervalMs: 15_000, timeoutMs: 15_000, missedChecks: 2 };

export class SshRemoteTransport implements ClientTransport {
  readonly #listeners = new Set<(event: ClientEvent) => void>();
  readonly #disconnected = new Set<(error: Error) => void>();
  readonly #healthListeners = new Set<(healthy: boolean) => void>();
  #subscription: Promise<unknown> | undefined;
  #closed: Error | undefined;
  #termination: Promise<void> = Promise.resolve();
  #healthPolicy: RemoteHealthPolicy | undefined;
  #healthTimer: ReturnType<typeof setTimeout> | undefined;
  #checking = false;
  #missed = 0;
  #healthy = true;
  hello: RemoteHello | undefined;

  constructor(readonly peer: RemotePeer, readonly terminate: () => void | Promise<void> = () => {}) {
    const offEvent = peer.onEvent(event => { for (const listener of this.#listeners) listener(event as ClientEvent); });
    peer.onTimeout(method => {
      if (!this.#healthPolicy || method === "ping") return;
      this.#setHealth(false);
      void this.#checkHealth();
    });
    peer.onClose(error => {
      this.#closed = error;
      clearTimeout(this.#healthTimer);
      offEvent();
      this.#listeners.clear();
      this.#healthListeners.clear();
      this.#termination = Promise.resolve(terminate());
      for (const listener of this.#disconnected) listener(error);
      this.#disconnected.clear();
    });
  }

  static async connect(options: SshRemoteOptions): Promise<SshRemoteTransport> {
    options.signal?.throwIfAborted();
    const args = [...sshArguments(options.connection), options.launchCommand ?? remoteLaunchCommand(options.shell, options.executable, options.args)];
    const authenticationRequest = sshAuthenticationRequest(options.connection, options.authentication);
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.spawnProcess ?? spawn)(options.sshExecutable ?? systemSshExecutable(), args, { stdio: "pipe", windowsHide: true, shell: false, ...(authenticationRequest ? { env: authenticationRequest.env } : {}) }) as ChildProcessWithoutNullStreams; }
    catch (error) { authenticationRequest?.dispose(); throw sshFailure("", error); }
    let diagnostics = "";
    let exited = false;
    const exit = new Promise<void>(resolve => child.once("close", () => { exited = true; resolve(); }));
    const peer = new RemotePeer(child.stdout, child.stdin, 30_000, () => sshFailure(diagnostics, new RemoteConnectionError("network", "SSH 通道已中断；已发送命令结果未知，未自动重发")));
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString("utf8")).slice(-4096); });
    child.once("error", error => peer.close(sshFailure(diagnostics, error)));
    child.once("close", code => peer.close(sshFailure(diagnostics, undefined, code)));
    const transport = new SshRemoteTransport(peer, async () => {
      if (exited) return;
      child.kill();
      const force = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1_000);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2_000); })]); }
      finally { clearTimeout(force); clearTimeout(timeout); }
    });
    const cancel = (): void => peer.close(connectionCancelled());
    options.signal?.addEventListener("abort", cancel, { once: true });
    peer.onClose(() => { options.signal?.removeEventListener("abort", cancel); authenticationRequest?.dispose(); });
    if (options.signal?.aborted) cancel();
    try {
      const hello = await peer.request<RemoteHello>("hello", options.attachment ? { attachment: options.attachment } : null);
      if (hello.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new RemoteConnectionError("protocol", "远端 Host 协议版本与客户端不一致，请手动重新连接以更新 Host");
      if (hello.platform !== options.expectedPlatform) throw new RemoteConnectionError("environment", `远端系统是 ${hello.platform}，与配置的 ${options.expectedPlatform} 不符`);
      if (options.expectedBundleVersion !== undefined && hello.bundleVersion !== options.expectedBundleVersion) throw new RemoteConnectionError("protocol", "远端 Host 版本已改变，请手动重新连接；未覆盖现有 Host");
      transport.hello = hello;
      return transport;
    } catch (error) {
      await transport.close();
      if (options.signal?.aborted) throw connectionCancelled();
      throw sshFailure(diagnostics, error instanceof RemoteRequestTimeout ? new RemoteConnectionError("network", "远端 Host 握手超时") : error, child.exitCode);
    }
  }

  onDisconnect(listener: (error: Error) => void): Unsubscribe {
    if (this.#closed) { listener(this.#closed); return () => {}; }
    this.#disconnected.add(listener);
    return () => { this.#disconnected.delete(listener); };
  }
  onHealth(listener: (healthy: boolean) => void): Unsubscribe { this.#healthListeners.add(listener); return () => { this.#healthListeners.delete(listener); }; }
  startHealthChecks(policy = HEALTH_POLICY): void {
    if (this.#closed || this.#healthPolicy) return;
    this.#healthPolicy = policy;
    this.#scheduleHealth(policy.intervalMs);
  }
  #setHealth(healthy: boolean): void {
    if (this.#closed || this.#healthy === healthy) return;
    this.#healthy = healthy;
    for (const listener of this.#healthListeners) listener(healthy);
  }
  #scheduleHealth(delay: number): void {
    clearTimeout(this.#healthTimer);
    this.#healthTimer = setTimeout(() => { void this.#checkHealth(); }, delay);
    this.#healthTimer.unref();
  }
  async #checkHealth(): Promise<void> {
    const policy = this.#healthPolicy;
    if (!policy || this.#closed || this.#checking) return;
    clearTimeout(this.#healthTimer);
    this.#checking = true;
    try {
      await this.peer.request("ping", null, policy.timeoutMs);
      this.#missed = 0;
      this.#setHealth(true);
    } catch (error) {
      if (this.#closed) return;
      this.#setHealth(false);
      if (!(error instanceof RemoteRequestTimeout)) { this.peer.close(sshFailure("", error)); return; }
      if (++this.#missed >= policy.missedChecks) this.peer.close(new RemoteConnectionError("network", "远端 Host 连续未响应健康检查，正在恢复通道；未停止远端任务"));
    } finally {
      this.#checking = false;
      if (!this.#closed) this.#scheduleHealth(this.#missed ? 0 : policy.intervalMs);
    }
  }

  async bootstrap(): Promise<ClientBootstrap> {
    await this.#ensureSubscription();
    return this.peer.request("bootstrap");
  }
  query<T extends QueryName>(request: ClientQueryRequest<T>): Promise<ClientQueryResponse<T>> { return this.peer.request("query", request); }
  command<T extends CommandName>(request: ClientCommandRequest<T>): Promise<ClientCommandAccepted<T>> { return this.peer.request("command", request); }
  registerWorkspace(path: string): Promise<WorkspaceListReadModel> { return this.peer.request("workspace.register", { path }); }
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.#closed) throw this.#closed;
    const filtered = (event: ClientEvent): void => { if (eventMatchesScope(event, scope)) listener(event); };
    this.#listeners.add(filtered);
    return () => { this.#listeners.delete(filtered); };
  }
  async close(): Promise<void> { this.peer.close(connectionCancelled()); await this.#termination; }

  #ensureSubscription(): Promise<unknown> {
    this.#subscription ??= this.peer.request("subscribe", { scope: "all" });
    return this.#subscription;
  }
}
