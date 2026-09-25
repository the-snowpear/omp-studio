import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioClient, ClientBootstrap, CommandInput } from "@omp-studio/client-contract";
import { validateServiceSpec, type StudioServiceSpec, type StudioServiceRow, type WorkbenchResultMap } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_SERVICES, PREVIEW_SERVICE_SPEC } from "../preview/servicesPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import "./services.css";

type Definition = { id: string; revision: number; workspaceId: string; updatedAt: string; spec: StudioServiceSpec };
const emptySpec: StudioServiceSpec = { name: "", command: "", cwd: ".", pty: true, mode: "session", restart: "no" };

export function ServicesPane({ client, workspaceId, sessionId, available, capabilities }: {
  client?: StudioClient | undefined; workspaceId?: string | undefined; sessionId?: string | undefined;
  available: boolean; capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage: locale } = useI18n();
  const label = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<StudioServiceRow[]>([]);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [editing, setEditing] = useState<Definition>();
  const [spec, setSpec] = useState<StudioServiceSpec>(emptySpec);
  const [form, setForm] = useState(false);
  const [environment, setEnvironment] = useState("");
  const [selected, setSelected] = useState<StudioServiceRow>();
  const [logs, setLogs] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [confirm, setConfirm] = useState<{ kind: "services.stop" | "services.restart" | "services.mode.set"; row: StudioServiceRow; mode?: StudioServiceRow["mode"] }>();
  const generation = useRef(0);
  const canControl = preview || (available && !!client && capabilities?.capabilities.some(item => item.id === "services.start" && item.grade !== "unavailable") === true);
  const invoke = useCallback(async <K extends keyof WorkbenchResultMap>(kind: K, payload: CommandInput<K>): Promise<WorkbenchResultMap[K]> => {
    if (!client) throw new Error("Runtime is unavailable");
    const handle = await client.command(kind, payload);
    const value = await waitReceipt<{ result: WorkbenchResultMap[K] }>(client, handle.requestId,
      kind === "services.start" ? ((payload as CommandInput<"services.start">).spec.ready?.timeoutMs ?? 30000) + 15000 : 120000);
    return value.result;
  }, [client]);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    if (preview) { setRows(PREVIEW_SERVICES); return; }
    if (!available || !client) { setRows([]); return; }
    try {
      const value = await invoke("services.list", {});
      if (epoch !== generation.current) return;
      setRows(value.services); setEnabled(value.enabled);
      setSelected(current => current ? value.services.find(row => row.name === current.name) : undefined);
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Services unavailable")); }
  }, [preview, available, client, invoke]);
  const loadDefinitions = useCallback(async () => {
    const epoch = generation.current;
    if (preview) { setDefinitions([{ id: "preview", revision: 1, workspaceId: "preview", updatedAt: "", spec: PREVIEW_SERVICE_SPEC }]); return; }
    if (!workspaceId || !globalThis.ompStudioChrome?.listServiceDefinitions) { setDefinitions([]); return; }
    try {
      const value = await globalThis.ompStudioChrome.listServiceDefinitions({ workspaceId });
      if (epoch !== generation.current) return;
      if (!value.ok) throw new Error(value.message);
      setDefinitions(value.definitions);
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Saved configurations unavailable")); }
  }, [preview, workspaceId]);
  useEffect(() => {
    generation.current++; setSelected(undefined); setLogs(""); setError(""); setConfirm(undefined); setForm(false); setEnvironment(""); setSpec(emptySpec); setBusy(false);
    if (!open) return;
    void refresh(); void loadDefinitions();
    if (preview) return () => { generation.current++; };
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => { generation.current++; clearInterval(timer); };
  }, [open, sessionId, preview, refresh, loadDefinitions]);
  useEffect(() => {
    let active = true;
    setLogs("");
    if (!open || !selected) return;
    const load = async () => {
      if (preview) { setLogs("[demo] Server ready\n[demo] Watching workspace files…"); return; }
      try {
        const value = await invoke("services.logs", { name: selected.name, instanceId: selected.instanceId, lines: 300 });
        if (active) setLogs(value.text);
      } catch (cause) { if (active) setError(hostErrorMessage(cause, "Cannot read logs")); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [open, selected?.name, selected?.instanceId, preview, invoke]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    const epoch = generation.current;
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Service operation failed")); }
    finally { if (epoch === generation.current) setBusy(false); }
  };
  const draft = (): StudioServiceSpec => {
    const env = Object.fromEntries(environment.split("\n").filter(line => line.trim()).map(line => {
      const index = line.indexOf("="); if (index < 1) throw new Error("Use KEY=value for each environment variable");
      return [line.slice(0, index).trim(), line.slice(index + 1)];
    }));
    const value = { ...spec, ...(Object.keys(env).length ? { env } : { env: undefined }) };
    validateServiceSpec(value); return value;
  };
  const edit = (definition?: Definition) => {
    setEditing(definition); setSpec(definition?.spec ?? emptySpec);
    setEnvironment(Object.entries(definition?.spec.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n")); setForm(true);
  };
  const save = () => run(async () => {
    const value = draft();
    if (preview) { setDefinitions(current => [...current.filter(row => row.id !== editing?.id), { id: editing?.id ?? "demo-" + Date.now(), revision: 1, workspaceId: "preview", updatedAt: "", spec: value }]); setForm(false); return; }
    if (!workspaceId || !globalThis.ompStudioChrome?.saveServiceDefinition) throw new Error("Secure desktop storage is unavailable");
    const result = await globalThis.ompStudioChrome.saveServiceDefinition({ workspaceId, spec: value, ...(editing ? { id: editing.id, revision: editing.revision } : {}) });
    if (!result.ok) throw new Error(result.message);
    setDefinitions(result.definitions); setForm(false); setEnvironment("");
  });
  const start = (value: StudioServiceSpec) => run(async () => {
    validateServiceSpec(value);
    if (preview) { setRows(current => [...current.filter(row => row.name !== value.name), { name: value.name, instanceId: "demo-" + Date.now(), state: "running", mode: value.mode ?? "session", startedAt: Date.now(), restartCount: 0, outputBytes: 0 }]); return; }
    const result = await invoke("services.start", { spec: value });
    setSelected(result.service); setForm(false); setEnvironment(""); await refresh();
    if (result.readyTimedOut) setError(label("进程已启动，但就绪检查超时；请检查日志。", "Started, but readiness timed out. Check the logs."));
  });
  const confirmAction = () => run(async () => {
    if (!confirm) return;
    if (preview) setRows(current => current.map(row => row.name !== confirm.row.name ? row : { ...row, state: confirm.kind === "services.stop" ? "exited" : "running", mode: confirm.mode ?? row.mode }));
    else {
      const named = { name: confirm.row.name, instanceId: confirm.row.instanceId };
      if (confirm.kind === "services.mode.set") await invoke(confirm.kind, { ...named, mode: confirm.mode! });
      else await invoke(confirm.kind, named);
      await refresh();
    }
    setConfirm(undefined);
  });
  return <details className="services-pane" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label("服务", "Services")}{preview ? <span className="chip gray">{label("演示", "Demo")}</span> : null}<span className="muted">{label("工作区进程与保存配置", "Workspace processes and saved configurations")}</span></summary>
    {open ? <div className="services-content">
      <div className="services-toolbar"><p className="small muted">{label("默认随会话结束；保存配置不会启动进程。", "Session lifetime by default. Saving a configuration does not start it.")}</p><span className="spacer" /><button className="btn small" onClick={() => { setError(""); void refresh(); void loadDefinitions(); }}>{label("刷新", "Refresh")}</button><button className="btn small primary" onClick={() => edit()}>{label("新建服务", "New service")}</button></div>
      {!canControl ? <p className="small muted">{label("当前会话没有服务控制能力。连接更新后的 Runtime 并切回活动会话。", "Service control is unavailable. Connect the updated Runtime and open the active session.")}</p> : null}
      {!enabled ? <p role="status">{label("Runtime 已禁用服务启动（launch.enabled）。", "Service launch is disabled in Runtime (launch.enabled).")}</p> : null}
      {error ? <p role="alert" className="services-error">{error}</p> : null}
      <div className="service-table" role="list">
        {rows.map(row => <div role="listitem" className={`service-row${selected?.name === row.name ? " selected" : ""}`} key={row.name}>
          <button className="service-name" onClick={() => setSelected(row)}><b>{row.name}</b><span className="small muted">{row.state} · {row.mode} · {label("重启", "restarts")} {row.restartCount}{row.readyAt ? ` · ${label("已就绪", "ready")}` : ""}</span></button>
          <select aria-label={`${row.name} lifetime`} className="select" value={row.mode} disabled={busy || !canControl || ["exited", "failed"].includes(row.state)} onChange={event => setConfirm({ kind: "services.mode.set", row, mode: event.target.value as StudioServiceRow["mode"] })}><option value="session">{label("会话内", "Session")}</option><option value="persist">{label("持久化", "Persistent")}</option><option value="detached">{label("脱离运行", "Detached")}</option></select>
          <button className="btn small outline" disabled={busy || !canControl} onClick={() => setConfirm({ kind: "services.restart", row })}>{label("重启", "Restart")}</button><button className="btn small outline" disabled={busy || !canControl || ["exited", "failed"].includes(row.state)} onClick={() => setConfirm({ kind: "services.stop", row })}>{label("停止", "Stop")}</button>
        </div>)}
        {!rows.length ? <p className="small muted">{label("没有服务记录", "No service records")}</p> : null}
      </div>
      {confirm ? <div className="service-confirm" role="alertdialog" aria-label={label("确认服务操作", "Confirm service action")}><p>{confirm.row.name} · {confirm.kind === "services.mode.set" ? confirm.mode === "detached" ? label("将重启为后台进程，关闭会话后继续运行，并释放 PTY。", "Restart detached, release PTY, and continue after the session closes.") : confirm.mode === "persist" ? label("会话结束后继续运行。", "Continue after the session closes.") : label("恢复为会话生命周期。", "Restore session lifetime.") : confirm.kind === "services.stop" ? label("停止此服务？", "Stop this service?") : label("重启此服务？", "Restart this service?")}</p><button className="btn small primary" disabled={busy} onClick={() => void confirmAction()}>{label("确认", "Confirm")}</button><button className="btn small" onClick={() => setConfirm(undefined)}>{label("取消", "Cancel")}</button></div> : null}
      {selected ? <section className="service-log"><h4>{selected.name} · {label("日志", "Logs")}</h4><pre tabIndex={0}>{logs || label("暂无输出", "No output")}</pre><form onSubmit={event => { event.preventDefault(); void run(async () => { if (preview) setLogs(current => current + "\n[demo] " + input); else await invoke("services.send", { name: selected.name, instanceId: selected.instanceId, text: input + "\r" }); setInput(""); }); }}><input className="input" aria-label={label("服务标准输入", "Service input")} value={input} onChange={event => setInput(event.target.value)} maxLength={65535} /><button className="btn small" disabled={busy || !canControl || !input}>{label("发送输入", "Send input")}</button></form></section> : null}
      <h4>{label("保存的配置", "Saved configurations")}</h4>
      {!preview && !globalThis.ompStudioChrome?.saveServiceDefinition ? <p className="small muted">{label("此环境不提供加密配置存储。可以直接创建服务。", "Encrypted configuration storage is unavailable here. You can start services directly.")}</p> : null}
      {definitions.map(row => <div className="service-row" key={row.id}><button className="service-name" onClick={() => edit(row)}><b>{row.spec.name}</b><span className="small muted">{row.spec.mode ?? "session"} · {row.spec.restart ?? "no"}</span></button><button className="btn small primary" disabled={busy || !canControl || !enabled} onClick={() => { edit(row); }}>{label("打开 / 启动…", "Open / start…")}</button><button className="btn small" disabled={busy} onClick={() => void run(async () => { if (preview) { setDefinitions(current => current.filter(item => item.id !== row.id)); return; } const result = await globalThis.ompStudioChrome?.removeServiceDefinition?.({ workspaceId: row.workspaceId, id: row.id, revision: row.revision }); if (!result?.ok) throw new Error(result?.message ?? "Storage unavailable"); setDefinitions(result.definitions); })}>{label("删除配置", "Delete configuration")}</button></div>)}
      {form ? <form className="service-form" onSubmit={event => { event.preventDefault(); try { void start(draft()); } catch (cause) { setError(hostErrorMessage(cause, "Invalid service")); } }}>
        <label>{label("名称", "Name")}<input required className="input" value={spec.name} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,47}" onChange={event => setSpec({ ...spec, name: event.target.value })} /></label>
        <label>{label("工作区相对目录", "Workspace-relative directory")}<input className="input" value={spec.cwd ?? "."} onChange={event => setSpec({ ...spec, cwd: event.target.value })} /></label>
        <label className="service-wide">{label("命令", "Command")}<textarea required className="input mono" value={spec.command} onChange={event => setSpec({ ...spec, command: event.target.value })} rows={2} /></label>
        <label>{label("生命周期", "Lifetime")}<select className="select" value={spec.mode} onChange={event => setSpec({ ...spec, mode: event.target.value as StudioServiceSpec["mode"], pty: event.target.value !== "detached" && spec.pty })}><option value="session">{label("会话内（默认）", "Session (default)")}</option><option value="persist">{label("持久化", "Persistent")}</option><option value="detached">{label("脱离运行", "Detached")}</option></select></label>
        <label>{label("重启策略", "Restart policy")}<select className="select" value={spec.restart} onChange={event => setSpec({ ...spec, restart: event.target.value as StudioServiceSpec["restart"] })}><option value="no">{label("不重启", "Never")}</option><option value="on-failure">{label("失败时", "On failure")}</option><option value="always">{label("总是", "Always")}</option></select></label>
        <label className="service-wide"><span><input type="checkbox" checked={spec.pty ?? true} disabled={spec.mode === "detached"} onChange={event => setSpec({ ...spec, pty: event.target.checked })} /> PTY</span></label>
        <label>{label("就绪日志正则（可选）", "Ready log regex (optional)")}<input className="input" value={spec.ready?.log ?? ""} onChange={event => { const ready = { ...spec.ready, timeoutMs: spec.ready?.timeoutMs ?? 30000, log: event.target.value || undefined }; setSpec({ ...spec, ready: ready.log || ready.port ? ready : undefined }); }} /></label>
        <label>{label("就绪端口（可选）", "Ready port (optional)")}<input className="input" type="number" min={1} max={65535} value={spec.ready?.port ?? ""} onChange={event => { const ready = { ...spec.ready, timeoutMs: spec.ready?.timeoutMs ?? 30000, port: event.target.value ? Number(event.target.value) : undefined }; setSpec({ ...spec, ready: ready.log || ready.port ? ready : undefined }); }} /></label>
        {spec.ready ? <><label>{label("就绪主机", "Ready host")}<input className="input" value={spec.ready.host ?? "127.0.0.1"} onChange={event => setSpec({ ...spec, ready: { ...spec.ready!, host: event.target.value } })} /></label><label>{label("等待毫秒数", "Readiness timeout (ms)")}<input className="input" type="number" min={50} max={3600000} value={spec.ready.timeoutMs} onChange={event => setSpec({ ...spec, ready: { ...spec.ready!, timeoutMs: Number(event.target.value) } })} /></label></> : null}
        <details className="service-wide"><summary>{label("环境变量（本机加密保存）", "Environment variables (encrypted on this device)")}</summary><textarea aria-label="Environment KEY=value" className="input mono" spellCheck={false} autoComplete="off" value={environment} onChange={event => setEnvironment(event.target.value)} rows={3} placeholder="KEY=value" /></details>
        {spec.mode !== "session" ? <p className="service-wide small">{label("此服务将在会话结束后继续运行，需主动停止。脱离运行会关闭 PTY。", "This service continues after the session closes until you stop it. Detached mode disables PTY.")}</p> : null}
        <div className="service-wide services-toolbar"><button className="btn primary small" disabled={busy || !canControl || !enabled}>{label("启动服务", "Start service")}</button><button type="button" className="btn small outline" disabled={busy || (!preview && (!workspaceId || !globalThis.ompStudioChrome?.saveServiceDefinition))} onClick={() => void save()}>{label("仅保存配置", "Save configuration only")}</button><button type="button" className="btn small" onClick={() => { setForm(false); setEnvironment(""); setSpec(emptySpec); }}>{label("取消", "Cancel")}</button></div>
      </form> : null}
    </div> : null}
  </details>;
}
