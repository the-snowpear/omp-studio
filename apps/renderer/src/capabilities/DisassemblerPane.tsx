import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "@omp-studio/client-contract";
import type { DisassemblerBackend, DisassemblerEdit, DisassemblerResultMap, DisassemblerStatus } from "@omp-studio/studio-protocol";
import type { SessionOptionsProps } from "../models/SessionOptionsPane";
import { AppSelect } from "../AppSelect";
import { PREVIEW_BINARY_HEADER, PREVIEW_DISASSEMBLER, PREVIEW_DISASSEMBLER_PYTHON, PREVIEW_DISASSEMBLER_RESULT } from "../preview/disassemblerPreview";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { PLATFORM } from "../platform";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceDialog, WorkspaceEmpty, WorkspacePanel, WorkspaceStatus, WorkspaceTabs } from "../workspaces/Workspace";
import { DisassemblerDatabaseTools } from "./DisassemblerDatabaseTools";
import { CapabilityEditor } from "./CapabilityEditor";
import "./disassembler.css";

type Confirmation =
  | { kind: "configure"; backend: DisassemblerBackend; maxOpen: number; idleCloseSec: number }
  | { kind: "open"; path: string }
  | { kind: "run"; id: string; code: string }
  | { kind: "save" | "close"; id: string };

export function DisassemblerPane({ client, sessionId, available, visible = true, capabilities, initialPath }: SessionOptionsProps & { initialPath?: string | undefined }) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<DisassemblerStatus>();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<"browse" | "python" | "info">("browse");
  const [configuration, setConfiguration] = useState(false);
  const [backend, setBackend] = useState<DisassemblerBackend>("auto");
  const [maxOpen, setMaxOpen] = useState(4);
  const [idleCloseSec, setIdleCloseSec] = useState(900);
  const [metadata, setMetadata] = useState("");
  const metadataRequest = useRef(0);
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, DisassemblerResultMap["disassembler.run"]>>({});
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
  const canRead = can("disassembler.status");
  const invoke = useCallback(async <K extends keyof DisassemblerResultMap>(kind: K, input: CommandInput<K>): Promise<DisassemblerResultMap[K]> => {
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: DisassemblerResultMap[K] }>(client, handle.requestId, 330_000)).result;
  }, [client]);

  useEffect(() => {
    epoch.current++; readSerial.current++; lock.current = false; configLoaded.current = false;
    setOperation(undefined); setToolsBusy(false); setLoading(false); setError(""); setNotice(""); setConfirm(undefined); setConfiguration(false);
    setSelected(undefined); setDrafts({}); setResults({}); setFilter(""); setPath(initialPath ?? ""); setMetadata(""); setTab("browse");
    setStatus(preview ? structuredClone(PREVIEW_DISASSEMBLER) : undefined);
    return () => { epoch.current++; };
  }, [client, preview, sessionId, available]);

  useEffect(() => { setPath(initialPath ?? ""); setMetadata(""); }, [initialPath]);

  const zhRef = useRef(zh);
  zhRef.current = zh;
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async (silent = false): Promise<DisassemblerStatus | undefined> => {
    if (preview || !canRead) return undefined;
    const generation = epoch.current, serial = ++readSerial.current;
    if (!silent) setLoading(true);
    try {
      const next = await invoke("disassembler.status", { sessionId: sessionId! });
      if (generation !== epoch.current || serial !== readSerial.current) return undefined;
      hasLoadedRef.current = true;
      setStatus(next);
      if (!configLoaded.current) {
        setBackend(next.backend); setMaxOpen(next.maxOpen); setIdleCloseSec(next.idleCloseSec); configLoaded.current = true;
      }
      return next;
    } catch (cause) {
      if (generation === epoch.current && serial === readSerial.current) setError(hostErrorMessage(cause, zhRef.current ? "无法读取分析引擎状态" : "Could not read analysis engine status"));
      return undefined;
    } finally { if (generation === epoch.current && serial === readSerial.current) setLoading(false); }
  }, [preview, canRead, sessionId, invoke]);

  useEffect(() => {
    if (!visible || !canRead || preview) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const poll = async (silent: boolean) => {
      clearTimer();
      if (!active || document.hidden) return;
      let next: DisassemblerStatus | undefined;
      if (!lock.current) next = await refresh(silent);
      const keepPolling = !next || next.databases.some((database) => database.busy) || lock.current;
      if (active && keepPolling && !document.hidden) {
        timer = setTimeout(() => void poll(true), 4000);
      }
    };
    const onVisibility = () => {
      if (document.hidden) clearTimer();
      else void poll(hasLoadedRef.current);
    };
    void poll(hasLoadedRef.current);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [visible, canRead, preview, refresh]);

  const db = status?.databases.find(row => row.id === selected) ?? status?.databases[0];
  const code = db ? drafts[db.id] ?? (preview ? PREVIEW_DISASSEMBLER_PYTHON : "") : "";
  const result = db ? results[db.id] : undefined;
  const setCode = (text: string) => { if (db) setDrafts(current => ({ ...current, [db.id]: text })); };
  const requestRun = () => { if (db && can("disassembler.run") && !busy && !db.busy && code.trim()) setConfirm({ kind: "run", id: db.id, code }); };
  const actionTitle = (action: Confirmation["kind"]) => ({
    configure: zh ? "保存分析引擎配置" : "Save analysis settings", open: zh ? "打开数据库" : "Open database",
    run: zh ? "运行 Python" : "Run Python", save: zh ? "保存数据库" : "Save database", close: zh ? "保存并关闭数据库" : "Save and close database",
  })[action];

  const applyPreviewEdit = (edit: DisassemblerEdit) => {
    if (!preview || !("dbId" in edit)) return;
    setStatus(current => current ? { ...current, databases: edit.action === "close"
      ? current.databases.filter(row => row.id !== edit.dbId)
      : current.databases.map(row => row.id === edit.dbId ? { ...row, dirty: edit.action !== "save" } : row) } : current);
  };
  const run = async () => {
    if (!confirm || lock.current || !can(`disassembler.${confirm.kind}`)) return;
    const action = confirm, generation = epoch.current;
    lock.current = true; readSerial.current++; setLoading(false); setOperation(action); setConfirm(undefined); setError(""); setNotice("");
    try {
      if (preview) {
        if (action.kind === "configure") { setStatus(current => ({ ...current!, backend: action.backend, activeBackend: action.backend === "ghidra" ? "ghidra" : "ida", available: action.backend !== "none", maxOpen: action.maxOpen, idleCloseSec: action.idleCloseSec })); setConfiguration(false); }
        else if (action.kind === "open") {
          const name = action.path.split(/[\\/]/).at(-1) || "sample.exe";
          const existing = status?.databases.find(row => row.ref === action.path || row.path === action.path);
          const id = existing?.id ?? `preview-${Date.now()}`;
          if (!existing) setStatus(current => ({ ...current!, databases: [...current!.databases, { ...PREVIEW_DISASSEMBLER.databases[0]!, id, module: name, ref: action.path, backend: current!.backend === "ghidra" ? "ghidra" : "ida", label: name, path: current!.backend === "ghidra" ? `${name}.gpr` : `${name}.i64` }] }));
          setSelected(id); setPath("");
        } else {
          applyPreviewEdit({ action: action.kind === "run" ? "exec" : action.kind, dbId: action.id, ...(action.kind === "run" ? { code: action.code } : action.kind === "close" ? { save: true } : {}) } as DisassemblerEdit);
          if (action.kind === "run") setResults(current => ({ ...current, [action.id]: { ...PREVIEW_DISASSEMBLER_RESULT } }));
        }
        if (marks) setNotice(zh ? "演示：操作已完成，设置已更新。" : "Demo: operation complete. Settings updated.");
      } else {
        if (action.kind === "configure") {
          const next = await invoke("disassembler.configure", { sessionId: sessionId!, backend: action.backend, maxOpen: action.maxOpen, idleCloseSec: action.idleCloseSec });
          if (generation !== epoch.current) return;
          setStatus(next); setConfiguration(false); setNotice(zh ? "配置已保存并重新检测。" : "Configuration saved and checked.");
        } else if (action.kind === "open") {
          const next = await invoke("disassembler.open", { sessionId: sessionId!, path: action.path });
          if (generation !== epoch.current) return;
          setSelected(next.database.id); setPath("");
        } else if (action.kind === "run") {
          const next = await invoke("disassembler.run", { sessionId: sessionId!, id: action.id, code: action.code, timeoutMs: 120_000 });
          if (generation !== epoch.current) return;
          setResults(current => ({ ...current, [action.id]: next }));
        } else {
          const next = await invoke(action.kind === "save" ? "disassembler.save" : "disassembler.close", { sessionId: sessionId!, id: action.id });
          if (generation !== epoch.current) return;
          setNotice((zh ? "已完成，恢复副本：" : "Completed. Recovery copy: ") + next.backup);
        }
        if (generation === epoch.current) await refresh();
      }
      if (generation === epoch.current) setRefreshKey(key => key + 1);
    } catch (cause) {
      if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "反汇编操作失败，请刷新状态后再决定是否重试。" : "Disassembler operation failed. Check its status before retrying."));
    } finally { if (generation === epoch.current) { lock.current = false; setOperation(undefined); } }
  };
  const cancel = async () => {
    const id = operation && "id" in operation ? operation.id : db?.id;
    if (!id || preview) return;
    const generation = epoch.current;
    try {
      const next = await invoke("disassembler.cancel", { sessionId: sessionId!, id });
      if (generation === epoch.current) setNotice(next.cancelled ? (zh ? "已请求取消。取消不会回滚已经完成的修改。" : "Cancellation requested. Completed changes are not rolled back.") : (zh ? "没有属于 Studio 的活动请求。" : "No active request owned by Studio."));
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "取消请求失败" : "Cannot cancel request")); }
  };
  const dbStatus = db?.busy ? "running" : db?.state === "opening" ? "starting" : "idle";

  return <section className="disassembler-pane" aria-label={zh ? "反汇编器" : "Disassembler"}>
    <header className="disassembler-page-heading"><div className="disassembler-heading-icon"><Icon name="cpu" /></div><div><h2>{zh ? "反汇编器" : "Disassembler"}{preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}</h2><p>{zh ? "浏览原生数据库，检查符号与引用，在同一处执行 Python。" : "Explore native databases, inspect symbols and references, and run Python in one place."}</p></div><button className="btn small outline" onClick={() => { setBackend(status?.backend ?? "auto"); setMaxOpen(status?.maxOpen ?? 4); setIdleCloseSec(status?.idleCloseSec ?? 900); setConfiguration(true); }}><Icon name="settings" />{zh ? "环境配置" : "Environment"}</button></header>
    <div className={`disassembler-environment ${status?.available ? "is-ready" : ""}`}>
      <label className="disassembler-engine-select"><Icon name="cpu" /><strong>{zh ? "分析引擎" : "Analysis engine"}</strong>
        <AppSelect aria-label={zh ? "分析引擎" : "Analysis engine"} value={status?.backend ?? "auto"} disabled={!status || busy || !can("disassembler.configure")} onChange={event => {
          const choice = event.target.value as DisassemblerBackend;
          setConfirm({ kind: "configure", backend: choice, maxOpen: status!.maxOpen, idleCloseSec: status!.idleCloseSec });
        }}><option value="auto">{zh ? "自动" : "Auto"}{status?.backend === "auto" && status.activeBackend ? ` · ${status.activeBackend === "ida" ? "IDA Pro" : "Ghidra"}` : ""}</option><option value="ida">IDA Pro</option><option value="ghidra">Ghidra</option><option value="none">{zh ? "仅文件头" : "Metadata only"}</option></AppSelect>
      </label>
      {status && (["ida", "ghidra"] as const).map(engine => <span key={engine} title={status.backends[engine].detail}>
        {engine === "ida" ? "IDA Pro" : "Ghidra"} · {({ready: zh ? "就绪" : "Ready", unavailable: zh ? "不可用" : "Unavailable", installing: zh ? "安装中" : "Installing", unknown: zh ? "待检测" : "Unknown"})[status.backends[engine].state]}
      </span>)}{status?.reason && <span>{status.reason}</span>}
      <button className="icon-btn" aria-label={zh ? "刷新分析引擎状态" : "Refresh analysis engine status"} disabled={!canRead || busy || loading} onClick={() => { setError(""); void refresh(); setRefreshKey(key => key + 1); }}><Icon name="refresh" /></button>
    </div>
    {error ? <div className="disassembler-notice is-error" role="alert"><Icon name="alert-c" /><span>{error}</span></div> : null}
    {notice ? <div className="disassembler-notice" role="status"><Icon name="info" /><span>{notice}</span><button className="icon-btn" aria-label={zh ? "关闭提示" : "Dismiss notice"} onClick={() => setNotice("")}><Icon name="x" /></button></div> : null}
    <form className="disassembler-open-row" onSubmit={event => { event.preventDefault(); if (status?.available && !busy && path.trim() && can("disassembler.open")) setConfirm({ kind: "open", path: path.trim() }); }}>
      <label>{zh ? "二进制或数据库文件" : "Binary or database file"}<div className="disassembler-path-input"><Icon name="folder-open" /><input className="input mono" value={path} onChange={event => { metadataRequest.current++; setMetadata(""); setPath(event.target.value); }} placeholder={zh ? "文件路径" : "File path"} disabled={busy} /></div></label>
      <button type="button" className="btn outline" disabled={!path.trim() || !can("disassembler.metadata.read")} onClick={async () => {
        const generation = epoch.current, request = ++metadataRequest.current;
        try {
          const text = preview ? PREVIEW_BINARY_HEADER : (await invoke("disassembler.metadata.read", { sessionId: sessionId!, path: path.trim() })).text;
          if (generation === epoch.current && request === metadataRequest.current) setMetadata(text);
        } catch (cause) {
          if (generation === epoch.current && request === metadataRequest.current) setError(hostErrorMessage(cause, zh ? "无法读取文件头" : "Could not read file header"));
        }
      }}>{zh ? "查看文件头" : "Inspect header"}</button>
      <button className="btn primary" disabled={!status?.available || busy || !path.trim() || !can("disassembler.open")}><Icon name="plus" />{zh ? "打开数据库" : "Open database"}</button>
    </form>
    {metadata && <section className="disassembler-surface"><h3>{zh ? "二进制文件头" : "Binary header"}</h3><pre className="disassembler-result-text">{metadata}</pre></section>}
    <div className="disassembler-workbench">
      <aside className="disassembler-databases" aria-label={zh ? "项目数据库" : "Project databases"}>
        <div className="disassembler-list-heading"><strong>{zh ? "项目数据库" : "Project databases"}</strong><span>{status?.databases.length ?? 0}</span></div>
        <div className="disassembler-list-search"><Icon name="search" /><input aria-label={zh ? "筛选数据库" : "Filter databases"} placeholder={zh ? "筛选数据库…" : "Filter databases…"} value={filter} onChange={event => setFilter(event.target.value)} /></div>
        <div className="disassembler-database-list">{status?.databases.filter(row => row.module.toLowerCase().includes(filter.toLowerCase())).map(row => <button key={row.id} type="button" className="disassembler-database-row" aria-pressed={row.id === db?.id} disabled={busy} onClick={() => setSelected(row.id)}>
          <Icon name="cpu" /><span><strong>{row.module}</strong><small>{row.backend === "ida" ? "IDA Pro" : "Ghidra"} · {row.arch} / {row.bitness}-bit</small></span>{row.dirty ? <span className="disassembler-dirty" title={zh ? "未保存更改" : "Unsaved changes"} aria-label={zh ? "未保存更改" : "Unsaved changes"} /> : null}{row.busy ? <Icon name="clock" /> : null}
        </button>)}{filter && !status?.databases.some(row => row.module.toLowerCase().includes(filter.toLowerCase())) ? <p className="disassembler-hint">{zh ? "没有匹配的数据库" : "No matching databases"}</p> : null}</div>
        <div className="disassembler-list-foot"><Icon name="shield" /><p>{zh ? "运行、保存和关闭前\n自动保留恢复副本" : "A recovery copy precedes\nrun, save and close"}</p></div>
      </aside>
      <main className="disassembler-database-main">
        {db ? <>
          <header className="disassembler-database-heading"><div><h3>{db.module}</h3><div className="disassembler-db-meta"><span>{db.format}</span><span>{db.arch} / {db.bitness}-bit</span><WorkspaceStatus state={dbStatus} />{db.dirty ? <span className="disassembler-unsaved">{zh ? "未保存更改" : "Unsaved changes"}</span> : null}</div></div><div className="disassembler-db-actions"><button className="btn small outline" disabled={busy || db.busy || !can("disassembler.save")} onClick={() => setConfirm({ kind: "save", id: db.id })}>{zh ? "保存" : "Save"}</button><button className="btn small ghost" disabled={busy || db.busy || !can("disassembler.close")} onClick={() => setConfirm({ kind: "close", id: db.id })}>{zh ? "保存并关闭" : "Save and close"}</button></div></header>
          <WorkspaceTabs<"browse" | "python" | "info"> id="disassembler-database-tabs" label={zh ? "数据库工作区" : "Database workspace"} value={tab} onChange={setTab} items={[{ id: "browse", icon: "file-code", label: zh ? "数据库视图" : "Database views" }, { id: "python", icon: "console", label: "Python" }, { id: "info", icon: "info", label: zh ? "数据库信息" : "Database info" }]} />
          <WorkspacePanel id="disassembler-database-tabs" name="browse" active={tab === "browse"}><DisassemblerDatabaseTools key={db.id} client={client} sessionId={sessionId} available={available} databaseId={db.id} onBusyChange={setToolsBusy} visible={visible && tab === "browse"} refreshKey={refreshKey} previewDatabases={status!} onChanged={edit => { if (preview) applyPreviewEdit(edit); else void refresh(); }} /></WorkspacePanel>
          <WorkspacePanel id="disassembler-database-tabs" name="python" active={tab === "python"}><div className="disassembler-python">
            <div className="disassembler-surface-bar"><span><Icon name="console" />{zh ? "Python 控制台" : "Python console"}</span><span className="disassembler-hint">ida_domain · db</span></div>
            <CapabilityEditor key={db.id} label="Python" value={code} onChange={setCode} language="python" readOnly={busy} placeholder={zh ? "# db 为当前 ida_domain 数据库\n# 输入 Python，检查后运行" : "# db is the current ida_domain Database\n# Write Python, then review and run"} onSubmit={requestRun} />
            <div className="disassembler-python-actions"><p><Icon name="info" />{zh ? "与代理共享 Python 命名空间，不是只读沙盒。" : "The Python namespace is shared with agents, not a read-only sandbox."}</p><button className="btn primary" disabled={busy || db.busy || !code.trim() || !can("disassembler.run")} onClick={requestRun}><Icon name="play" />{zh ? "运行请求" : "Run request"}<kbd>{PLATFORM === "darwin" ? "⌘" : "Ctrl"} ↵</kbd></button></div>
            <section className="disassembler-python-result" aria-label={zh ? "执行结果" : "Execution result"}><div className="disassembler-surface-bar"><span><Icon name="terminal" />{zh ? "执行结果" : "Execution result"}</span>{result ? <WorkspaceStatus state={result.error ? "failed" : "completed"} /> : null}</div>
              {result ? <><pre className="disassembler-result-text">{result.output}{result.value !== null ? `${result.output ? "\n" : ""}${result.value}` : ""}{!result.output && result.value === null && !result.error ? (zh ? "执行完成，无输出。" : "Completed without output.") : ""}</pre>{result.error ? <p role="alert" className="disassembler-notice is-error">{result.error}</p> : null}
                <details className="disassembler-disclosure"><summary>{zh ? "恢复副本与完整结果" : "Recovery copy and full result"}</summary><dl className="disassembler-facts"><div><dt>{zh ? "恢复副本" : "Recovery copy"}</dt><dd>{result.backup}</dd></div><div><dt>{zh ? "结果文件" : "Result file"}</dt><dd>{result.resultFile}</dd></div></dl></details>{result.truncated ? <p className="disassembler-hint">{zh ? "显示内容已截断，完整输出保存在结果文件中。" : "Output is truncated. The result file contains the complete output."}</p> : null}</> : <p className="disassembler-result-placeholder">{zh ? "运行后的输出、返回值和错误会显示在这里。" : "Output, return values and errors appear here after execution."}</p>}
            </section>
          </div></WorkspacePanel>
          <WorkspacePanel id="disassembler-database-tabs" name="info" active={tab === "info"}><dl className="disassembler-facts"><div><dt>{zh ? "数据库文件" : "Database file"}</dt><dd>{db.path}</dd></div><div><dt>{zh ? "源文件引用" : "Source reference"}</dt><dd>{db.ref}</dd></div><div><dt>{zh ? "数据库 ID" : "Database ID"}</dt><dd>{db.id}</dd></div><div><dt>{zh ? "当前操作" : "Current operation"}</dt><dd>{db.current ? `${db.current.method} · ${new Date(db.current.startedAt).toLocaleString()}` : (zh ? "无活动操作" : "No active operation")}</dd></div></dl><div className="disassembler-info-note"><Icon name="info" /><p>{zh ? "打开二进制会创建独立数据库，不修改原二进制。已有 IDB / i64 原位打开；数据库和 Python 状态由项目共享。" : "Binaries use a separate database without changing the binary. Existing IDB / i64 files open in place. Database and Python state are shared by the project."}</p></div></WorkspacePanel>
        </> : <WorkspaceEmpty icon={canRead ? "cpu" : "plug"} title={loading ? (zh ? "正在加载数据库" : "Loading databases") : canRead ? (zh ? "打开你的第一个数据库" : "Open your first database") : (zh ? "连接支持反汇编的 Runtime" : "Connect a disassembler-capable Runtime")}>
          {canRead ? (zh ? "输入二进制或 IDB / i64 文件路径，由所选引擎打开并分析。" : "Enter a binary or IDB / i64 path. The selected engine opens and analyzes the file.") : (zh ? "此页面只显示 Runtime 提供的真实数据库。连接后可在此查看与编辑。" : "This page only shows databases from the Runtime. Connect to view and edit them.")}
        </WorkspaceEmpty>}
      </main>
    </div>
    {busy || db?.busy ? <div className="disassembler-activity" role="status"><WorkspaceStatus state="running" /><span>{operation ? actionTitle(operation.kind) : db?.current?.method}{operation?.kind === "open" ? (zh ? "，原生分析会在后台继续。" : ". Native analysis continues in the background.") : ""}</span>{(operation?.kind === "run" || !operation && db?.busy) && can("disassembler.cancel") ? <button className="btn small outline danger" onClick={() => void cancel()}><Icon name="stop" />{zh ? "停止请求" : "Stop request"}</button> : null}</div> : null}
    {configuration ? <WorkspaceDialog title={zh ? "分析引擎设置" : "Analysis engine settings"} onClose={() => setConfiguration(false)}>
      <form className="disassembler-edit-form" onSubmit={event => { event.preventDefault(); setConfiguration(false); setConfirm({ kind: "configure", backend, maxOpen, idleCloseSec }); }}>
        <label>{zh ? "后端" : "Backend"}<AppSelect value={backend} onChange={event => setBackend(event.target.value as DisassemblerBackend)}>
          <option value="auto">{zh ? "自动 · 优先 IDA Pro" : "Auto · prefer IDA Pro"}</option><option value="ida">IDA Pro</option><option value="ghidra">Ghidra</option><option value="none">{zh ? "仅查看文件头" : "Metadata only"}</option>
        </AppSelect></label>
        <label>{zh ? "最大打开数据库数" : "Maximum open databases"}<input className="input" type="number" value={maxOpen} onChange={event => setMaxOpen(event.target.valueAsNumber)} /></label>
        <label>{zh ? "空闲关闭时间（秒）" : "Idle timeout (seconds)"}<input className="input" type="number" value={idleCloseSec} onChange={event => setIdleCloseSec(event.target.valueAsNumber)} /></label>
        <button className="btn primary" disabled={!can("disassembler.configure")}>{zh ? "保存设置" : "Save settings"}</button>
      </form></WorkspaceDialog> : null}
    {confirm ? <WorkspaceDialog title={zh ? "确认 IDA 操作" : "Confirm IDA action"} onClose={() => setConfirm(undefined)}><div className="disassembler-edit-form"><div className="disassembler-review-heading"><Icon name="shield" /><div><strong>{actionTitle(confirm.kind)}</strong><p>{"id" in confirm ? status?.databases.find(row => row.id === confirm.id)?.module : confirm.kind === "open" ? confirm.path : (zh ? "原生全局配置" : "Native global configuration")}</p></div></div>
      <p className="disassembler-hint">{confirm.kind === "configure" ? (zh ? "将分析引擎、数据库数量与空闲时间保存到全局设置。" : "Save the analysis engine, database limit and idle timeout globally.") : confirm.kind === "open" ? (zh ? "二进制将使用独立分析数据库。已有 IDB / i64 会原位打开，分析可能需要一些时间。" : "A binary uses a separate analysis database. Existing IDB / i64 files open in place. Analysis can take a while.") : confirm.kind === "close" ? (zh ? "先保留恢复副本并保存数据库，再关闭。其他使用此数据库的代理也会受影响。" : "Keep a recovery copy, save, then close the database. Other agents using it will be affected.") : confirm.kind === "run" ? (zh ? "先保留恢复副本。Python 可修改数据库并访问本机资源，命名空间与其他代理共享。" : "A recovery copy is kept first. Python can modify the database and access local resources. Its namespace is shared with other agents.") : (zh ? "保留恢复副本后，将当前数据库更改保存到磁盘。" : "Keep a recovery copy, then save database changes to disk.")}</p>
      {confirm.kind === "run" ? <CapabilityEditor label={zh ? "待执行 Python" : "Python to execute"} value={confirm.code} language="python" readOnly /> : null}
      <div className="disassembler-dialog-actions"><button className="btn outline" onClick={() => setConfirm(undefined)}>{zh ? "取消" : "Cancel"}</button><button className="btn primary" onClick={() => void run()}>{zh ? "确认" : "Confirm"}</button></div></div></WorkspaceDialog> : null}
  </section>;
}
