import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { RemoteConnectionError, connectionCancelled, sshFailure } from "./errors.js";
import { remoteSpawn } from "./channel.js";
import { sshArguments, systemSshExecutable, type RemotePlatform, type SshConnection } from "./platform.js";
import { runSsh } from "./deploy.js";
import { powershellCommand, quotePs, quoteSh } from "./probe.js";
import type { SshAuthentication } from "./authentication.js";

export type RemoteUploadRoute = "ssh-stream" | "sftp" | "scp-legacy";
export type RemoteUploadProgress = (receivedBytes: number, totalBytes: number) => void;

export interface RemoteFileUpload {
  connection: SshConnection;
  platform: RemotePlatform;
  localPath: string;
  remotePath: string;
  remoteDirectory: string;
  signal?: AbortSignal;
  authentication?: SshAuthentication;
  progress?: RemoteUploadProgress;
}

const INACTIVITY_TIMEOUT_MS = 30_000;
const PROGRESS_POLL_MS = 5_000;
const ROUTE_TIMEOUT_MS = 600_000;

interface TransferLaunch { file: string; args: string[]; env?: NodeJS.ProcessEnv; dispose(): void; }
interface TransferResult { stdout: string; stderr: string; }

class UploadAttemptError extends Error {
  constructor(readonly route: RemoteUploadRoute, readonly retryable: boolean, message: string) { super(message); }
}

export function remoteUploadRoutes(platform: RemotePlatform, connectionKind?: SshConnection["kind"]): RemoteUploadRoute[] {
  if (connectionKind === "wsl") return ["ssh-stream"];
  return platform === "win32" ? ["sftp", "scp-legacy"] : ["ssh-stream", "sftp"];
}

export function hasUploadStalled(lastProgressAt: number, now = Date.now()): boolean {
  return now - lastProgressAt >= INACTIVITY_TIMEOUT_MS;
}

function target(connection: SshConnection, user?: string): string {
  const login = user ?? connection.user;
  return login ? `${login}@${connection.host}` : connection.host;
}

function connectionArgs(connection: SshConnection): { options: string[]; login?: string } {
  const source = sshArguments(connection);
  const options: string[] = [];
  let login: string | undefined;
  for (let index = 0; index < source.length; index++) {
    const argument = source[index]!;
    if (argument === "-T") continue;
    if (argument === "-l") { login = source[++index]; continue; }
    if (argument === "-p") { options.push("-P", source[++index]!); continue; }
    if (index === source.length - 1) break;
    options.push(argument);
  }
  return { options, ...(login ? { login } : {}) };
}

export function sftpArguments(connection: SshConnection): string[] {
  const { options, login } = connectionArgs(connection);
  // OpenSSH's -b adds BatchMode=yes. The first value wins, so pass our
  // explicit authentication mode before enabling the SFTP batch input.
  return [...options, "-b", "-", target(connection, login)];
}

export function scpLegacyArguments(connection: SshConnection, localPath: string, remotePath: string, platform: RemotePlatform): string[] {
  const { options, login } = connectionArgs(connection);
  return ["-O", ...options, localPath, `${target(connection, login)}:${scpRemotePath(remotePath, platform)}`];
}

export function sftpRemotePath(path: string, platform: RemotePlatform): string {
  if (platform !== "win32") return path;
  const normalized = path.replaceAll("\\", "/");
  return /^[A-Za-z]:\//u.test(normalized) ? `/${normalized}` : normalized;
}

export function sftpQuote(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return `"${normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function scpRemotePath(path: string, platform: RemotePlatform): string {
  const normalized = platform === "win32" ? path.replaceAll("\\", "/") : path;
  return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function launchSftp(connection: SshConnection, authentication: SshAuthentication | undefined): TransferLaunch {
  const request = connection.authMode === "password" ? authentication?.request() : undefined;
  if (connection.authMode === "password" && !request) throw new RemoteConnectionError("authentication", "SSH password authentication is unavailable");
  const file = process.platform === "win32" ? systemSshExecutable().replace(/ssh\.exe$/iu, "sftp.exe") : "sftp";
  return { file, args: sftpArguments(connection), ...(request ? { env: request.env } : {}), dispose: () => request?.dispose() };
}

function launchLegacyScp(connection: SshConnection, authentication: SshAuthentication | undefined, localPath: string, remotePath: string, platform: RemotePlatform): TransferLaunch {
  const request = connection.authMode === "password" ? authentication?.request() : undefined;
  if (connection.authMode === "password" && !request) throw new RemoteConnectionError("authentication", "SSH password authentication is unavailable");
  const file = process.platform === "win32" ? systemSshExecutable().replace(/ssh\.exe$/iu, "scp.exe") : "scp";
  return { file, args: scpLegacyArguments(connection, localPath, remotePath, platform), ...(request ? { env: request.env } : {}), dispose: () => request?.dispose() };
}

function remoteDirectoryCommand(platform: RemotePlatform, directory: string): string {
  return platform === "win32"
    ? powershellCommand(`$ErrorActionPreference='Stop';New-Item -ItemType Directory -Path ${quotePs(directory)} -Force | Out-Null`)
    : `mkdir -p ${quoteSh(directory)}`;
}

function remoteSizeCommand(platform: RemotePlatform, path: string): string {
  return platform === "win32"
    ? powershellCommand(`$ErrorActionPreference='Stop';if(Test-Path -LiteralPath ${quotePs(path)} -PathType Leaf){[Console]::Out.Write((Get-Item -LiteralPath ${quotePs(path)}).Length)}else{[Console]::Out.Write('0')}`)
    : `if [ -f ${quoteSh(path)} ]; then wc -c < ${quoteSh(path)}; else printf '0\\n'; fi`;
}

function remoteVerifyCommand(platform: RemotePlatform, path: string): string {
  if (platform === "win32") return powershellCommand(`$ErrorActionPreference='Stop';$f=Get-Item -LiteralPath ${quotePs(path)} -ErrorAction Stop;$h=(Get-FileHash -LiteralPath ${quotePs(path)} -Algorithm SHA256).Hash.ToLowerInvariant();[Console]::Out.WriteLine('__OMP_UPLOAD__|' + $f.Length + '|' + $h)`);
  const hashCommand = platform === "darwin" ? "shasum -a 256" : "sha256sum";
  return `set -e; size=$(wc -c < ${quoteSh(path)} | tr -d ' '); hash=$(${hashCommand} ${quoteSh(path)} | cut -d ' ' -f1); printf '__OMP_UPLOAD__|%s|%s\\n' "$size" "$hash"`;
}

function remoteCommitCommand(platform: RemotePlatform, source: string, destination: string): string {
  return platform === "win32"
    ? powershellCommand(`[IO.File]::Move(${quotePs(source)},${quotePs(destination)})`)
    : `mv -- ${quoteSh(source)} ${quoteSh(destination)}`;
}

function remoteRemoveCommand(platform: RemotePlatform, path: string): string {
  return platform === "win32"
    ? powershellCommand(`if(Test-Path -LiteralPath ${quotePs(path)} -PathType Leaf){[IO.File]::Delete(${quotePs(path)})}`)
    : `rm -f -- ${quoteSh(path)}`;
}

function isNonRetryableDiagnostic(diagnostics: string): boolean {
  return /(?:Permission denied|Access is denied|No such (?:file|directory)|cannot find the path|The system cannot find the path|Not a directory|Is a directory|Couldn't (?:open|stat) remote|Failure:.*(?:permission|path))/iu.test(diagnostics);
}

function connectionFailure(diagnostics: string, exitCode: number | null): RemoteConnectionError | undefined {
  if (!/(?:REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|Offending .* key|Permission denied|Authentication failed|Too many authentication failures|No more authentication methods|Could not resolve hostname|Bad configuration|Bad owner or permissions|Bad port|Bad .*option|no matching (?:host key|key exchange|cipher|MAC)|account (?:is )?locked|password (?:has )?expired|Connection timed out|Connection reset|Connection refused|No route to host|Network is unreachable|Temporary failure in name resolution)/iu.test(diagnostics)) return undefined;
  return sshFailure(diagnostics, undefined, exitCode);
}

function isTerminalConnectionError(error: unknown): error is RemoteConnectionError {
  return error instanceof RemoteConnectionError && ["authentication", "host-key", "configuration", "cancelled"].includes(error.connectionCode);
}

export function isRetryableUploadFailure(error: unknown): boolean {
  if (isTerminalConnectionError(error)) return false;
  if (error instanceof UploadAttemptError) return error.retryable;
  return error instanceof RemoteConnectionError && error.connectionCode === "network";
}

export async function runUploadFallback<T>(
  routes: readonly RemoteUploadRoute[],
  attempt: (route: RemoteUploadRoute) => Promise<T>,
  cleanup: (route: RemoteUploadRoute) => Promise<void>,
): Promise<{ route: RemoteUploadRoute; value: T }> {
  const failures: string[] = [];
  for (const route of routes) {
    try { return { route, value: await attempt(route) }; }
    catch (error) {
      if (!isTerminalConnectionError(error) || error.connectionCode === "cancelled") await cleanup(route).catch(() => {});
      if (!isRetryableUploadFailure(error)) throw error;
      failures.push(`${route}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new RemoteConnectionError("network", `SSH file upload failed on all available routes: ${failures.join("; ")}`);
}

async function runTransferProcess(
  route: RemoteUploadRoute,
  launch: TransferLaunch,
  input: "archive" | "sftp-batch" | "none",
  localPath: string,
  remotePath: string,
  options: RemoteFileUpload,
  totalBytes: number,
): Promise<TransferResult> {
  options.signal?.throwIfAborted();
  return new Promise<TransferResult>((resolve, reject) => {
    const child = spawn(launch.file, launch.args, { stdio: "pipe", windowsHide: true, env: launch.env });
    const monitor = new AbortController();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let checking = false;
    let lastSize = 0;
    let lastProgressAt = Date.now();
    let stopReason: "idle" | "timeout" | undefined;
    let source: ReturnType<typeof createReadStream> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(routeTimer);
      monitor.abort();
      options.signal?.removeEventListener("abort", abort);
      if (source) { source.unpipe(child.stdin); source.destroy(); }
      launch.dispose();
      if (error) { child.kill(); reject(error); } else resolve({ stdout, stderr });
    };
    const abort = (): void => { child.kill(); finish(connectionCancelled()); };
    const routeTimer = setTimeout(() => { stopReason = "timeout"; child.kill(); }, ROUTE_TIMEOUT_MS);
    const pollTimer = setInterval(() => {
      if (checking || settled || stopReason) return;
      checking = true;
      void runSsh(options.connection, remoteSizeCommand(options.platform, remotePath), undefined, 8_000, monitor.signal, options.authentication).then(value => {
        const size = Number(value.trim());
        if (Number.isSafeInteger(size) && size > lastSize) {
          lastSize = size;
          lastProgressAt = Date.now();
          options.progress?.(Math.min(size, totalBytes), totalBytes);
        }
      }).catch(() => {}).finally(() => {
        checking = false;
        if (!settled && !stopReason && hasUploadStalled(lastProgressAt)) {
          stopReason = "idle";
          child.kill();
        }
      });
    }, PROGRESS_POLL_MS);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout = (stdout + String(chunk)).slice(-8192); });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    child.once("error", error => finish(new UploadAttemptError(route, true, `${route} executable failed (${(error as NodeJS.ErrnoException).code ?? "error"})`)));
    child.stdin.on("error", error => { if (!["EPIPE", "EOF", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) finish(error); });
    child.once("close", code => {
      if (stopReason === "idle") { finish(new UploadAttemptError(route, true, "No remote file growth for 30 seconds")); return; }
      if (stopReason === "timeout") { finish(new UploadAttemptError(route, true, "Upload route exceeded its 10 minute limit")); return; }
      if (code !== 0) {
        const failure = connectionFailure(stderr, code);
        if (failure && isTerminalConnectionError(failure)) { finish(failure); return; }
        if (isNonRetryableDiagnostic(stderr)) { finish(new UploadAttemptError(route, false, stderr.trim() || `Remote ${route} operation failed`)); return; }
        finish(new UploadAttemptError(route, true, stderr.trim() || `${route} exited with code ${code}`));
        return;
      }
      finish(undefined);
    });
    if (options.signal?.aborted) { abort(); return; }
    if (input === "archive") {
      source = createReadStream(localPath);
      source.once("error", error => finish(error));
      source.pipe(child.stdin);
    } else if (input === "sftp-batch") {
      const batch = `put ${sftpQuote(localPath)} ${sftpQuote(sftpRemotePath(remotePath, options.platform))}\n`;
      child.stdin.end(batch);
    } else child.stdin.end();
  });
}

async function remoteFileSize(options: RemoteFileUpload, route: RemoteUploadRoute, path: string): Promise<number> {
  const value = await runSsh(options.connection, remoteSizeCommand(options.platform, path), undefined, 10_000, options.signal, options.authentication);
  const size = Number(value.trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new UploadAttemptError(route, true, "Could not read remote upload size");
  return size;
}

async function verifyRemoteFile(options: RemoteFileUpload, route: RemoteUploadRoute, path: string, size: number, sha256: string): Promise<void> {
  const output = await runSsh(options.connection, remoteVerifyCommand(options.platform, path), undefined, 30_000, options.signal, options.authentication);
  const match = /__OMP_UPLOAD__\|(\d+)\|([a-f0-9]{64})/u.exec(output);
  if (!match || Number(match[1]) !== size || match[2] !== sha256) throw new UploadAttemptError(route, true, "Remote upload size or SHA-256 verification failed");
}

async function executeRoute(route: RemoteUploadRoute, options: RemoteFileUpload, temporaryPath: string, totalBytes: number): Promise<void> {
  let launch: TransferLaunch;
  let input: "archive" | "sftp-batch" | "none";
  if (route === "ssh-stream") {
    const command = options.platform === "win32"
      ? powershellCommand(`$ErrorActionPreference='Stop';$o=[IO.File]::OpenWrite(${quotePs(temporaryPath)});try{[Console]::OpenStandardInput().CopyTo($o)}finally{$o.Dispose()}`)
      : `umask 077; cat > ${quoteSh(temporaryPath)}`;
    launch = remoteSpawn(options.connection, command, options.authentication);
    input = "archive";
  } else if (route === "sftp") {
    launch = launchSftp(options.connection, options.authentication);
    input = "sftp-batch";
  } else {
    launch = launchLegacyScp(options.connection, options.authentication, options.localPath, temporaryPath, options.platform);
    input = "none";
  }
  await runTransferProcess(route, launch, input, options.localPath, temporaryPath, options, totalBytes);
}

export async function uploadRemoteFile(options: RemoteFileUpload): Promise<{ route: RemoteUploadRoute; bytes: number; sha256: string }> {
  options.signal?.throwIfAborted();
  const localHash = createHash("sha256");
  let totalBytes = 0;
  for await (const chunk of createReadStream(options.localPath)) { totalBytes += chunk.length; localHash.update(chunk); }
  const sha256 = localHash.digest("hex");
  const directoryCommand = remoteDirectoryCommand(options.platform, options.remoteDirectory);
  await runSsh(options.connection, directoryCommand, undefined, 30_000, options.signal, options.authentication);

  const routes = remoteUploadRoutes(options.platform, options.connection.kind);
  const temporaryPaths = new Map(routes.map(route => [route, `${options.remotePath}.omp-upload-${randomUUID()}`] as const));
  const transfer = await runUploadFallback(routes, async route => {
    options.signal?.throwIfAborted();
    const temporaryPath = temporaryPaths.get(route)!;
    options.progress?.(0, totalBytes);
    await executeRoute(route, options, temporaryPath, totalBytes);
    const received = await remoteFileSize(options, route, temporaryPath);
    if (received !== totalBytes) throw new UploadAttemptError(route, true, `Remote upload size mismatch (${received}/${totalBytes} bytes)`);
    await verifyRemoteFile(options, route, temporaryPath, totalBytes, sha256);
    return temporaryPath;
  }, async route => {
    const temporaryPath = temporaryPaths.get(route);
    if (temporaryPath) await runSsh(options.connection, remoteRemoveCommand(options.platform, temporaryPath), undefined, 10_000, undefined, options.authentication);
  });
  try {
    await runSsh(options.connection, remoteCommitCommand(options.platform, transfer.value, options.remotePath), undefined, 30_000, options.signal, options.authentication);
  } catch (error) {
    await runSsh(options.connection, remoteRemoveCommand(options.platform, transfer.value), undefined, 10_000, undefined, options.authentication).catch(() => {});
    if (options.signal?.aborted) throw connectionCancelled();
    throw error;
  }
  options.progress?.(totalBytes, totalBytes);
  return { route: transfer.route, bytes: totalBytes, sha256 };
}

export const REMOTE_UPLOAD_TIMING = { inactivityMs: INACTIVITY_TIMEOUT_MS, pollMs: PROGRESS_POLL_MS, routeTimeoutMs: ROUTE_TIMEOUT_MS } as const;
