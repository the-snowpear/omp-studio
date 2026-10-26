import type { RemoteConnectionStatus } from "../../../desktop/src/remote/shared";

export function remoteStatusLabel(status?: RemoteConnectionStatus): string {
  if (status?.operation) return "安装中";
  switch (status?.state) {
    case "connected": return "已连接";
    case "connecting": return "连接中";
    case "recovering": return "恢复中";
    case "degraded": return "响应迟缓";
    case "synchronizing": return "同步中";
    case "failed": return "连接失败";
    default: return "已断开";
  }
}

export function remoteConnectionPending(status?: RemoteConnectionStatus): boolean {
  return status !== undefined && ["connecting", "recovering", "degraded", "synchronizing"].includes(status.state);
}
