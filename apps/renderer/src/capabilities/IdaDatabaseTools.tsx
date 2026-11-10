import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import { IDA_VIEWS, type IdaView, type IdaEdit, type IdaState, type IdaResultMap } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { waitReceipt, hostErrorMessage } from "../hostError";
import { PREVIEW_IDA, PREVIEW_IDA_VIEWS } from "../preview/idaDatabaseToolsPreview";
import { WorkspaceDialog, WorkspaceEmpty } from "../workspaces/Workspace";
import { CapabilityEditor } from "./CapabilityEditor";
import "./ida.css";

const VIEW_LABELS: Record<IdaView, [string, string]> = {
  overview: ["概览", "Overview"], functions: ["函数", "Functions"], strings: ["字符串", "Strings"],
  pseudocode: ["伪代码", "Pseudocode"], asm: ["反汇编", "Assembly"], imports: ["导入", "Imports"],
  exports: ["导出", "Exports"], xrefs: ["交叉引用", "Cross-references"],
};
const EDIT_LABELS: Record<IdaEdit["action"], [string, string]> = {
  open: ["打开数据库", "Open database"], rename: ["重命名", "Rename"], comment: ["添加注释", "Comment"],
  set_type: ["设置类型", "Set type"], make_function: ["创建函数", "Create function"], exec: ["执行 Python", "Execute Python"],
  save: ["保存数据库", "Save database"], close: ["关闭数据库", "Close database"],
};
type ReadBinding = { dbId: string; identity: string; version: number; view: IdaView; target?: string };
type LoadedPage = IdaResultMap["ida.view"] & { binding: ReadBinding; previous: number[] };

export function IdaDatabaseTools({ client, sessionId, available, initialPath, databaseId, refreshKey = 0, onChanged, onBusyChange, visible = true, previewDatabases }: {
  client: StudioClient; sessionId: string | undefined; available: boolean; initialPath?: string | undefined;
  databaseId?: string; refreshKey?: number; onChanged?: (edit: IdaEdit) => void; onBusyChange?: (busy: boolean) => void; visible?: boolean; previewDatabases?: IdaState;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [state, setState] = useState<IdaState>();
  const [selected, setSelected] = useState("");
  const [path, setPath] = useState(initialPath ?? "");
  const [view, setView] = useState<IdaView>("overview");
  const [target, setTarget] = useState("");
  const [action, setAction] = useState<IdaEdit["action"]>("rename");
  const [value, setValue] = useState("");
  const [save, setSave] = useState(true);
  const [repeatable, setRepeatable] = useState(false);
  const [page, setPage] = useState<LoadedPage>();
  const [review, setReview] = useState<IdaResultMap["ida.prepare"]>();
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const epoch = useRef(0), locked = useRef(false);
  const dbId = databaseId ?? selected;
  const db = state?.databases.find(row => row.id === dbId);
  const can = (kind: string) => preview || available && !!sessionId && capabilities.includes(kind);
  const fenced = !!db?.identity && db.version !== undefined && state?.available;
  const canView = can("ida.view") && fenced && !db?.busy;
  const canEdit = can("ida.prepare") && can("ida.commit") && fenced && !db?.busy;
  const label = (id: IdaView) => VIEW_LABELS[id][zh ? 0 : 1];
  const editLabel = (id: IdaEdit["action"]) => EDIT_LABELS[id][zh ? 0 : 1];
  const invoke = useCallback(async <K extends keyof IdaResultMap>(kind: K, input: CommandInput<K>): Promise<IdaResultMap[K]> => {
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: IdaResultMap[K] }>(client, handle.requestId, 330_000)).result;
  }, [client]);
  const run = async (job: (generation: number) => Promise<void>) => {
    if (locked.current) return;
    const generation = epoch.current;
    locked.current = true; setBusy(true); onBusyChange?.(true); setError("");
    try { await job(generation); }
    catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "IDA 操作失败，请刷新数据库状态后重试。" : "IDA operation failed. Refresh the database before retrying.")); }
    finally { if (generation === epoch.current) { locked.current = false; setBusy(false); onBusyChange?.(false); } }
  };
  const refresh = async (generation: number) => {
    const next = preview ? structuredClone(previewDatabases ?? PREVIEW_IDA) : await invoke("ida.status", { sessionId: sessionId! });
    if (generation === epoch.current) setState(next);
  };
  useEffect(() => {
    const generation = ++epoch.current;
    locked.current = false; setBusy(false); onBusyChange?.(false); setState(preview ? structuredClone(previewDatabases ?? PREVIEW_IDA) : undefined);
    setCapabilities([]); setReview(undefined); setPage(undefined); setError(""); setResult(""); setSelected(""); setEditing(false);
    if (!preview && available && sessionId) void client.query("capabilities.get", {}).then(async next => {
      if (generation !== epoch.current) return;
      const ids = next.capabilities.filter(cap => cap.grade !== "unavailable").map(cap => cap.id);
      setCapabilities(ids);
      if (ids.includes("ida.status")) await refresh(generation);
    }).catch(cause => { if (generation === epoch.current) setError(hostErrorMessage(cause, "IDA unavailable")); });
    return () => { epoch.current++; onBusyChange?.(false); };
  }, [client, sessionId, available, preview]);
  useEffect(() => { setPath(initialPath ?? ""); }, [initialPath]);
  useEffect(() => {
    setPage(undefined); setReview(undefined); setResult(""); setTarget(""); setEditing(false);
  }, [dbId]);
  useEffect(() => {
    if (refreshKey && (preview || capabilities.includes("ida.status"))) void run(refresh);
  }, [refreshKey]);
  useEffect(() => {
    if (!review) return;
    setExpired(Date.now() >= review.expiresAt);
    const timer = setTimeout(() => setExpired(true), Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);

  const read = (offset = 0, previous?: number[]) => void run(async generation => {
    const binding: ReadBinding = previous !== undefined && page ? page.binding : {
      dbId, identity: db!.identity!, version: db!.version!, view, ...(target.trim() ? { target: target.trim() } : {}),
    };
    const moduleName = state?.databases.find(row => row.id === binding.dbId)?.label ?? "sample.exe";
    const databaseName = moduleName.includes(".") ? moduleName.slice(0, moduleName.lastIndexOf(".")) : moduleName;
    const previewText = PREVIEW_IDA_VIEWS[binding.view].replaceAll("sample.exe", moduleName).replaceAll("sample.i64", `${databaseName}.i64`);
    const next = preview
      ? { text: previewText, total: previewText.split("\n").length, offset: 0, truncated: false }
      : await invoke("ida.view", { sessionId: sessionId!, ...binding, offset });
    if (generation === epoch.current) setPage({ ...next, binding, previous: previous ?? [] });
  });
  // The embedded browser starts with a read-only overview, never a hidden Python request.
  useEffect(() => {
    if (databaseId && visible && canView && !locked.current && (!["pseudocode", "asm", "xrefs"].includes(view) || target.trim())) read();
  }, [databaseId, db?.identity, db?.version, visible, !!canView]);

  const buildEdit = (): IdaEdit => {
    if (action === "open") return { action, path };
    if (action === "close") return { action, dbId, save };
    if (action === "save") return { action, dbId };
    if (action === "exec") return { action, dbId, code: value };
    if (action === "rename") return { action, dbId, target, name: value };
    if (action === "set_type") return { action, dbId, target, decl: value };
    if (action === "comment") return { action, dbId, target, text: value, repeatable };
    return { action, dbId, target };
  };
  const prepare = (edit: IdaEdit) => void run(async generation => {
    const next = preview
      ? { token: "preview", edit, ...(db?.identity ? { identity: db.identity, version: db.version! } : {}), expiresAt: Date.now() + 300_000 }
      : await invoke("ida.prepare", { sessionId: sessionId!, edit });
    if (generation === epoch.current) { setReview(next); setEditing(false); }
  });
  const commit = () => {
    if (!review || expired || Date.now() >= review.expiresAt) return;
    const reviewed = review;
    void run(async generation => {
      // The server can consume a token before a connection fails. Never offer to replay it.
      setReview(undefined);
      if (preview) {
        if (reviewed.edit.action === "open") {
          const id = `preview-${Date.now()}`;
          const label = reviewed.edit.path.split(String.fromCharCode(92)).join("/").split("/").at(-1)!;
          setState(current => ({ ...current!, databases: [...current!.databases, { id, label, state: "open", dirty: false, busy: false, identity: `preview-${id}`, version: 1 }] }));
          setSelected(id);
        } else {
          const edit = reviewed.edit;
          setState(current => ({ ...current!, databases: edit.action === "close"
            ? current!.databases.filter(row => row.id !== edit.dbId)
            : current!.databases.map(row => row.id === edit.dbId ? { ...row, version: (row.version ?? 0) + 1, dirty: edit.action !== "save" } : row) }));
        }
        setResult(marks ? (zh ? "演示操作已完成" : "Demo operation completed") : (zh ? "操作已完成" : "Operation completed"));
      } else {
        const outcome = await invoke("ida.commit", { sessionId: sessionId!, token: reviewed.token });
        if (generation !== epoch.current) return;
        setResult(outcome.text); await refresh(generation);
      }
      if (generation === epoch.current) { setPage(undefined); onChanged?.(reviewed.edit); }
    });
  };
  const requiresTarget = ["pseudocode", "asm", "xrefs"].includes(view);
  const validEdit = ["save", "close"].includes(action) || (action === "exec" ? !!value.trim() : !!target.trim() && (action === "make_function" || action === "comment" || !!value.trim()));

  return <section className={`ida-browser ${databaseId ? "is-embedded" : ""}`} aria-label={zh ? "数据库视图与编辑" : "Database views and edits"}>
    {!databaseId ? <div className="ida-standalone-head">
      <div><h3>{zh ? "数据库视图与编辑" : "Database views and edits"}</h3><p>{zh ? "已授权的 IDA Pro / idalib 与匹配的 Python。所有修改均先核对再执行。" : "Licensed IDA Pro / idalib with matching Python. Review every edit before execution."}</p></div>
      <div className="ida-browser-toolbar"><AppSelect className="select" aria-label={zh ? "IDA 数据库" : "IDA database"} value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        <option value="">{zh ? "选择数据库" : "Select database"}</option>{state?.databases.map(row => <option key={row.id} value={row.id}>{row.label} · {row.state}</option>)}
      </AppSelect><button className="btn outline small" disabled={!can("ida.status") || busy} onClick={() => void run(refresh)}><Icon name="refresh" />{zh ? "检测 / 刷新" : "Detect / refresh"}</button></div>
      <details className="ida-disclosure"><summary>{zh ? "打开其他文件" : "Open another file"}</summary><div className="ida-open-row"><label>{zh ? "二进制 / 数据库路径" : "Binary / database path"}<input className="input" value={path} onChange={event => setPath(event.target.value)} /></label><button className="btn outline" disabled={!can("ida.prepare") || !state?.available || busy || !path.trim()} onClick={() => prepare({ action: "open", path })}>{zh ? "检查打开操作" : "Review open"}</button></div></details>
    </div> : null}
    {error && !editing ? <div className="ida-notice is-error" role="alert"><Icon name="alert-c" /><span>{error}</span><button className="btn small ghost" disabled={busy || !can("ida.status")} onClick={() => void run(refresh)}>{zh ? "刷新状态" : "Refresh"}</button></div> : null}
    {state?.reason ? <p className="ida-hint" role="status">{state.reason}</p> : null}
    {!can("ida.view") ? <WorkspaceEmpty icon="plug" title={zh ? "当前 Runtime 未提供数据库视图" : "Database views are unavailable"}>{zh ? "连接支持 IDA 分页查看的 Runtime 后使用。" : "Connect a Runtime with IDA view support."}</WorkspaceEmpty> : <>
      <div className="ida-browser-toolbar">
        <label className="ida-view-field">{zh ? "查看内容" : "View"}<AppSelect className="select" aria-label={zh ? "IDA 视图" : "IDA view"} value={view} disabled={busy} onChange={event => { setView(event.target.value as IdaView); setPage(undefined); }}>
          {IDA_VIEWS.map(id => <option key={id} value={id}>{label(id)}</option>)}
        </AppSelect></label>
        <label className="ida-target-field">{zh ? "地址 / 符号" : "Address / symbol"}<input className="input mono" value={target} disabled={busy} onChange={event => setTarget(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && canView && !busy && (!requiresTarget || target.trim())) read(); }} placeholder={requiresTarget ? "main / 0x140001000" : (zh ? "可选，输入符号或地址" : "Optional symbol or address")} /></label>
        <button className="btn outline" aria-label={zh ? "读取" : "Read"} disabled={!canView || busy || requiresTarget && !target.trim()} onClick={() => read()}><Icon name="search" />{busy ? (zh ? "读取中…" : "Reading…") : (zh ? "读取" : "Read")}</button>
      </div>
      <div className="ida-view-surface" aria-busy={busy}>
        <div className="ida-surface-bar"><span><Icon name="file-code" />{label(page?.binding.view ?? view)}{page?.binding.target ? <code>{page.binding.target}</code> : null}</span><button className="btn small ghost" disabled={!canEdit || busy} onClick={() => { setError(""); setEditing(true); }}><Icon name="pencil" />{zh ? "修改数据库" : "Edit database"}</button></div>
        {page ? <CapabilityEditor key={`${page.binding.dbId}:${page.binding.view}:${page.offset}`} label={zh ? "数据库视图内容" : "Database view content"} value={page.text} language={page.binding.view === "pseudocode" ? "cpp" : "text"} readOnly /> : <WorkspaceEmpty icon="file-code" title={busy ? (zh ? "正在读取数据库" : "Reading database") : (zh ? "选择视图，查看数据库" : "Choose a database view")}>
          {!fenced && db ? (zh ? "此数据库未提供身份和版本，暂时不能安全读取或修改。" : "This database has no identity or version for safe reads and edits.") : (zh ? "浏览函数、字符串和导入导出；输入地址或符号查看伪代码与交叉引用。" : "Browse functions, strings, imports and exports. Use a symbol or address for pseudocode and cross-references.")}
        </WorkspaceEmpty>}
        <footer className="ida-view-footer"><span>{page ? `${page.offset + (page.total ? 1 : 0)}-${Math.min(page.offset + 100, page.total)} / ${page.total}` : (zh ? "只读视图" : "Read-only view")}{page ? ` · v${page.binding.version}` : ""}</span>
          {page?.truncated ? <span>{zh ? "部分内容已截断" : "Content truncated"}</span> : null}<span className="spacer" />
          <button className="icon-btn" aria-label={zh ? "上一页" : "Previous page"} disabled={busy || !page?.previous.length} onClick={() => { if (page) read(page.previous.at(-1)!, page.previous.slice(0, -1)); }}><Icon name="chevron-l" /></button>
          <button className="icon-btn" aria-label={zh ? "下一页" : "Next page"} disabled={busy || page?.nextOffset === undefined} onClick={() => { if (page) read(page.nextOffset!, [...page.previous, page.offset]); }}><Icon name="chevron-r" /></button>
        </footer>
      </div>
    </>}
    {busy && can("ida.cancel") ? <div className="ida-cancel-row"><span>{zh ? "取消只中止本次等待或请求，不会回滚已完成的修改。" : "Cancellation stops this wait or request. It does not undo changes."}</span><button className="btn small outline" onClick={() => {
      if (preview) return;
      const generation = epoch.current;
      void invoke("ida.cancel", { sessionId: sessionId! }).then(outcome => { if (generation === epoch.current) setResult(outcome.cancelled ? (zh ? "已请求取消，正在等待结束。" : "Cancellation requested. Waiting for completion.") : (zh ? "没有可取消的请求。" : "No cancellable request.")); }).catch(cause => { if (generation === epoch.current) setError(hostErrorMessage(cause, "Cancel failed")); });
    }}>{zh ? "取消等待 / 执行" : "Cancel wait / execution"}</button></div> : null}
    {result ? <pre className="ida-operation-result" role="status">{result}</pre> : null}
    {editing ? <WorkspaceDialog title={zh ? "修改数据库" : "Edit database"} onClose={() => { if (!busy) setEditing(false); }}><div className="ida-edit-form">
      {error ? <div className="ida-notice is-error" role="alert">{error}</div> : null}
      <p className="ida-hint">{db?.label} · {zh ? "修改与其他代理共享。下一步核对具体操作与数据库版本。" : "Changes are shared with other agents. Review the operation and database version next."}</p>
      <label>{zh ? "操作" : "Operation"}<AppSelect className="select" aria-label={zh ? "IDA 操作" : "IDA action"} value={action} disabled={busy} onChange={event => { setAction(event.target.value as IdaEdit["action"]); setValue(""); }}>
        {(["rename", "comment", "set_type", "make_function", "exec", "save", "close"] as const).map(id => <option key={id} value={id}>{editLabel(id)}</option>)}
      </AppSelect></label>
      {!["exec", "save", "close"].includes(action) ? <label>{zh ? "目标地址 / 符号" : "Target address / symbol"}<input className="input mono" value={target} disabled={busy} onChange={event => setTarget(event.target.value)} placeholder="main / 0x140001000" /></label> : null}
      {["rename", "comment", "set_type", "exec"].includes(action) ? <label>{action === "rename" ? (zh ? "新名称" : "New name") : action === "set_type" ? (zh ? "C 类型声明" : "C declaration") : action === "exec" ? "Python" : (zh ? "注释内容" : "Comment")}
        <CapabilityEditor label={zh ? "操作内容" : "Operation content"} value={value} onChange={setValue} language={action === "exec" ? "python" : action === "set_type" ? "cpp" : "text"} readOnly={busy} />
      </label> : null}
      {action === "comment" ? <label className="ida-checkbox"><input type="checkbox" checked={repeatable} disabled={busy} onChange={event => setRepeatable(event.target.checked)} />{zh ? "可重复注释" : "Repeatable comment"}</label> : null}
      {action === "close" ? <><label className="ida-checkbox"><input type="checkbox" checked={save} disabled={busy} onChange={event => setSave(event.target.checked)} />{zh ? "关闭前保存" : "Save before closing"}</label><p className="ida-hint">{zh ? "不保存只丢弃尚未落盘的修改，不能撤销此前的自动保存。关闭会影响共享此数据库的代理。" : "Skipping save discards only unsaved changes, not prior autosaves. Closing affects agents sharing this database."}</p></> : null}
      <div className="ida-dialog-actions"><button className="btn outline" disabled={busy} onClick={() => setEditing(false)}>{zh ? "返回" : "Back"}</button><button className="btn primary" disabled={!canEdit || busy || !validEdit} onClick={() => prepare(buildEdit())}>{busy ? (zh ? "检查中…" : "Reviewing…") : (zh ? "检查操作" : "Review operation")}</button></div>
    </div></WorkspaceDialog> : null}
    {review ? <WorkspaceDialog title={zh ? "确认 IDA 操作" : "Confirm IDA operation"} onClose={() => setReview(undefined)}><div className="ida-edit-form">
      <div className="ida-review-heading"><Icon name="shield" /><div><strong>{editLabel(review.edit.action)}</strong><p>{review.identity ?? path}{review.version !== undefined ? ` · v${review.version}` : ""}</p></div></div>
      <pre className="ida-output">{JSON.stringify(review.edit, null, 2)}</pre>
      <p className="ida-hint">{review.edit.action === "exec" ? (zh ? "Python 可修改数据库并访问本机资源，请核对完整代码。" : "Python can modify the database and access local resources. Review the full code.") : (zh ? "确认只授权上方操作。数据库版本变化后，需要重新检查；不会自动重试。" : "This confirms only the operation above. A changed database requires a new review. No automatic retries.")}</p>
      {expired ? <p className="ida-notice is-error" role="alert">{zh ? "确认已过期，请返回重新检查操作。" : "This review expired. Go back and review the operation again."}</p> : null}
      <div className="ida-dialog-actions"><button className="btn outline" onClick={() => { setReview(undefined); setEditing(true); }}>{zh ? "返回" : "Back"}</button><button className="btn primary" disabled={busy || expired} onClick={commit}>{zh ? "确认执行" : "Confirm execution"}</button></div>
    </div></WorkspaceDialog> : null}
  </section>;
}
