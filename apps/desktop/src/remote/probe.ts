import { posix, win32 } from "node:path";
import { runSsh } from "./deploy.js";
import type { RemoteEnvironment } from "./deploy.js";
import type { SshConnection } from "./platform.js";
import type { SshAuthentication } from "./authentication.js";
import { RemoteConnectionError } from "./errors.js";

export function powershellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
export const quoteSh = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const quotePs = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const POSIX_PROBE = `printf '__OMP_PROBE__\\n'; uname -s; uname -m; printf '%s\\n' "$HOME"; printf '%s\\n' "$XDG_DATA_HOME"; command -v tar || true; getconf GNU_LIBC_VERSION 2>/dev/null || true; df -Pk "$HOME" | tail -1`;
const WINDOWS_PROBE = `$ErrorActionPreference='Stop'; $arch=if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Write-Output '__OMP_WINDOWS__'; @{platform='win32';arch=$arch.ToLower();home=$env:USERPROFILE;root=(Join-Path $env:LOCALAPPDATA 'omp-studio\\remote');shell='powershell';freeBytes=(Get-PSDrive -Name ($env:USERPROFILE.Substring(0,1))).Free} | ConvertTo-Json -Compress`;

/** Bootstrap runs before there is a Node executable on the remote machine. */
export async function detectRemoteEnvironment(connection: SshConnection & { installRoot?: string }, signal?: AbortSignal, authentication?: SshAuthentication): Promise<RemoteEnvironment> {
  let output = "";
  try { output = await runSsh(connection, `sh -c ${quoteSh(POSIX_PROBE)}`, undefined, 30_000, signal, authentication); }
  catch (error) {
    if (signal?.aborted || error instanceof RemoteConnectionError && ["network", "authentication", "host-key", "cancelled"].includes(error.connectionCode)) throw error;
  }
  const fields = output.slice(output.indexOf("__OMP_PROBE__") + "__OMP_PROBE__".length).trim().split(/\r?\n/u);
  let environment: RemoteEnvironment;
  if (output.includes("__OMP_PROBE__") && /^(Linux|Darwin)$/u.test(fields[0] ?? "")) {
    const platform = fields[0] === "Darwin" ? "darwin" : "linux";
    const home = fields[2]!;
    const root = platform === "darwin" ? posix.join(home, "Library", "Application Support", "omp-studio", "remote") : posix.join(fields[3] || posix.join(home, ".local", "share"), "omp-studio", "remote");
    const arch = fields[1] === "x86_64" ? "x64" : ["aarch64", "arm64"].includes(fields[1] ?? "") ? "arm64" : fields[1]!;
    if (!fields[4]) throw new RemoteConnectionError("environment", "远端缺少 tar，无法解压私有运行环境");
    const libc = /glibc (\d+)\.(\d+)/u.exec(fields[5] ?? "");
    if (platform === "linux" && libc && (Number(libc[1]) < 2 || Number(libc[1]) === 2 && Number(libc[2]) < 28)) throw new RemoteConnectionError("environment", "远端 glibc 低于 2.28，无法运行随包 Node；请升级远端系统");
    environment = { platform, arch, home, root, node: "node", version: "", shell: "posix" };
  } else {
    output = await runSsh(connection, powershellCommand(WINDOWS_PROBE), undefined, 30_000, signal, authentication);
    const marker = output.indexOf("__OMP_WINDOWS__");
    if (marker < 0) throw new RemoteConnectionError("environment", "无法自动识别远端系统；需要 POSIX Shell 或 Windows PowerShell");
    const value = JSON.parse(output.slice(marker + "__OMP_WINDOWS__".length).trim()) as { arch: string; home: string; root: string };
    environment = { platform: "win32", arch: value.arch === "amd64" ? "x64" : value.arch, home: value.home, root: value.root, node: "node", version: "", shell: "powershell" };
  }
  if (!["x64", "arm64"].includes(environment.arch)) throw new RemoteConnectionError("environment", `不支持远端 CPU 架构：${environment.arch}`);
  if (connection.installRoot) {
    const paths = environment.platform === "win32" ? win32 : posix;
    if (!paths.isAbsolute(connection.installRoot)) throw new RemoteConnectionError("configuration", "安装目录必须是远端绝对路径");
    environment.root = connection.installRoot;
  }
  return environment;
}
