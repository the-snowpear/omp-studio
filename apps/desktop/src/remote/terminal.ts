import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { createNodePtySpawner, type PtyProcess, type PtySpawner, type TerminalSessionListeners } from "../terminal-pty.js";
import { TERMINAL_MAX_SESSIONS, type TerminalSessionInfo, type TerminalSize } from "../terminal-shared.js";
import { sshArguments, systemSshExecutable, type RemotePlatform } from "./platform.js";
import type { RemoteConnectionManager } from "./manager.js";
import { sshAuthenticationRequest } from "./authentication.js";

export function remoteTerminalCommand(platform: RemotePlatform, path: string): string {
  if (platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; try { Set-Location -LiteralPath '${path.replaceAll("'", "''")}' } catch { [Console]::Error.WriteLine($_); exit 1 }`;
    return `"powershell.exe -NoLogo -NoExit -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}"`;
  }
  return `cd '${path.replaceAll("'", "'\\''")}' && exec "\${SHELL:-/bin/sh}" -l`;
}

export class RemoteTerminalManager {
  readonly #sessions = new Map<string, { windowId: number; targetId: string; process: PtyProcess; cancelAuthentication(): void }>();
  readonly #pending = new Map<number, number>();
  readonly #windowEpochs = new Map<number, number>();
  #closed = false;

  constructor(readonly connections: RemoteConnectionManager, readonly pty: PtySpawner = createNodePtySpawner(true)) {}

  async create(windowId: number, targetId: string, workspaceId: string, size: TerminalSize, listeners: TerminalSessionListeners): Promise<TerminalSessionInfo> {
    if (this.#closed) throw new Error("Terminal manager is closed");
    this.connections.assertWritable(targetId);
    const count = [...this.#sessions.values()].filter(value => value.windowId === windowId).length + (this.#pending.get(windowId) ?? 0);
    if (count >= TERMINAL_MAX_SESSIONS) throw new Error("Too many SSH terminals");
    const epoch = this.#windowEpochs.get(windowId) ?? 0;
    this.#pending.set(windowId, (this.#pending.get(windowId) ?? 0) + 1);
    try {
      const remote = this.connections.get(targetId);
      const profile = this.connections.profile(targetId);
      const { path } = await remote.transport.peer.request<{ path: string }>("workspace.path", { workspaceId });
      if (this.#closed || epoch !== (this.#windowEpochs.get(windowId) ?? 0)) throw new Error("Terminal window has closed");
      this.connections.assertWritable(targetId);
      if (this.connections.get(targetId) !== remote) throw new Error("SSH connection changed while opening the terminal");
      const args = sshArguments(profile);
      args[0] = "-tt";
      args.push(remoteTerminalCommand(remote.environment.platform, path));
      const name = `SSH · ${profile.name}`;
      const authenticationRequest = sshAuthenticationRequest(profile, this.connections.authentication(targetId));
      let process: PtyProcess;
      try { process = this.pty.spawn({ file: systemSshExecutable(), args, name, cwd: homedir(), cols: size.cols, rows: size.rows, ...(authenticationRequest ? { env: authenticationRequest.env } : {}) }); }
      catch (error) { authenticationRequest?.dispose(); throw error; }
      const id = randomBytes(16).toString("base64url");
      this.#sessions.set(id, { windowId, targetId, process, cancelAuthentication: () => authenticationRequest?.dispose() });
      process.onData(data => listeners.onData({ id, data }));
      process.onExit(() => { authenticationRequest?.dispose(); this.#sessions.delete(id); listeners.onExit({ id }); });
      return { id, name, cwd: path };
    } finally {
      const remaining = (this.#pending.get(windowId) ?? 1) - 1;
      if (remaining > 0) this.#pending.set(windowId, remaining);
      else this.#pending.delete(windowId);
    }
  }

  hasTarget(targetId: string): boolean { return [...this.#sessions.values()].some(session => session.targetId === targetId); }
  owns(windowId: number, id: string): boolean { return this.#sessions.get(id)?.windowId === windowId; }
  write(windowId: number, id: string, data: string): void { if (this.owns(windowId, id)) this.#sessions.get(id)!.process.write(data); }
  resize(windowId: number, id: string, cols: number, rows: number): void { if (this.owns(windowId, id)) this.#sessions.get(id)!.process.resize(cols, rows); }
  dispose(windowId: number, id: string): void {
    if (!this.owns(windowId, id)) return;
    const session = this.#sessions.get(id)!;
    this.#sessions.delete(id);
    session.cancelAuthentication();
    session.process.kill();
  }
  disposeWindow(windowId: number): void {
    this.#windowEpochs.set(windowId, (this.#windowEpochs.get(windowId) ?? 0) + 1);
    for (const [id, session] of this.#sessions) if (session.windowId === windowId) this.dispose(windowId, id);
  }
  disposeAll(): void {
    this.#closed = true;
    for (const [id, session] of this.#sessions) this.dispose(session.windowId, id);
  }
}
