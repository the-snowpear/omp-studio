import { useEffect, useRef, useState } from "react";
import type { StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import type { SessionResumeRow, SessionWorktreeResultMap } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_RESUME_SESSIONS } from "../preview/resumeScopePreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import type { NativeHistoryContext } from "./NativeArchivePane";

export function ResumeScopePane({ client, context, onOpen }: { client?: StudioClient | undefined; context?: NativeHistoryContext | undefined; onOpen?: ((sessionId: string, workspaceId: WorkspaceId) => void) | undefined }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [scope, setScope] = useState<"directory" | "repo">();
  const [rows, setRows] = useState<SessionResumeRow[]>([]); const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const enabled = preview || !!(client && context?.available && context.sessionId && context.capabilities?.capabilities.some(row => row.id === "worktrees.session.resume.list" && row.grade !== "unavailable"));
  useEffect(() => {
    const current = ++epoch.current; setRows([]); setError(""); setNotice(""); setBusy(false);
    if (preview) { setRows(PREVIEW_RESUME_SESSIONS.filter(row => scope !== "directory" || row.currentDirectory)); return; }
    if (!enabled || !client || !context?.sessionId) return;
    setBusy(true);
    void client.command("worktrees.session.resume.list", { sessionId: context.sessionId, ...(scope ? { scope } : {}) }).then(handle => waitReceipt<{ result: SessionWorktreeResultMap["worktrees.session.resume.list"] }>(client, handle.requestId)).then(({ result }) => {
      if (current !== epoch.current) return; setRows(result.sessions); setTruncated(result.truncated); if (!scope) setScope(result.scope);
    }).catch(cause => { if (current === epoch.current) setError(hostErrorMessage(cause, "Cannot read resume scope")); }).finally(() => { if (current === epoch.current) setBusy(false); });
    return () => { epoch.current++; };
  }, [preview, client, context?.sessionId, enabled, scope]);
  async function open(row: SessionResumeRow) {
    if (busy) return;
    if (preview) { setNotice(`${zh ? "演示恢复" : "Demo resume"}: ${row.title}`); return; }
    if (!client || !context?.sessionId || !onOpen) return;
    const current = epoch.current; setBusy(true); setError("");
    try {
      const handle = await client.command("worktrees.session.resume.prepare", { sessionId: context.sessionId, targetSessionId: row.sessionId, scope: scope ?? "repo" });
      const { result } = await waitReceipt<{ result: SessionWorktreeResultMap["worktrees.session.resume.prepare"] }>(client, handle.requestId);
      if (current !== epoch.current) return;
      if (!result.workspaceId) throw Error("Resume workspace is unavailable");
      if (result.targetSessionId !== result.requestedSessionId) setNotice(zh ? "已定位到继续副本，恢复实际会话。" : "Resuming the continuing copy.");
      onOpen(result.targetSessionId, result.workspaceId as WorkspaceId);
    } catch (cause) { if (current === epoch.current) setError(hostErrorMessage(cause, "Cannot prepare resume")); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  return <section className="feature-pane" aria-label={zh ? "原生恢复范围" : "Native resume scope"}>
    <h2>{zh ? "原生恢复范围" : "Native resume scope"} {preview ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}</h2>
    <p className="small muted">{zh ? "按原生 session.worktreeScope 默认值列出当前目录或同仓库关联 Worktree 的会话。恢复前切到目标工作区；不改变当前项目的侧栏归属。" : "Uses native session.worktreeScope. Resume switches to the target workspace without mixing sibling history into this project's sidebar."}</p>
    <AppSelect aria-label={zh ? "恢复范围" : "Resume scope"} value={scope ?? "repo"} disabled={!enabled || busy} onChange={event => setScope(event.target.value as "directory" | "repo")}><option value="directory">{zh ? "仅当前目录" : "This directory"}</option><option value="repo">{zh ? "同仓库 Worktree" : "Repository worktrees"}</option></AppSelect>
    {!enabled ? <p className="muted">{zh ? "需要支持恢复范围的已连接 Runtime。" : "Connect a Runtime that supports resume scopes."}</p> : rows.map(row => <div key={row.sessionId} className="feature-row"><div><b>{row.title}</b><p className="tiny muted">{row.currentDirectory ? zh ? "当前目录" : "This directory" : zh ? "关联 Worktree" : "Sibling worktree"} · {row.modifiedAt}{row.continuationOf ? zh ? " · 继续副本" : " · Continuation" : ""}</p></div><button type="button" className="btn small outline" disabled={busy || (!preview && !onOpen)} onClick={() => void open(row)}>{zh ? "恢复" : "Resume"}</button></div>)}
    {enabled && !busy && !rows.length ? <p className="muted">{zh ? "这个范围内没有会话。" : "No sessions in this scope."}</p> : null}
    {busy ? <p role="status">{zh ? "读取原生会话…" : "Reading native sessions…"}</p> : null}{truncated ? <p className="tiny muted">{zh ? "最多显示最近 200 条。" : "Showing at most 200 sessions."}</p> : null}
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
  </section>;
}
