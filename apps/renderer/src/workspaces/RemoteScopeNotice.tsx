import { useState } from "react";
import { useExecutionTarget } from "./ExecutionTargets";
import { usePreviewMode } from "../preview/PreviewContext";
import { remoteConnectionPending, remoteStatusLabel } from "./remoteStatus";

export function RemoteScopeNotice() {
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
    <span><strong>SSH · {target.name} · {remoteStatusLabel(status)}</strong><br />
      {status?.message ?? "连接已断开，未确认的命令不会自动重发。"}
      {status?.attempt ? <small className="remote-retry-count">恢复尝试 {status.attempt} / {status.maxAttempts}{status.retryAt ? " · 退避等待中" : ""}</small> : null}
    </span>
    {!installing && !connected ? <>
      {recovering || busy ? <button className="btn small outline" onClick={() => void target.cancelConnection(target.id!).catch(cause => setError(String(cause)))}>取消{recovering ? "恢复" : "连接"}</button> : <button className="btn small outline" onClick={() => void run(async () => { await target.connect(target.id!); await target.refresh(); })}>{target.syncError ? "重新同步" : "重新连接"}</button>}
      <button className="btn small" disabled={busy} onClick={() => void target.select(null).catch(cause => setError(String(cause)))}>此计算机</button>
    </> : null}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
