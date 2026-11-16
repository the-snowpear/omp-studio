import { useState } from "react";
import { useExecutionTarget } from "./ExecutionTargets";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { remoteConnectionPending, remoteStatusLabel } from "./remoteStatus";

export function RemoteScopeNotice() {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const target = useExecutionTarget();
  const { preview } = usePreviewMode();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!target.id || preview) return null;
  const status = target.inventory.statuses.find(value => value.id === target.id);
  const connected = status?.state === "connected";
  if (connected && !status.operation && !status.hostRestarted) return <div className="remote-scope-label" role="status">SSH · {target.name}</div>;
  const installing = status?.operation === "installing-runtime";
  const recovering = remoteConnectionPending(status);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className={`remote-scope-notice${recovering || connected || installing ? "" : " disconnected"}`} role="status" aria-live="polite">
    <span><strong>SSH · {target.name} · {remoteStatusLabel(status, zh)}</strong><br />
      {status?.message ?? (zh ? "连接已断开，未确认的命令不会自动重发。" : "Disconnected. Unconfirmed commands will not be resent automatically.")}
      {status?.attempt ? <small className="remote-retry-count">{zh ? `恢复尝试 ${status.attempt} / ${status.maxAttempts}${status.retryAt ? " · 退避等待中" : ""}` : `Recovery attempt ${status.attempt} / ${status.maxAttempts}${status.retryAt ? " · backing off" : ""}`}</small> : null}
    </span>
    {!installing && !connected ? <>
      {recovering || busy ? <button className="btn small outline" onClick={() => void target.cancelConnection(target.id!).catch(cause => setError(String(cause)))}>{zh ? (recovering ? "取消恢复" : "取消连接") : (recovering ? "Cancel recovery" : "Cancel connection")}</button> : <button className="btn small outline" onClick={() => void run(async () => { await target.connect(target.id!); await target.refresh(); })}>{target.syncError ? (zh ? "重新同步" : "Resync") : (zh ? "重新连接" : "Reconnect")}</button>}
      <button className="btn small" disabled={busy} onClick={() => void target.select(null).catch(cause => setError(String(cause)))}>{zh ? "此计算机" : "This computer"}</button>
    </> : null}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
