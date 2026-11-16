import type { RemoteConnectionStatus } from "../../../desktop/src/remote/shared";
import { isZh } from "../i18n";

export function remoteStatusLabel(status?: RemoteConnectionStatus, zh = isZh()): string {
  if (status?.operation) return zh ? "安装中" : "Installing";
  switch (status?.state) {
    case "connected": return zh ? "已连接" : "Connected";
    case "connecting": return zh ? "连接中" : "Connecting";
    case "awaiting-approval": return zh ? "等待确认" : "Awaiting approval";
    case "recovering": return zh ? "恢复中" : "Recovering";
    case "degraded": return zh ? "响应迟缓" : "Degraded";
    case "synchronizing": return zh ? "同步中" : "Synchronizing";
    case "failed": return zh ? "连接失败" : "Connection failed";
    default: return zh ? "已断开" : "Disconnected";
  }
}

export function remoteConnectionPending(status?: RemoteConnectionStatus): boolean {
  return status !== undefined && ["connecting", "awaiting-approval", "recovering", "degraded", "synchronizing"].includes(status.state);
}
