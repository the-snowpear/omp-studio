import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInput, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import type { SessionWorktreeResultMap, SessionWorktreeRow, WorktreeRemovalPreview } from "@omp-studio/studio-protocol";
import type { FeatureSettingsProps } from "../settings/useFeatureSettings";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_SESSION_WORKTREES } from "../preview/sessionWorktreesPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import "./sessionWorktrees.css";

async function invoke<K extends keyof SessionWorktreeResultMap>(client: StudioClient, kind: K, input: CommandInput<K>): Promise<SessionWorktreeResultMap[K]> {
  const handle = await client.command(kind, input);
  return (await waitReceipt<{ result: SessionWorktreeResultMap[K] }>(client, handle.requestId, 120000)).result;
}
async function openWorkspace(client: StudioClient, workspaceId: string, fresh: boolean) {
  const opened = await client.command("workspace.open", { workspaceId: workspaceId as WorkspaceId });
  await waitReceipt(client, opened.requestId);
  if (fresh) { const created = await client.command("session.create", {}); await waitReceipt(client, created.requestId, 60000); }
}

/** The Runtime independently fences the first prompt until this choice has been resolved. */
export function WorktreeLaunchGate(props: FeatureSettingsProps & { onGateChange(blocked: boolean): void; onOpenWorkspace?: ((workspaceId: string) => Promise<void>) | undefined }) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [phase, setPhase] = useState<"idle" | "checking" | "ask" | "creating" | "continuing" | "failed">("idle"), [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const epoch = useRef(0), lock = useRef(false), moving = useRef(false);
  const openWorkspaceAction = useRef(props.onOpenWorkspace);
  useLayoutEffect(() => { openWorkspaceAction.current = props.onOpenWorkspace; }, [props.onOpenWorkspace]);
  const supported = !!props.context?.capabilities?.capabilities.some(row => row.id === "worktrees.session.startPolicy" && row.grade !== "unavailable");
  const enabled = !preview && supported && props.context?.available && props.client && props.context.sessionId;
  const gate = props.onGateChange;
  const create = useCallback(async (current: number) => {
    if (!props.client || !props.context?.sessionId || lock.current) return;
    lock.current = true; setPhase("creating"); setError("");
    try {
      const result = await invoke(props.client, "worktrees.session.create", { sessionId: props.context.sessionId, freshOnly: true, keepChanges: false });
      if (epoch.current !== current) return;
      if (!result.workspaceId) throw Error("Created worktree could not be registered");
      moving.current = true;
      if (openWorkspaceAction.current) await openWorkspaceAction.current(result.workspaceId);
      else await openWorkspace(props.client, result.workspaceId, true);
      if (epoch.current === current) { setPhase("idle"); gate(false); }
    } catch (cause) { if (epoch.current === current) { setPhase("failed"); setError(hostErrorMessage(cause, "Worktree creation failed")); } }
    finally { if (epoch.current === current) { lock.current = false; moving.current = false; } }
  }, [props.client, props.context?.sessionId, gate]);
  useLayoutEffect(() => {
    if (moving.current && enabled) return;
    const current = ++epoch.current; lock.current = false; setError(""); setDismissed(false);
    if (!enabled) { setPhase("idle"); gate(false); return; }
    setPhase("checking"); gate(true);
    void invoke(props.client!, "worktrees.session.startPolicy", { sessionId: props.context!.sessionId! }).then(policy => {
      if (current !== epoch.current) return;
      if (!policy.eligible || policy.policy === "off") { setPhase("idle"); gate(false); }
      else if (policy.policy === "create") void create(current);
      else setPhase("ask");
    }).catch(cause => { if (current === epoch.current) { setPhase("failed"); setError(hostErrorMessage(cause, "Cannot read worktree policy")); } });
    return () => { if (!moving.current) { epoch.current++; gate(false); } };
  }, [enabled, props.context?.sessionId, props.client, create, gate]);
  useEffect(() => () => { epoch.current++; gate(false); }, [gate]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDismissed(true); };
    if (phase === "idle" || phase === "checking" || dismissed) return;
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [phase, dismissed]);
  async function continueHere() {
    if (lock.current) return;
    if (!props.client || !props.context?.sessionId) { setPhase("idle"); gate(false); return; }
    const current = epoch.current; lock.current = true; setPhase("continuing"); setError("");
    try { await invoke(props.client, "worktrees.session.continueHere", { sessionId: props.context.sessionId }); if (epoch.current === current) { setPhase("idle"); gate(false); } }
    catch (cause) { if (epoch.current === current) { setPhase("failed"); setError(hostErrorMessage(cause, "Cannot continue in this workspace")); } }
    finally { if (epoch.current === current) lock.current = false; }
  }
  if (phase === "idle" || phase === "checking") return null;
  if (dismissed) return <div className="feature-status" role="status">
    {zh ? "发送前需完成工作区选择。关闭提示不会取消正在执行的操作。" : "Resolve the workspace choice before sending. Dismissing does not cancel an operation in progress."}
    <button className="btn small ghost" onClick={() => setDismissed(false)}>{zh ? "显示工作区选择" : "Show workspace choice"}</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
  return createPortal(<div className="worktree-modal-backdrop"><section className="worktree-modal worktree-launch" role="dialog" aria-modal="true" aria-label={zh ? "新会话工作区" : "New session workspace"}>
    <header className="feature-settings-head"><span className="feature-eyebrow">{zh ? "独立工作目录" : "ISOLATED WORKSPACE"}</span><button className="icon-btn" aria-label={zh ? "关闭工作区选择" : "Close workspace choice"} onClick={() => setDismissed(true)}><Icon name="x" /></button></header>
    <h2>{zh ? "为这次任务创建 Worktree" : "Create a worktree for this task"}</h2><p>{zh ? "从当前 HEAD 创建独立分支。原工作区的未提交修改保持原样，新会话在独立目录中运行。" : "Create a branch from HEAD. Uncommitted source changes stay in place; the new session runs in its own directory."}</p>
    {phase === "creating" || phase === "continuing" ? <p role="status"><progress /> {phase === "creating" ? zh ? "正在准备分支与新会话…" : "Preparing the branch and session…" : zh ? "正在确认当前工作区…" : "Confirming the current workspace…"}</p> : <div className="feature-actions"><button className="btn primary" onClick={() => void create(epoch.current)}>{zh ? "创建并进入" : "Create and open"}</button><button className="btn outline" onClick={() => void continueHere()}>{zh ? "留在当前工作区" : "Stay in this workspace"}</button></div>}
    {error ? <p role="alert" className="feature-error">{error}</p> : null}
  </section></div>, document.body);
}

export function SessionWorktreesPane(props: FeatureSettingsProps & { launcher?: boolean; onOpenWorkspace?: ((workspaceId: string) => Promise<void>) | undefined }) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(!props.launcher), [rows, setRows] = useState<SessionWorktreeRow[]>([]);
  const [selected, setSelected] = useState(""), [branch, setBranch] = useState(""), [keepChanges, setKeepChanges] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [removal, setRemoval] = useState<WorktreeRemovalPreview>();
  const epoch = useRef(0), lock = useRef(false);
  const enabled = preview || !!(props.client && props.context?.available && props.context.sessionId && props.context.capabilities?.capabilities.some(row => row.id === "worktrees.session.list" && row.grade !== "unavailable"));
  const refresh = useCallback(async () => {
    if (preview) { setRows(structuredClone(PREVIEW_SESSION_WORKTREES)); return; }
    if (!enabled || !props.client || !props.context?.sessionId) return;
    const current = epoch.current;
    const result = await invoke(props.client, "worktrees.session.list", { sessionId: props.context.sessionId });
    if (current === epoch.current) setRows(result.worktrees);
  }, [preview, enabled, props.client, props.context?.sessionId]);
  useEffect(() => { epoch.current++; lock.current = false; setBusy(false); setRows([]); setError(""); setNotice(""); setRemoval(undefined); if (props.visible && open) void refresh().catch(cause => setError(hostErrorMessage(cause, "Cannot read worktrees"))); return () => { epoch.current++; }; }, [props.visible, open, refresh]);
  useEffect(() => { if (!open || !props.launcher) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !lock.current) setOpen(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [open, props.launcher]);
  async function run(action: () => Promise<void>) {
    if (lock.current || !enabled) return;
    const current = epoch.current; lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { if (current === epoch.current) setError(hostErrorMessage(cause, "Worktree operation failed")); }
    finally { if (current === epoch.current) { lock.current = false; setBusy(false); } }
  }
  const picked = rows.find(row => row.id === selected) ?? rows[0];
  const body = <section className={props.launcher ? "worktree-modal" : "worktree-pane"} role={props.launcher ? "dialog" : "region"} aria-modal={props.launcher ? true : undefined} aria-label={zh ? "会话 Worktree" : "Session worktrees"}>
    <header className="feature-settings-head"><div><span className="feature-eyebrow">{zh ? "并行工作区" : "PARALLEL WORKSPACES"}{preview ? zh ? " · 演示" : " · DEMO" : ""}</span><h3>{zh ? "会话 Worktree" : "Session worktrees"}</h3></div><div className="feature-actions"><button className="btn small ghost" disabled={!enabled || busy} onClick={() => void run(refresh)}>{zh ? "刷新" : "Refresh"}</button>{props.launcher ? <button className="icon-btn" aria-label={zh ? "关闭 Worktree 管理" : "Close worktree manager"} disabled={busy} onClick={() => setOpen(false)}><Icon name="x" /></button> : null}</div></header>
    <p className="feature-status">{zh ? "每个目录拥有自己的分支与会话。创建不会清理源工作区；移除前会检查改动、活动会话和目录是否发生变化。" : "Each directory has its own branch and sessions. Creation preserves the source checkout; removal checks changes, active sessions and directory identity."}</p>
    {!enabled ? <p className="feature-status">{zh ? "连接支持会话 Worktree 的 Runtime 后可管理。" : "Connect a Runtime with session worktree support."}</p> : null}
    <div className="worktree-create"><input className="input" aria-label={zh ? "新 Worktree 分支" : "New worktree branch"} maxLength={150} placeholder={zh ? "分支名，留空自动生成" : "Branch name, or leave empty"} value={branch} disabled={busy} onChange={event => setBranch(event.target.value)} /><label className="small"><input type="checkbox" checked={keepChanges} disabled={busy} onChange={event => setKeepChanges(event.target.checked)} />{zh ? "复制未提交修改" : "Copy uncommitted changes"}</label><button className="btn primary" disabled={!enabled || busy || !!branch && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch)} onClick={() => void run(async () => {
      if (preview) { const row = { ...PREVIEW_SESSION_WORKTREES[0]!, id: crypto.randomUUID(), branch: branch || "wt/new-task", hasCommits: false }; setRows(previous => [row, ...previous]); setSelected(row.id); setNotice(zh ? "演示目录已创建，未写入磁盘。" : "Demo worktree created; no files written."); return; }
      const created = await invoke(props.client!, "worktrees.session.create", { sessionId: props.context!.sessionId!, ...(branch ? { branch } : {}), keepChanges });
      await refresh(); setSelected(created.worktree.id); setNotice(zh ? "Worktree 已创建，可以打开并开始新会话。" : "Worktree created. Open it to start a session.");
    })}>{busy ? zh ? "处理中…" : "Working…" : zh ? "创建 Worktree" : "Create worktree"}</button></div>
    <div className="feature-split"><nav className="feature-list" aria-label={zh ? "Worktree 列表" : "Worktrees"}>{rows.map(row => <button key={row.id} aria-pressed={picked?.id === row.id} onClick={() => { setSelected(row.id); setRemoval(undefined); }}><span>{row.branch}</span><small>{row.current ? zh ? "当前" : "Current" : row.dirty ? zh ? "有改动" : "Modified" : row.missing ? zh ? "不可用" : "Unavailable" : zh ? "干净" : "Clean"}</small></button>)}</nav>
      {picked ? <div className="feature-detail" key={picked.id}><h4>{picked.branch}</h4><p className="mono worktree-path">{picked.directory}</p><p className="feature-status">{zh ? "创建于会话" : "Created from session"} · {picked.sessionId}</p><p className="feature-status">{picked.dirty ? zh ? "有未提交修改，请保存后再清理。" : "Uncommitted changes must be saved before cleanup." : picked.hasCommits ? zh ? "已有新提交，清理目录时保留分支。" : "New commits exist; the branch is retained on removal." : zh ? "没有新提交或未提交修改。" : "No new commits or uncommitted changes."}</p>{picked.reason ? <p role="alert">{picked.reason}</p> : null}
        <div className="feature-actions"><button className="btn outline" disabled={!enabled || busy || picked.missing} onClick={() => void run(async () => { if (preview) { setNotice(zh ? "演示：已选择此 Worktree。" : "Demo: worktree selected."); return; } const target = await invoke(props.client!, "worktrees.session.open", { sessionId: props.context!.sessionId!, id: picked.id }); if (!target.workspaceId) throw Error("Worktree workspace unavailable"); if (props.onOpenWorkspace) await props.onOpenWorkspace(target.workspaceId); else await openWorkspace(props.client!, target.workspaceId, true); setOpen(false); })}>{zh ? "打开并新建会话" : "Open and start session"}</button><button className="btn outline" disabled={!enabled || busy || picked.current || picked.dirty || picked.detached || picked.missing} onClick={() => void run(async () => { setRemoval(preview ? { token: crypto.randomUUID(), expiresAt: Date.now() + 300000, worktree: picked, keepBranch: picked.hasCommits } : await invoke(props.client!, "worktrees.session.remove.prepare", { sessionId: props.context!.sessionId!, id: picked.id })); })}>{zh ? "检查移除" : "Review removal"}</button></div>
        {removal ? <div className="worktree-removal" role="alertdialog" aria-label={zh ? "确认移除 Worktree" : "Confirm worktree removal"}><strong>{zh ? "移除此工作目录？" : "Remove this working directory?"}</strong><p>{removal.keepBranch ? zh ? "已有提交的分支会保留。忽略文件也会随目录移除。" : "The committed branch is retained. Ignored files are removed with the directory." : zh ? "目录及无新提交的临时分支将移除，包括忽略文件。" : "The directory and unmodified temporary branch will be removed, including ignored files."}</p><div className="feature-actions"><button className="btn danger" disabled={busy || Date.now() >= removal.expiresAt} onClick={() => void run(async () => { const result = preview ? { removed: true, messages: [] } : await invoke(props.client!, "worktrees.session.remove.apply", { sessionId: props.context!.sessionId!, token: removal.token }); if (result.removed) setRows(previous => previous.filter(row => row.id !== removal.worktree.id)); setRemoval(undefined); setNotice(result.messages.join(" · ") || (result.removed ? zh ? "Worktree 已移除。" : "Worktree removed." : zh ? "状态已变化，Worktree 已保留。请刷新后重试。" : "Worktree changed and was kept. Refresh before retrying.")); })}>{zh ? "确认移除" : "Confirm removal"}</button><button className="btn ghost" disabled={busy} onClick={() => setRemoval(undefined)}>{zh ? "取消" : "Cancel"}</button></div></div> : null}
      </div> : <div className="worktree-empty"><Icon name="fork" /><strong>{zh ? "还没有会话 Worktree" : "No session worktrees yet"}</strong><p>{zh ? "创建独立目录，便于同时处理不同任务。" : "Create a dedicated checkout to work on another task."}</p></div>}</div>
    {error ? <p className="feature-error" role="alert">{error}</p> : null}{notice ? <p className="feature-status" role="status">{notice}</p> : null}
  </section>;
  if (!props.launcher) return body;
  return <><button className="btn small outline worktree-launcher" disabled={!enabled} onClick={() => setOpen(true)}><Icon name="fork" />{zh ? "管理会话 Worktree" : "Manage session worktrees"}</button>{open ? createPortal(<div className="worktree-modal-backdrop">{body}</div>, document.body) : null}</>;
}
