import { useEffect, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { StudioLeftoverProcess, StudioServiceRow } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_LEFTOVER_PROCESSES } from "../preview/servicesPreview";
import { hostErrorMessage } from "../hostError";
import { invokeServiceCommand } from "./serviceCommands";

export function LeftoverProcesses({ client, available, capabilities, visible, sessionId, onAdopted }: {
  client?: StudioClient | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  visible: boolean;
  sessionId?: string | undefined;
  onAdopted: (service?: StudioServiceRow) => void;
}) {
  const { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [rows, setRows] = useState<StudioLeftoverProcess[]>([]), [error, setError] = useState("");
  const [adopting, setAdopting] = useState<number>(), [name, setName] = useState(""), [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0), [enabled, setEnabled] = useState(true);
  const supported = capabilities?.capabilities.some(row => row.id === "services.leftovers.list" && row.grade !== "unavailable");
  useEffect(() => {
    setAdopting(undefined); setRows(preview ? PREVIEW_LEFTOVER_PROCESSES : []); setError("");
  }, [preview, sessionId]);
  useEffect(() => {
    if (preview || !visible || !available || !supported || !client) return;
    let active = true, reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await invokeServiceCommand(client, "services.leftovers.list", {});
        if (active) { setRows(result.leftovers); setEnabled(result.enabled); setError(""); }
      } catch (cause) { if (active) setError(hostErrorMessage(cause, zh ? "无法读取遗留进程" : "Cannot read leftover processes")); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [preview, visible, available, supported, client, sessionId, refresh, zh]);
  async function act(row: StudioLeftoverProcess, adopt: boolean) {
    setBusy(true); setError("");
    try {
      if (!preview) {
        if (adopt) await invokeServiceCommand(client, "services.leftovers.adopt", { pid: row.pid, name });
        else await invokeServiceCommand(client, "services.leftovers.terminate", { pids: [row.pid], includeNohup: row.kind === "nohup" });
      }
      setRows(current => current.filter(item => item.pid !== row.pid)); setAdopting(undefined);
      if (adopt) onAdopted(preview ? { name, instanceId: `preview-adopted-${row.pid}`, pid: row.pid, adopted: true, state: "running", startedAt: row.startedAt, restartCount: 0, outputBytes: 0, mode: "session", scope: "session" } : undefined);
    } catch (cause) { setError(hostErrorMessage(cause, zh ? "进程操作失败" : "Process action failed")); }
    finally { setBusy(false); }
  }
  return <section className="leftover-processes" aria-label={zh ? "遗留后台进程" : "Leftover background processes"}>
    <div className="services-toolbar"><h4>{zh ? "遗留后台进程" : "Leftover background processes"}</h4>
      {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      <button className="btn small ghost" type="button" disabled={busy || (!preview && (!available || !supported))} onClick={() => setRefresh(value => value + 1)}>{zh ? "刷新" : "Refresh"}</button>
    </div>
    {!preview && (!available || !supported) ? <p className="small muted">{zh ? "此 Runtime 尚未提供遗留进程检测。" : "This Runtime does not provide leftover process detection."}</p>
      : !rows.length ? <p className="small muted">{zh ? "没有未托管的后台进程。" : "No unmanaged background processes."}</p> : null}
    {error ? <p className="services-error" role="alert">{error}</p> : null}
    {rows.map(row => <div className="leftover-row" key={`${row.pid}:${row.startedAt}`}>
      <div className="leftover-command"><code>{row.command}</code><span className="small muted">PID {row.pid} · {row.kind === "nohup" ? "nohup" : zh ? "后台进程" : "Background"}</span></div>
      {adopting === row.pid ? <form onSubmit={event => { event.preventDefault(); void act(row, true); }}>
        <input className="input" autoFocus required aria-label={zh ? "服务名称" : "Service name"} value={name} onChange={event => setName(event.target.value)} />
        <button className="btn small primary" disabled={busy || !name.trim()}>{zh ? "接管" : "Adopt"}</button>
        <button className="btn small ghost" type="button" disabled={busy} onClick={() => setAdopting(undefined)}>{zh ? "取消" : "Cancel"}</button>
      </form> : <div className="feature-actions">
        <button className="btn small outline" disabled={busy || !enabled} onClick={() => { setName(`process-${row.pid}`); setAdopting(row.pid); }}>{zh ? "接管为服务" : "Adopt as service"}</button>
        <button className="btn small ghost" disabled={busy} onClick={() => void act(row, false)}>{zh ? "终止" : "Terminate"}</button>
      </div>}
    </div>)}
  </section>;
}
