import { desktopText } from "../desktop-language-shared.js";

export type RemoteConnectionErrorCode = "network" | "cancelled" | "authentication" | "host-key" | "configuration" | "environment" | "host-unavailable" | "host-busy" | "replaced" | "protocol" | "unknown";

/** Only these locally authored messages may surface from SSH authentication diagnostics. */
export class RemoteConnectionError extends Error {
  constructor(readonly connectionCode: RemoteConnectionErrorCode, message: string) { super(message); this.name = "RemoteConnectionError"; }
}

export function connectionCancelled(noun = "SSH"): RemoteConnectionError { return new RemoteConnectionError("cancelled", desktopText(`${noun} 连接已取消`, `${noun} connection cancelled`)); }

export function sshFailure(diagnostics: string, fallback: unknown, exitCode?: number | null): RemoteConnectionError {
  if (fallback instanceof RemoteConnectionError && fallback.connectionCode !== "network") return fallback;
  const code = (fallback as NodeJS.ErrnoException | undefined)?.code;
  if ((fallback as Error | undefined)?.name === "AbortError") return connectionCancelled();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|Offending .* key/iu.test(diagnostics)) return new RemoteConnectionError("host-key", desktopText("SSH 主机密钥未受信任或已改变；请在系统 SSH 中核对指纹后重试，应用不会自动接受", "SSH host key is untrusted or changed; please verify the fingerprint in system SSH and retry (the app will not accept it automatically)"));
  if (/Permission denied|Authentication failed|Too many authentication failures|No more authentication methods|account (?:is )?locked|password (?:has )?expired/iu.test(diagnostics)) return new RemoteConnectionError("authentication", desktopText("SSH 认证被拒绝；请检查账号、认证方式及服务器登录设置，未自动重试密码", "SSH authentication was rejected; please check your username, authentication method, and server login settings (password was not retried)"));
  if (/Could not resolve hostname/iu.test(diagnostics) && !/Temporary failure in name resolution/iu.test(diagnostics)) return new RemoteConnectionError("configuration", desktopText("SSH 主机名或配置别名无法解析；请检查主机地址及本机 SSH config 中的 Host 别名", "SSH hostname or alias could not be resolved; please check the host address and Host aliases in your local SSH config"));
  if (/Bad configuration|Bad owner or permissions|Bad port|Bad .*option|no matching (?:host key|key exchange|cipher|MAC)/iu.test(diagnostics)) return new RemoteConnectionError("configuration", desktopText("系统 SSH 配置、主机名或加密算法不兼容，请检查连接配置", "System SSH configuration, hostname, or cipher algorithm is incompatible; please check your connection settings"));
  if (/Remote Node\.js 22|node(?:\.exe)?[\s'"：:]+(?:command not found|not found)|(?:not recognized|不是内部或外部命令)/iu.test(diagnostics)) return new RemoteConnectionError("environment", desktopText("远端需要可从 SSH 登录环境启动的 Node.js 22 或更新版本", "Remote machine requires Node.js 22 or newer available in the SSH login environment"));
  if (/Unsupported remote system/iu.test(diagnostics)) return new RemoteConnectionError("environment", desktopText("远端系统不受支持；需要 Linux、Windows 或 macOS", "Unsupported remote operating system; requires Linux, Windows, or macOS"));
  if (/already has an attached client|Disconnect the other desktop/iu.test(diagnostics)) return new RemoteConnectionError("host-busy", desktopText("远端 Host 已被其他桌面连接占用；不会强制断开对方", "Remote Host is already in use by another desktop connection and will not be forcibly disconnected"));
  if (/Installed Host bundle is corrupt|Host bundle checksum mismatch/iu.test(diagnostics)) return new RemoteConnectionError("environment", desktopText("远端 Host 文件校验失败；停止连接，未覆盖现有文件", "Remote Host bundle checksum verification failed; stopping connection without overwriting existing files"));
  if (/\b(?:ENOTDIR|EISDIR)\b|\bEEXIST\b[^\r\n]*\bmkdir\b/iu.test(diagnostics)) return new RemoteConnectionError("environment", desktopText("远端 Host 数据目录被同名文件占用；请备份并处理冲突文件后重新连接", "Remote Host data directory path is blocked by an existing file; please back up and remove the conflicting file before reconnecting"));
  if (/Remote work or an approval is still pending/iu.test(diagnostics)) return new RemoteConnectionError("host-busy", desktopText("远端仍有任务或审批，不能更新 Host；请先完成远端工作", "Remote work or an approval is still pending; finish remote tasks before updating the Host"));
  if (code === "ENOENT") return new RemoteConnectionError("configuration", desktopText("系统 OpenSSH 或所需的本地连接组件不存在", "System OpenSSH or required local connection helper was not found"));
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EOF", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"].includes(code ?? "") || /(?:Connection|Operation|connect to host|Connection to .*|kex_exchange_identification:.*) (?:timed out|refused|reset|closed)|Broken pipe|No route to host|Network is unreachable|Temporary failure in name resolution|Timeout, server|Connection reset by peer|Connection closed by/iu.test(diagnostics)) return new RemoteConnectionError("network", desktopText("SSH 网络连接中断或超时；远端任务结果需要恢复连接后核对", "SSH network connection interrupted or timed out; reconnect to verify remote task outcomes"));
  if (fallback instanceof RemoteConnectionError) return fallback;
  if (exitCode === 0) return new RemoteConnectionError("host-unavailable", desktopText("远端 Host 通道已退出；任务状态需要重新连接核对", "Remote Host channel exited; reconnect to verify task state"));
  return new RemoteConnectionError("unknown", desktopText("SSH 连接失败，未自动重试；请检查系统 SSH 和远端 Host 环境", "SSH connection failed and was not automatically retried; please check system SSH and the remote Host environment"));
}

export function wslFailure(diagnostics: string, fallback?: unknown, exitCode?: number | null): RemoteConnectionError {
  if (fallback instanceof RemoteConnectionError && fallback.connectionCode !== "network") return fallback;
  if ((fallback as NodeJS.ErrnoException)?.code === "ENOENT") return new RemoteConnectionError("configuration", desktopText("未安装 WSL", "WSL is not installed"));
  if (/WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name/iu.test(diagnostics)) return new RemoteConnectionError("configuration", desktopText("WSL 发行版不存在或已被移除", "WSL distribution does not exist or was removed"));
  if ((fallback as Error)?.name === "AbortError") return new RemoteConnectionError("cancelled", desktopText("WSL 连接已取消", "WSL connection cancelled"));
  if (fallback instanceof RemoteConnectionError) return fallback;
  return new RemoteConnectionError("network", desktopText("WSL 通道已断开，请重新连接以核对任务状态", "WSL channel disconnected. Reconnect to check task status.") + (exitCode == null ? "" : ` (${exitCode})`));
}

export function connectionFailure(error: unknown, kind?: "wsl" | "ssh"): RemoteConnectionError {
  if (error instanceof RemoteConnectionError) return error;
  if (kind === "wsl") return new RemoteConnectionError("environment", desktopText("WSL 工作区准备失败，请检查发行版和运行包", "WSL workspace preparation failed. Check the distribution and its runtime package."));
  return sshFailure("", error);
}
