import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { RemoteConnectionManager } from "../remote/manager.js";
import { sshAuthenticationRequest } from "../remote/authentication.js";
import { sshArguments, systemSshExecutable } from "../remote/platform.js";
import { processGroupSpawnOptions, terminateProcessTree } from "../platform/process-tree.js";
import { desktopText } from "../desktop-language-shared.js";
import { remoteListCommand, remoteTmuxCommand, splitTmuxFields, supportedTmuxVersion } from "./commands.js";
import { TmuxConnection, type TmuxConnectionOptions, type TmuxListeners, type TmuxLog } from "./connection.js";
import { TMUX_MAX_CONNECTIONS_PER_WINDOW, type TmuxAttachInput, type TmuxAttachResult, type TmuxCommandInput, type TmuxSessionsInput, type TmuxSessionsResult } from "./tmux-shared.js";

export type TmuxSpawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface TmuxManagerOptions {
  connections: RemoteConnectionManager;
  spawnControl?: TmuxSpawn;
  log?: TmuxLog;
  batchOptions?: TmuxConnectionOptions["batchOptions"];
  detachTimeoutMs?: number;
}
export class TmuxControlManager {
  #connections = new Map<string, TmuxConnection>();
  #pending = new Map<string, { windowId: number; result: Promise<TmuxAttachResult> }>();
  #windowEpochs = new Map<number, number>();
  #lists = new Map<ChildProcessWithoutNullStreams, number>();
  #closed = false;
  readonly #spawn: TmuxSpawn;
  constructor(readonly options: TmuxManagerOptions) { this.#spawn = options.spawnControl ?? ((file, args, options) => spawn(file, args, { ...options, stdio: "pipe" })); }
  #launch(targetId: string, command: string) {
    const remote = this.options.connections;
    const profile = remote.profile(targetId);
    const authentication = sshAuthenticationRequest(profile, remote.authentication(targetId));
    try {
      const child = this.#spawn(systemSshExecutable(), [...sshArguments(profile), command], { windowsHide: true, ...processGroupSpawnOptions(), env: { ...process.env, ...authentication?.env } });
      return { child, release: () => authentication?.dispose() };
    } catch (error) { authentication?.dispose(); throw error; }
  }
  async sessions(windowId: number, input: TmuxSessionsInput): Promise<TmuxSessionsResult> {
    if (this.#closed) throw new Error(desktopText("tmux 服务已关闭", "tmux manager closed"));
    this.options.connections.assertWritable(input.targetId);
    const remote = this.options.connections.get(input.targetId);
    if (remote.environment.platform === "win32") return { available: false, reason: "remote-windows", message: desktopText("tmux 需要 POSIX 系统的 SSH 目标", "tmux requires a POSIX SSH target") };
    let listing: { child: ChildProcessWithoutNullStreams; release(): void };
    try { listing = this.#launch(input.targetId, remoteListCommand()); }
    catch (error) { return { available: false, reason: "ssh-failed", message: String(error) }; }
    const { child, release } = listing;
    this.#lists.set(child, windowId);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []; let length = 0;
        const timer = setTimeout(() => { terminateProcessTree(child); reject(new Error(desktopText("读取 SSH 会话列表超时", "SSH session listing timed out"))); }, 15_000);
        const data = (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1024) { terminateProcessTree(child); reject(new Error(desktopText("tmux 会话列表超过 64 KiB", "tmux session listing exceeds 64 KiB"))); }
          else chunks.push(chunk);
        };
        child.stdout.on("data", data); child.stderr.on("data", data);
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
        child.stdin.end();
      });
      if (output.includes("studio-tmux: not-installed")) return { available: false, reason: "not-installed", message: desktopText("该 SSH 目标未安装 tmux", "tmux is not installed on this SSH target") };
      const lines = output.split(/\r?\n/), versionLine = lines.findIndex(line => /^tmux \S+$/.test(line));
      if (versionLine < 0) return { available: false, reason: "ssh-failed", message: output.slice(-2048) || desktopText("读取 SSH 会话列表失败", "SSH session listing failed") };
      const version = lines[versionLine]!.slice(5);
      if (!supportedTmuxVersion(version)) return { available: false, reason: "too-old", version, message: desktopText("需要 tmux 3.2 或更高版本", "tmux 3.2 or later is required") };
      const sessions = lines.slice(versionLine + 1).filter(line => /^\$\d+\t/.test(line)).map(line => {
        const [id, attached, windows, created, name] = splitTmuxFields(line, 5);
        return { id: id!, attached: Number(attached), windows: Number(windows), createdAt: Number(created) * 1000, name: name! };
      });
      return { available: true, version, sessions };
    } catch (error) { return { available: false, reason: "ssh-failed", message: error instanceof Error ? error.message : String(error) }; }
    finally { this.#lists.delete(child); release(); }
  }
  attach(windowId: number, input: TmuxAttachInput, listeners: TmuxListeners): Promise<TmuxAttachResult> {
    const key = JSON.stringify([windowId, input.targetId, input.session ?? input.workspaceId]);
    const pending = this.#pending.get(key);
    if (pending) return pending.result;
    const current = [...this.#connections.values()].find(connection => connection.options.windowId === windowId && connection.topology.targetId === input.targetId && connection.alive && connection.topology.session?.name === input.session);
    if (current) return Promise.resolve({ connectionId: current.options.id });
    const result = this.#attach(windowId, input, listeners).finally(() => this.#pending.delete(key));
    this.#pending.set(key, { windowId, result });
    return result;
  }
  async #attach(windowId: number, input: TmuxAttachInput, listeners: TmuxListeners): Promise<TmuxAttachResult> {
    if (this.#closed) throw new Error(desktopText("tmux 服务已关闭", "tmux manager closed"));
    const connections = this.options.connections;
    connections.assertWritable(input.targetId);
    const count = [...this.#connections.values()].filter(connection => connection.options.windowId === windowId && connection.alive).length + [...this.#pending.values()].filter(value => value.windowId === windowId).length;
    if (count >= TMUX_MAX_CONNECTIONS_PER_WINDOW) throw new Error(desktopText("每个 Studio 窗口最多附加 4 个 tmux 连接", "Each Studio window can attach up to 4 tmux connections"));
    const epoch = this.#windowEpochs.get(windowId) ?? 0;
    const remote = connections.get(input.targetId);
    if (remote.environment.platform === "win32") throw new Error(desktopText("Windows SSH 目标不支持 tmux", "Windows SSH targets do not support tmux"));
    const { path } = await remote.transport.peer.request<{ path: string }>("workspace.path", { workspaceId: input.workspaceId });
    if (this.#closed || epoch !== (this.#windowEpochs.get(windowId) ?? 0)) throw new Error(desktopText("终端窗口已关闭", "Terminal window has closed"));
    connections.assertWritable(input.targetId);
    if (connections.get(input.targetId) !== remote) throw new Error(desktopText("附加 tmux 期间 SSH 连接已变更", "SSH connection changed while attaching tmux"));
    const session = input.session ?? `studio-${path.split("/").filter(Boolean).at(-1) ?? "work"}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
    const existing = [...this.#connections.values()].find(connection => connection.options.windowId === windowId && connection.topology.targetId === input.targetId && connection.alive && connection.topology.session?.name === session);
    if (existing) return { connectionId: existing.options.id };
    const { child, release } = this.#launch(input.targetId, remoteTmuxCommand(session, path));
    const connectionId = randomBytes(16).toString("base64url");
    const connection = new TmuxConnection({ id: connectionId, windowId, input, session, process: child, listeners, release, ...(this.options.log ? { log: this.options.log } : {}), ...(this.options.batchOptions ? { batchOptions: this.options.batchOptions } : {}), ...(this.options.detachTimeoutMs === undefined ? {} : { detachTimeoutMs: this.options.detachTimeoutMs }) });
    this.#connections.set(connectionId, connection);
    void connection.start();
    return { connectionId };
  }
  #pane(windowId: number, terminalId: string): TmuxConnection | undefined { return [...this.#connections.values()].find(connection => connection.options.windowId === windowId && connection.owns(terminalId)); }
  owns(windowId: number, terminalId: string): boolean { return !!this.#pane(windowId, terminalId); }
  write(windowId: number, terminalId: string, data: string): void { this.#pane(windowId, terminalId)?.write(terminalId, data); }
  acknowledge(windowId: number, terminalId: string, bytes: number): void { this.#pane(windowId, terminalId)?.acknowledge(terminalId, bytes); }
  command(windowId: number, input: TmuxCommandInput): Promise<void> {
    const connection = this.#connections.get(input.connectionId);
    if (connection?.options.windowId !== windowId) throw new Error(desktopText("未知的 tmux 连接", "Unknown tmux connection"));
    return connection.command(input.action);
  }
  hasTarget(targetId: string): boolean { return [...this.#connections.values()].some(connection => connection.topology.targetId === targetId && connection.alive); }
  async detach(windowId: number, connectionId: string, timeoutMs?: number): Promise<void> {
    const connection = this.#connections.get(connectionId);
    if (connection?.options.windowId !== windowId) return;
    await connection.detach(timeoutMs);
    this.#connections.delete(connectionId);
  }
  async disposeWindow(windowId: number): Promise<void> {
    this.#windowEpochs.set(windowId, (this.#windowEpochs.get(windowId) ?? 0) + 1);
    for (const [child, owner] of this.#lists) if (owner === windowId) terminateProcessTree(child);
    await Promise.all([...this.#connections.values()].filter(connection => connection.options.windowId === windowId).map(connection => this.detach(windowId, connection.options.id)));
  }
  async disposeAll(): Promise<void> {
    this.#closed = true;
    for (const child of this.#lists.keys()) terminateProcessTree(child);
    await Promise.all([...this.#connections.values()].map(connection => this.detach(connection.options.windowId, connection.options.id, 1000)));
  }
}
