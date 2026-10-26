import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { createWindowsBridgeAclPort } from "@omp-studio/studio-host";

export type RemotePlatform = "linux" | "win32" | "darwin";
export type RemoteShell = "posix" | "cmd" | "powershell";

export function remotePlatform(value: string): RemotePlatform {
  if (value === "linux" || value === "win32" || value === "darwin") return value;
  throw new Error(`Unsupported remote operating system: ${value}`);
}

export function remoteStateRoot(platform: RemotePlatform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "omp-studio", "remote");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "omp-studio", "remote");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "omp-studio", "remote");
}

export async function secureRemoteDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await createWindowsBridgeAclPort().secureDirectory(path);
  else await chmod(path, 0o700);
}

export function systemSshExecutable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== "win32") return "ssh";
  const path = win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
  if (!existsSync(path)) throw new Error("Windows OpenSSH Client is not installed. Enable it before connecting.");
  return path;
}

export interface SshConnection {
  readonly host: string;
  readonly authMode?: "agent" | "password";
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly proxyJump?: string;
}

export function sshArguments(connection: SshConnection): string[] {
  if (!connection.host || connection.host.startsWith("-") || /[\s\x00-\x1f\x7f]/u.test(connection.host)) throw new Error("Invalid SSH host or alias");
  for (const value of [connection.user, connection.identityFile, connection.proxyJump]) {
    if (value !== undefined && (!value || /[\x00-\x1f\x7f]/u.test(value))) throw new Error("Invalid SSH connection option");
  }
  if (connection.port !== undefined && (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)) throw new Error("Invalid SSH port");
  const password = connection.authMode === "password";
  const args = ["-T", "-o", `BatchMode=${password ? "no" : "yes"}`, "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  if (password) args.push("-o", "PreferredAuthentications=password", "-o", "PasswordAuthentication=yes", "-o", "PubkeyAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "NumberOfPasswordPrompts=1", "-o", "ControlMaster=no", "-o", "ControlPath=none");
  if (connection.user) args.push("-l", connection.user);
  if (connection.port) args.push("-p", String(connection.port));
  if (connection.identityFile) args.push("-i", connection.identityFile);
  if (connection.proxyJump) args.push("-J", connection.proxyJump);
  args.push(connection.host);
  return args;
}

function assertArgument(value: string): void {
  if (!value || /[\x00-\x1f\x7f]/u.test(value)) throw new Error("Invalid remote launch argument");
}

export function remoteLaunchCommand(shell: RemoteShell, executable: string, args: readonly string[]): string {
  const values = [executable, ...args];
  for (const value of values) assertArgument(value);
  if (shell === "posix") return `exec ${values.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ")}`;
  if (shell === "powershell") return `& ${values.map(value => `'${value.replaceAll("'", "''")}'`).join(" ")}`;
  // cmd expands percent/exclamation even inside quotes; refuse rather than silently change a path.
  if (values.some(value => /["%!\r\n]/u.test(value))) throw new Error("This path requires the PowerShell SSH shell adapter");
  return values.map(value => `"${value}"`).join(" ");
}
