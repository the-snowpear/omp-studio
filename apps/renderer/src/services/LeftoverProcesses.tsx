import { useEffect, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { StudioLeftoverProcess, StudioServiceRow } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_LEFTOVER_PROCESSES } from "../preview/servicesPreview";
import { hostErrorMessage } from "../hostError";
import { Callout } from "../workspaces/StatusBits";
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
  const unsupported = !preview && (!available || !supported);
  const started = (at: number) => new Date(at).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
  return <section className="leftover-processes" aria-label={zh ? "遗留后台进程" : "Leftover background processes"}>
    <header className="leftover-head">
      <div className="leftover-title">
        <h4>{zh ? "遗留后台进程" : "Leftover background processes"}{rows.length ? <span className="leftover-count">{rows.length}</span> : null}</h4>
        <p>{zh ? "Agent 停止后仍在运行、未被服务托管的进程。可接管为服务继续管理，或直接终止。" : "Processes still running after the agent stopped, outside any service. Adopt one to keep managing it, or terminate it."}</p>
      </div>
      {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      <button className="btn small ghost" type="button" disabled={busy || unsupported} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" extra="sm" />{zh ? "刷新" : "Refresh"}</button>
    </header>
    {error ? <Callout tone="error" role="alert">{error}</Callout> : null}
    {unsupported ? <p className="leftover-empty"><Icon name="plug" extra="sm" />{zh ? "此 Runtime 尚未提供遗留进程检测。" : "This Runtime does not provide leftover process detection."}</p>
      : !rows.length ? <p className="leftover-empty"><Icon name="check" extra="sm" />{zh ? "没有未托管的后台进程。" : "No unmanaged background processes."}</p> : null}
    {rows.length ? <ul className="leftover-list">{rows.map(row => <li className="leftover-row" key={`${row.pid}:${row.startedAt}`} data-adopting={adopting === row.pid || undefined}>
      <div className="leftover-main">
        <span className="leftover-icon" aria-hidden><Icon name="terminal" extra="sm" /></span>
        <div className="leftover-command">
          <code title={row.command}>{row.command}</code>
          <span className="leftover-meta">
            <span>PID {row.pid}</span>
            <span className="leftover-kind" data-kind={row.kind === "nohup" ? "nohup" : "background"} data-tip={row.ignoresSighup ? (zh ? "忽略挂断信号，退出终端后仍会运行" : "Ignores SIGHUP; keeps running after the terminal exits") : undefined}>{row.kind === "nohup" ? "nohup" : zh ? "后台进程" : "Background"}</span>
            <span>{zh ? `启动于 ${started(row.startedAt)}` : `Started ${started(row.startedAt)}`}</span>
          </span>
        </div>
        {adopting === row.pid ? null : <div className="leftover-actions">
          <button className="btn small outline" disabled={busy || !enabled} onClick={() => { setName(`process-${row.pid}`); setAdopting(row.pid); }}><Icon name="plus" extra="sm" />{zh ? "接管为服务" : "Adopt as service"}</button>
          <button className="btn small ghost danger" disabled={busy} onClick={() => void act(row, false)}>{zh ? "终止" : "Terminate"}</button>
        </div>}
      </div>
      {adopting === row.pid ? <form className="leftover-adopt" onSubmit={event => { event.preventDefault(); void act(row, true); }}>
        <span className="leftover-adopt-label">{zh ? "以服务名称接管" : "Adopt with service name"}</span>
        <input className="input" autoFocus required aria-label={zh ? "服务名称" : "Service name"} value={name} onChange={event => setName(event.target.value)} />
        <button className="btn small primary" disabled={busy || !name.trim()}>{zh ? "接管" : "Adopt"}</button>
        <button className="btn small ghost" type="button" disabled={busy} onClick={() => setAdopting(undefined)}>{zh ? "取消" : "Cancel"}</button>
      </form> : null}
    </li>)}</ul> : null}
  </section>;
}
