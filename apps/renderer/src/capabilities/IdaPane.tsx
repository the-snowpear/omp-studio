import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "@omp-studio/client-contract";
import type { IdaEdit, StudioIdaResultMap, StudioIdaStatus } from "@omp-studio/studio-protocol";
import type { SessionOptionsProps } from "../models/SessionOptionsPane";
import { PREVIEW_IDA, PREVIEW_IDA_PYTHON, PREVIEW_IDA_RESULT } from "../preview/idaPreview";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { PLATFORM } from "../platform";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceDialog, WorkspaceEmpty, WorkspacePanel, WorkspaceStatus, WorkspaceTabs } from "../workspaces/Workspace";
import { IdaDatabaseTools } from "./IdaDatabaseTools";
import { CapabilityEditor } from "./CapabilityEditor";
import "./ida.css";

type Confirmation =
  | { kind: "configure"; enabled: boolean; installDir: string; python: string }
  | { kind: "open"; path: string }
  | { kind: "run"; id: string; code: string }
  | { kind: "save" | "close"; id: string };

export function IdaPane({ client, sessionId, available, visible = true, capabilities }: SessionOptionsProps) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<StudioIdaStatus>();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<"browse" | "python" | "info">("browse");
  const [configuration, setConfiguration] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [installDir, setInstallDir] = useState("");
  const [python, setPython] = useState("");
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, StudioIdaResultMap["ida.run"]>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<Confirmation>();
  const [loading, setLoading] = useState(false);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation>();
  const [refreshKey, setRefreshKey] = useState(0);
  const epoch = useRef(0), lock = useRef(false), configLoaded = useRef(false), readSerial = useRef(0);
  const busy = operation !== undefined || toolsBusy;
  const can = (kind: string) => preview || available && !!sessionId && capabilities?.capabilities.some(item => item.id === kind && item.grade !== "unavailable") === true;
  const canRead = can("ida.status.details");
  const invoke = useCallback(async <K extends keyof StudioIdaResultMap>(kind: K, input: CommandInput<K>): Promise<StudioIdaResultMap[K]> => {
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: StudioIdaResultMap[K] }>(client, handle.requestId, 330_000)).result;
  }, [client]);

  useEffect(() => {
    epoch.current++; readSerial.current++; lock.current = false; configLoaded.current = false;
    setOperation(undefined); setToolsBusy(false); setLoading(false); setError(""); setNotice(""); setConfirm(undefined); setConfiguration(false);
    setSelected(undefined); setDrafts({}); setResults({}); setFilter(""); setPath(""); setTab("browse");
    setStatus(preview ? structuredClone(PREVIEW_IDA) : undefined);
    return () => { epoch.current++; };
  }, [client, preview, sessionId, available]);

  const refresh = useCallback(async () => {
    if (preview || !canRead) return;
    const generation = epoch.current, serial = ++readSerial.current;
    setLoading(true);
    try {
      const next = await invoke("ida.status.details", { sessionId: sessionId! });
      if (generation !== epoch.current || serial !== readSerial.current) return;
      setStatus(next);
      if (!configLoaded.current) {
        setEnabled(next.enabled); setInstallDir(next.installDir); setPython(next.python); configLoaded.current = true;
      }
    } catch (cause) {
      if (generation === epoch.current && serial === readSerial.current) setError(hostErrorMessage(cause, zh ? "IDA 状态读取失败" : "Cannot read IDA status"));
    } finally { if (generation === epoch.current && serial === readSerial.current) setLoading(false); }
  }, [preview, canRead, sessionId, invoke, zh]);

  useEffect(() => {
    if (!visible || !canRead || preview) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden && !lock.current) await refresh();
      if (active) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [visible, canRead, preview, refresh]);

  const db = status?.databases.find(row => row.id === selected) ?? status?.databases[0];
  const code = db ? drafts[db.id] ?? (preview ? PREVIEW_IDA_PYTHON : "") : "";
  const result = db ? results[db.id] : undefined;
  const setCode = (text: string) => { if (db) setDrafts(current => ({ ...current, [db.id]: text })); };
  const requestRun = () => { if (db && can("ida.run") && !busy && !db.busy && code.trim()) setConfirm({ kind: "run", id: db.id, code }); };
  const actionTitle = (action: Confirmation["kind"]) => ({
    configure: zh ? "保存 IDA 配置" : "Save IDA configuration", open: zh ? "打开数据库" : "Open database",
    run: zh ? "运行 Python" : "Run Python", save: zh ? "保存数据库" : "Save database", close: zh ? "保存并关闭数据库" : "Save and close database",
  })[action];

  const applyPreviewEdit = (edit: IdaEdit) => {
    if (!preview || !("dbId" in edit)) return;
    setStatus(current => current ? { ...current, databases: edit.action === "close"
      ? current.databases.filter(row => row.id !== edit.dbId)
      : current.databases.map(row => row.id === edit.dbId ? { ...row, dirty: edit.action !== "save" } : row) } : current);
  };
  const run = async () => {
    if (!confirm || lock.current || !can(`ida.${confirm.kind}`)) return;
    const action = confirm, generation = epoch.current;
    lock.current = true; readSerial.current++; setLoading(false); setOperation(action); setConfirm(undefined); setError(""); setNotice("");
    try {
      if (preview) {
        if (action.kind === "configure") { setStatus(current => ({ ...current!, enabled: action.enabled, available: action.enabled, installDir: action.installDir, python: action.python })); setConfiguration(false); }
        else if (action.kind === "open") {
          const name = action.path.split(/[\\/]/).at(-1) || "sample.exe";
          const existing = status?.databases.find(row => row.ref === action.path || row.path === action.path);
          const id = existing?.id ?? `preview-${Date.now()}`;
          if (!existing) setStatus(current => ({ ...current!, databases: [...current!.databases, { ...PREVIEW_IDA.databases[0]!, id, module: name, ref: action.path, path: `${name}.i64` }] }));
          setSelected(id); setPath("");
        } else {
          applyPreviewEdit({ action: action.kind === "run" ? "exec" : action.kind, dbId: action.id, ...(action.kind === "run" ? { code: action.code } : action.kind === "close" ? { save: true } : {}) } as IdaEdit);
          if (action.kind === "run") setResults(current => ({ ...current, [action.id]: { ...PREVIEW_IDA_RESULT } }));
        }
        if (marks) setNotice(zh ? "演示：操作已完成，本机 IDA 和文件未更改。" : "Demo: operation complete. Local IDA and files are unchanged.");
      } else {
        if (action.kind === "configure") {
          const next = await invoke("ida.configure", { sessionId: sessionId!, enabled: action.enabled, installDir: action.installDir, python: action.python });
          if (generation !== epoch.current) return;
          setStatus(next); setConfiguration(false); setNotice(zh ? "配置已保存并重新检测。" : "Configuration saved and checked.");
        } else if (action.kind === "open") {
          const next = await invoke("ida.open", { sessionId: sessionId!, path: action.path });
          if (generation !== epoch.current) return;
          setSelected(next.database.id); setPath("");
        } else if (action.kind === "run") {
          const next = await invoke("ida.run", { sessionId: sessionId!, id: action.id, code: action.code, timeoutMs: 120_000 });
          if (generation !== epoch.current) return;
          setResults(current => ({ ...current, [action.id]: next }));
        } else {
          const next = await invoke(action.kind === "save" ? "ida.save" : "ida.close", { sessionId: sessionId!, id: action.id });
          if (generation !== epoch.current) return;
          setNotice((zh ? "已完成，恢复副本：" : "Completed. Recovery copy: ") + next.backup);
        }
        if (generation === epoch.current) await refresh();
      }
      if (generation === epoch.current) setRefreshKey(key => key + 1);
    } catch (cause) {
      if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "IDA 操作失败，请刷新状态后再决定是否重试。" : "IDA operation failed. Check its status before retrying."));
    } finally { if (generation === epoch.current) { lock.current = false; setOperation(undefined); } }
  };
  const cancel = async () => {
    const id = operation && "id" in operation ? operation.id : db?.id;
    if (!id || preview) return;
    const generation = epoch.current;
    try {
      const next = await invoke("ida.database.cancel", { sessionId: sessionId!, id });
      if (generation === epoch.current) setNotice(next.cancelled ? (zh ? "已请求取消。取消不会回滚已经完成的修改。" : "Cancellation requested. Completed changes are not rolled back.") : (zh ? "没有属于 Studio 的活动请求。" : "No active request owned by Studio."));
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "取消请求失败" : "Cannot cancel request")); }
  };
  const dbStatus = db?.busy ? "running" : db?.state === "opening" ? "starting" : "idle";

  return <section className="ida-pane" aria-label="IDA">
    <header className="ida-page-heading"><div className="ida-heading-icon"><Icon name="cpu" /></div><div><h2>IDA{preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}</h2><p>{zh ? "浏览原生数据库，检查符号与引用，在同一处执行 Python。" : "Explore native databases, inspect symbols and references, and run Python in one place."}</p></div><button className="btn small outline" onClick={() => setConfiguration(true)}><Icon name="settings" />{zh ? "环境配置" : "Environment"}</button></header>
    <div className={`ida-environment ${status?.available ? "is-ready" : ""}`}>
      <Icon name={status?.available ? "check" : "info"} /><strong>{!canRead ? (zh ? "IDA 管理不可用" : "IDA management unavailable") : !status ? (zh ? "正在检测 IDA" : "Detecting IDA") : !status.enabled ? (zh ? "IDA 未启用" : "IDA disabled") : status.available ? (zh ? "IDA 已就绪" : "IDA ready") : (zh ? "需要配置 IDA" : "IDA setup required")}</strong>
      <span>{status?.reason || (status?.available ? (zh ? "数据库由当前项目共享，修改对其他代理可见。" : "Databases are shared with agents in this project.") : (zh ? "需要已授权的 IDA Pro / idalib，以及匹配的 Python。" : "Requires licensed IDA Pro / idalib and matching Python."))}</span>
      <button className="icon-btn" aria-label={zh ? "刷新 IDA 状态" : "Refresh IDA status"} disabled={!canRead || busy || loading} onClick={() => { setError(""); void refresh(); setRefreshKey(key => key + 1); }}><Icon name="refresh" /></button>
    </div>
    {error ? <div className="ida-notice is-error" role="alert"><Icon name="alert-c" /><span>{error}</span></div> : null}
    {notice ? <div className="ida-notice" role="status"><Icon name="info" /><span>{notice}</span><button className="icon-btn" aria-label={zh ? "关闭提示" : "Dismiss notice"} onClick={() => setNotice("")}><Icon name="x" /></button></div> : null}
    <form className="ida-open-row" onSubmit={event => { event.preventDefault(); if (status?.available && !busy && path.trim() && can("ida.open")) setConfirm({ kind: "open", path: path.trim() }); }}>
      <label>{zh ? "二进制或数据库文件" : "Binary or database file"}<div className="ida-path-input"><Icon name="folder-open" /><input className="input mono" value={path} onChange={event => setPath(event.target.value)} placeholder={zh ? "文件路径" : "File path"} disabled={busy} /></div></label>
      <button className="btn primary" disabled={!status?.available || busy || !path.trim() || !can("ida.open")}><Icon name="plus" />{zh ? "打开数据库" : "Open database"}</button>
    </form>
    <div className="ida-workbench">
      <aside className="ida-databases" aria-label={zh ? "项目数据库" : "Project databases"}>
        <div className="ida-list-heading"><strong>{zh ? "项目数据库" : "Project databases"}</strong><span>{status?.databases.length ?? 0}</span></div>
        <div className="ida-list-search"><Icon name="search" /><input aria-label={zh ? "筛选数据库" : "Filter databases"} placeholder={zh ? "筛选数据库…" : "Filter databases…"} value={filter} onChange={event => setFilter(event.target.value)} /></div>
        <div className="ida-database-list">{status?.databases.filter(row => row.module.toLowerCase().includes(filter.toLowerCase())).map(row => <button key={row.id} type="button" className="ida-database-row" aria-pressed={row.id === db?.id} disabled={busy} onClick={() => setSelected(row.id)}>
          <Icon name="cpu" /><span><strong>{row.module}</strong><small>{row.arch} / {row.bitness}-bit</small></span>{row.dirty ? <span className="ida-dirty" title={zh ? "未保存更改" : "Unsaved changes"} aria-label={zh ? "未保存更改" : "Unsaved changes"} /> : null}{row.busy ? <Icon name="clock" /> : null}
        </button>)}{filter && !status?.databases.some(row => row.module.toLowerCase().includes(filter.toLowerCase())) ? <p className="ida-hint">{zh ? "没有匹配的数据库" : "No matching databases"}</p> : null}</div>
        <div className="ida-list-foot"><Icon name="shield" /><p>{zh ? "运行、保存和关闭前\n自动保留恢复副本" : "A recovery copy precedes\nrun, save and close"}</p></div>
      </aside>
      <main className="ida-database-main">
        {db ? <>
          <header className="ida-database-heading"><div><h3>{db.module}</h3><div className="ida-db-meta"><span>{db.format}</span><span>{db.arch} / {db.bitness}-bit</span><WorkspaceStatus state={dbStatus} />{db.dirty ? <span className="ida-unsaved">{zh ? "未保存更改" : "Unsaved changes"}</span> : null}</div></div><div className="ida-db-actions"><button className="btn small outline" disabled={busy || db.busy || !can("ida.save")} onClick={() => setConfirm({ kind: "save", id: db.id })}>{zh ? "保存" : "Save"}</button><button className="btn small ghost" disabled={busy || db.busy || !can("ida.close")} onClick={() => setConfirm({ kind: "close", id: db.id })}>{zh ? "保存并关闭" : "Save and close"}</button></div></header>
          <WorkspaceTabs<"browse" | "python" | "info"> id="ida-database-tabs" label={zh ? "数据库工作区" : "Database workspace"} value={tab} onChange={setTab} items={[{ id: "browse", icon: "file-code", label: zh ? "数据库视图" : "Database views" }, { id: "python", icon: "console", label: "Python" }, { id: "info", icon: "info", label: zh ? "数据库信息" : "Database info" }]} />
          <WorkspacePanel id="ida-database-tabs" name="browse" active={tab === "browse"}><IdaDatabaseTools key={db.id} client={client} sessionId={sessionId} available={available} databaseId={db.id} onBusyChange={setToolsBusy} visible={visible && tab === "browse"} refreshKey={refreshKey} previewDatabases={{ available: !!status?.available, databases: status!.databases.map(row => ({ id: row.id, label: row.module, state: row.state, busy: row.busy, dirty: row.dirty, identity: `preview-${row.id}`, version: refreshKey + 1 })) }} onChanged={edit => { if (preview) applyPreviewEdit(edit); else void refresh(); }} /></WorkspacePanel>
          <WorkspacePanel id="ida-database-tabs" name="python" active={tab === "python"}><div className="ida-python">
            <div className="ida-surface-bar"><span><Icon name="console" />{zh ? "Python 控制台" : "Python console"}</span><span className="ida-hint">ida_domain · db</span></div>
            <CapabilityEditor key={db.id} label="Python" value={code} onChange={setCode} language="python" readOnly={busy} placeholder={zh ? "# db 为当前 ida_domain 数据库\n# 输入 Python，检查后运行" : "# db is the current ida_domain Database\n# Write Python, then review and run"} onSubmit={requestRun} />
            <div className="ida-python-actions"><p><Icon name="info" />{zh ? "与代理共享 Python 命名空间，不是只读沙盒。" : "The Python namespace is shared with agents, not a read-only sandbox."}</p><button className="btn primary" disabled={busy || db.busy || !code.trim() || !can("ida.run")} onClick={requestRun}><Icon name="play" />{zh ? "运行请求" : "Run request"}<kbd>{PLATFORM === "darwin" ? "⌘" : "Ctrl"} ↵</kbd></button></div>
            <section className="ida-python-result" aria-label={zh ? "执行结果" : "Execution result"}><div className="ida-surface-bar"><span><Icon name="terminal" />{zh ? "执行结果" : "Execution result"}</span>{result ? <WorkspaceStatus state={result.error ? "failed" : "completed"} /> : null}</div>
              {result ? <><pre className="ida-result-text">{result.output}{result.value !== null ? `${result.output ? "\n" : ""}${result.value}` : ""}{!result.output && result.value === null && !result.error ? (zh ? "执行完成，无输出。" : "Completed without output.") : ""}</pre>{result.error ? <p role="alert" className="ida-notice is-error">{result.error}</p> : null}
                <details className="ida-disclosure"><summary>{zh ? "恢复副本与完整结果" : "Recovery copy and full result"}</summary><dl className="ida-facts"><div><dt>{zh ? "恢复副本" : "Recovery copy"}</dt><dd>{result.backup}</dd></div><div><dt>{zh ? "结果文件" : "Result file"}</dt><dd>{result.resultFile}</dd></div></dl></details>{result.truncated ? <p className="ida-hint">{zh ? "显示内容已截断，完整输出保存在结果文件中。" : "Output is truncated. The result file contains the complete output."}</p> : null}</> : <p className="ida-result-placeholder">{zh ? "运行后的输出、返回值和错误会显示在这里。" : "Output, return values and errors appear here after execution."}</p>}
            </section>
          </div></WorkspacePanel>
          <WorkspacePanel id="ida-database-tabs" name="info" active={tab === "info"}><dl className="ida-facts"><div><dt>{zh ? "数据库文件" : "Database file"}</dt><dd>{db.path}</dd></div><div><dt>{zh ? "源文件引用" : "Source reference"}</dt><dd>{db.ref}</dd></div><div><dt>{zh ? "数据库 ID" : "Database ID"}</dt><dd>{db.id}</dd></div><div><dt>{zh ? "当前操作" : "Current operation"}</dt><dd>{db.current ? `${db.current.method} · ${new Date(db.current.startedAt).toLocaleString()}` : (zh ? "无活动操作" : "No active operation")}</dd></div></dl><div className="ida-info-note"><Icon name="info" /><p>{zh ? "打开二进制会创建独立数据库，不修改原二进制。已有 IDB / i64 原位打开；数据库和 Python 状态由项目共享。" : "Binaries use a separate database without changing the binary. Existing IDB / i64 files open in place. Database and Python state are shared by the project."}</p></div></WorkspacePanel>
        </> : <WorkspaceEmpty icon={canRead ? "cpu" : "plug"} title={loading ? (zh ? "正在加载数据库" : "Loading databases") : canRead ? (zh ? "打开你的第一个数据库" : "Open your first database") : (zh ? "连接支持 IDA 的 Runtime" : "Connect an IDA-capable Runtime")}>
          {canRead ? (zh ? "输入二进制或 IDB / i64 文件路径，原生 IDA 将负责打开与分析。" : "Enter a binary or IDB / i64 path. Native IDA handles opening and analysis.") : (zh ? "此页面只显示 Runtime 提供的真实数据库。连接后可在此查看与编辑。" : "This page only shows databases from the Runtime. Connect to view and edit them.")}
        </WorkspaceEmpty>}
      </main>
    </div>
    {busy || db?.busy ? <div className="ida-activity" role="status"><WorkspaceStatus state="running" /><span>{operation ? actionTitle(operation.kind) : db?.current?.method}{operation?.kind === "open" ? (zh ? "，原生分析会在后台继续。" : ". Native analysis continues in the background.") : ""}</span>{(operation?.kind === "run" || !operation && db?.busy) && can("ida.database.cancel") ? <button className="btn small outline danger" onClick={() => void cancel()}><Icon name="stop" />{zh ? "停止请求" : "Stop request"}</button> : null}</div> : null}
    {configuration ? <WorkspaceDialog title={zh ? "安装与依赖配置" : "Installation and dependencies"} onClose={() => { if (!busy) setConfiguration(false); }}><div className="ida-edit-form"><p className="ida-hint">{zh ? "需要已安装并授权的 IDA Pro / idalib。Studio 不会自动安装商业软件。设置保存到原生全局配置。" : "Requires licensed IDA Pro / idalib. Studio does not install commercial software. These settings are saved globally."}</p><label className="ida-checkbox"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />{zh ? "启用 IDA" : "Enable IDA"}</label><label>{zh ? "安装目录" : "Install directory"}<input className="input mono" value={installDir} disabled={busy} onChange={event => setInstallDir(event.target.value)} placeholder={zh ? "留空自动检测" : "Leave empty to detect"} /></label><label>{zh ? "Python 路径" : "Python path"}<input className="input mono" value={python} disabled={busy} onChange={event => setPython(event.target.value)} placeholder={zh ? "需支持 ida_domain 与 idapro" : "Must provide ida_domain and idapro"} /></label>{status?.detectedInstall || status?.detectedPython ? <dl className="ida-facts"><div><dt>{zh ? "检测到的 IDA" : "Detected IDA"}</dt><dd>{status.detectedInstall || (zh ? "未检测到" : "Not detected")}</dd></div><div><dt>Python</dt><dd>{status.detectedPython || (zh ? "未检测到" : "Not detected")}</dd></div></dl> : null}<div className="ida-dialog-actions"><button className="btn outline" disabled={busy} onClick={() => setConfiguration(false)}>{zh ? "返回" : "Back"}</button><button className="btn primary" disabled={busy || !can("ida.configure")} onClick={() => { setConfiguration(false); setConfirm({ kind: "configure", enabled, installDir, python }); }}>{zh ? "保存并检测" : "Save and detect"}</button></div></div></WorkspaceDialog> : null}
    {confirm ? <WorkspaceDialog title={zh ? "确认 IDA 操作" : "Confirm IDA action"} onClose={() => setConfirm(undefined)}><div className="ida-edit-form"><div className="ida-review-heading"><Icon name="shield" /><div><strong>{actionTitle(confirm.kind)}</strong><p>{"id" in confirm ? status?.databases.find(row => row.id === confirm.id)?.module : confirm.kind === "open" ? confirm.path : (zh ? "原生全局配置" : "Native global configuration")}</p></div></div>
      <p className="ida-hint">{confirm.kind === "configure" ? (zh ? "将启用状态、安装目录和 Python 路径保存到原生全局设置。" : "Save the enabled state, installation directory and Python path to native global settings.") : confirm.kind === "open" ? (zh ? "二进制将使用独立分析数据库。已有 IDB / i64 会原位打开，分析可能需要一些时间。" : "A binary uses a separate analysis database. Existing IDB / i64 files open in place. Analysis can take a while.") : confirm.kind === "close" ? (zh ? "先保留恢复副本并保存数据库，再关闭。其他使用此数据库的代理也会受影响。" : "Keep a recovery copy, save, then close the database. Other agents using it will be affected.") : confirm.kind === "run" ? (zh ? "先保留恢复副本。Python 可修改数据库并访问本机资源，命名空间与其他代理共享。" : "A recovery copy is kept first. Python can modify the database and access local resources. Its namespace is shared with other agents.") : (zh ? "保留恢复副本后，将当前数据库更改保存到磁盘。" : "Keep a recovery copy, then save database changes to disk.")}</p>
      {confirm.kind === "run" ? <CapabilityEditor label={zh ? "待执行 Python" : "Python to execute"} value={confirm.code} language="python" readOnly /> : null}
      <div className="ida-dialog-actions"><button className="btn outline" onClick={() => setConfirm(undefined)}>{zh ? "取消" : "Cancel"}</button><button className="btn primary" onClick={() => void run()}>{zh ? "确认" : "Confirm"}</button></div></div></WorkspaceDialog> : null}
  </section>;
}
