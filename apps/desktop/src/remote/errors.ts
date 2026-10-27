export type RemoteConnectionErrorCode = "network" | "cancelled" | "authentication" | "host-key" | "configuration" | "environment" | "host-unavailable" | "host-busy" | "replaced" | "protocol" | "unknown";

/** Only these locally authored messages may surface from SSH authentication diagnostics. */
export class RemoteConnectionError extends Error {
  constructor(readonly connectionCode: RemoteConnectionErrorCode, message: string) { super(message); this.name = "RemoteConnectionError"; }
}

export function connectionCancelled(): RemoteConnectionError { return new RemoteConnectionError("cancelled", "SSH 连接已取消"); }

export function sshFailure(diagnostics: string, fallback: unknown, exitCode?: number | null): RemoteConnectionError {
  if (fallback instanceof RemoteConnectionError && fallback.connectionCode !== "network") return fallback;
  const code = (fallback as NodeJS.ErrnoException | undefined)?.code;
  if ((fallback as Error | undefined)?.name === "AbortError") return connectionCancelled();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|Offending .* key/iu.test(diagnostics)) return new RemoteConnectionError("host-key", "SSH 主机密钥未受信任或已改变；请在系统 SSH 中核对指纹后重试，应用不会自动接受");
  if (/Permission denied|Authentication failed|Too many authentication failures|No more authentication methods|account (?:is )?locked|password (?:has )?expired/iu.test(diagnostics)) return new RemoteConnectionError("authentication", "SSH 认证被拒绝；请检查账号、认证方式及服务器登录设置，未自动重试密码");
  if (/Could not resolve hostname/iu.test(diagnostics) && !/Temporary failure in name resolution/iu.test(diagnostics)) return new RemoteConnectionError("configuration", "SSH 主机名或配置别名无法解析；请检查主机地址及本机 SSH config 中的 Host 别名");
  if (/Bad configuration|Bad owner or permissions|Bad port|Bad .*option|no matching (?:host key|key exchange|cipher|MAC)/iu.test(diagnostics)) return new RemoteConnectionError("configuration", "系统 SSH 配置、主机名或加密算法不兼容，请检查连接配置");
  if (/Remote Node\.js 22|node(?:\.exe)?[\s'"：:]+(?:command not found|not found)|(?:not recognized|不是内部或外部命令)/iu.test(diagnostics)) return new RemoteConnectionError("environment", "远端需要可从 SSH 登录环境启动的 Node.js 22 或更新版本");
  if (/Unsupported remote system/iu.test(diagnostics)) return new RemoteConnectionError("environment", "远端系统不受支持；需要 Linux、Windows 或 macOS");
  if (/already has an attached client|Disconnect the other desktop/iu.test(diagnostics)) return new RemoteConnectionError("host-busy", "远端 Host 已被其他桌面连接占用；不会强制断开对方");
  if (/Installed Host bundle is corrupt|Host bundle checksum mismatch/iu.test(diagnostics)) return new RemoteConnectionError("environment", "远端 Host 文件校验失败；停止连接，未覆盖现有文件");
  if (/\b(?:ENOTDIR|EISDIR)\b|\bEEXIST\b[^\r\n]*\bmkdir\b/iu.test(diagnostics)) return new RemoteConnectionError("environment", "远端 Host 数据目录被同名文件占用；请备份并处理冲突文件后重新连接");
  if (/Remote work or an approval is still pending/iu.test(diagnostics)) return new RemoteConnectionError("host-busy", "远端仍有任务或审批，不能更新 Host；请先完成远端工作");
  if (code === "ENOENT") return new RemoteConnectionError("configuration", "系统 OpenSSH 或所需的本地连接组件不存在");
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EOF", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"].includes(code ?? "") || /(?:Connection|Operation|connect to host|Connection to .*|kex_exchange_identification:.*) (?:timed out|refused|reset|closed)|Broken pipe|No route to host|Network is unreachable|Temporary failure in name resolution|Timeout, server|Connection reset by peer|Connection closed by/iu.test(diagnostics)) return new RemoteConnectionError("network", "SSH 网络连接中断或超时；远端任务结果需要恢复连接后核对");
  if (fallback instanceof RemoteConnectionError) return fallback;
  if (exitCode === 0) return new RemoteConnectionError("host-unavailable", "远端 Host 通道已退出；任务状态需要重新连接核对");
  return new RemoteConnectionError("unknown", "SSH 连接失败，未自动重试；请检查系统 SSH 和远端 Host 环境");
}

export function connectionFailure(error: unknown): RemoteConnectionError {
  if (error instanceof RemoteConnectionError) return error;
  return sshFailure("", error);
}
