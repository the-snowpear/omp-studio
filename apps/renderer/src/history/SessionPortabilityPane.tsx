import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, SessionHistoryEntry, StudioClient, WorkspaceId, WorkspaceRecord } from "@omp-studio/client-contract";
import type { SessionPortabilityResultMap, SessionPortabilityStatus } from "@omp-studio/studio-protocol";
import type { NativeHistoryContext } from "./NativeArchivePane";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_TRANSFER_SESSIONS, previewTransferExport, previewTransferImport } from "../preview/sessionPortabilityPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";
import "./sessionPortability.css";

export function SessionPortabilityPane({ client, context, visible, entries, onImported, onOpen }: {
  client?: StudioClient | undefined; context?: NativeHistoryContext | undefined; visible: boolean;
  entries: readonly SessionHistoryEntry[]; onImported?: (() => void) | undefined;
  onOpen?: ((sessionId: string, workspaceId: WorkspaceId) => void) | undefined;
}) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [selected, setSelected] = useState(""), [destination, setDestination] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [state, setState] = useState<SessionPortabilityStatus>({ phase: "idle" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [moveLabel, setMoveLabel] = useState(""), [confirmMove, setConfirmMove] = useState(false);
  const epoch = useRef(0), lock = useRef(false);
  const supports = (kind: string) => preview || context?.capabilities?.capabilities.some(row => row.id === kind && row.grade !== "unavailable") === true;
  const enabled = preview || !!(client && context?.sessionId && context.available && supports("session.portability.status"));
  const sessions = preview ? PREVIEW_TRANSFER_SESSIONS : entries.flatMap(row => row.sessionId ? [{ sessionId: row.sessionId as string, title: row.title || (zh ? "未命名会话" : "Untitled session") }] : []);
  const source = sessions.find(row => row.sessionId === selected) ?? sessions[0];
  const invoke = useCallback(async <K extends keyof SessionPortabilityResultMap>(kind: K, input: CommandInput<K>): Promise<SessionPortabilityResultMap[K]> => {
    if (!client) throw Error("Runtime unavailable");
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: SessionPortabilityResultMap[K] }>(client, handle.requestId, 120000)).result;
  }, [client]);
  useEffect(() => {
    const current = ++epoch.current; lock.current = false; setBusy(false); setError(""); setNotice(""); setState({ phase: "idle" }); setConfirmMove(false);
    if (!preview && enabled && visible && client && context?.sessionId) {
      void Promise.all([invoke("session.portability.status", { sessionId: context.sessionId }), client.query("projects.list", {})]).then(([status, projects]) => {
        if (current !== epoch.current) return;
        setState(status); setWorkspaces([...projects.workspaces]); setDestination(projects.activeWorkspaceId ?? projects.workspaces[0]?.workspaceId ?? "");
      }).catch(cause => { if (current === epoch.current) setError(hostErrorMessage(cause, "Cannot read transfer state")); });
    }
    return () => { epoch.current++; };
  }, [client, context?.sessionId, enabled, visible, preview, invoke]);
  const working = busy || ["preparing", "importing", "exporting"].includes(state.phase);
  useEffect(() => {
    if (!visible || preview || !enabled || !working || !context?.sessionId) return;
    const current = epoch.current;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void invoke("session.portability.status", { sessionId: context.sessionId! }).then(status => { if (current === epoch.current) setState(status); }).catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [visible, preview, enabled, working, context?.sessionId, invoke]);
  async function run(action: () => Promise<void>) {
    if (lock.current || !enabled) return;
    const current = epoch.current; lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { if (current === epoch.current) { const message = hostErrorMessage(cause, "Session transfer failed"); setError(message); setState({ phase: "failed", error: message }); } }
    finally { if (current === epoch.current) { lock.current = false; setBusy(false); } }
  }
  function exportSession(format: "pack" | "anonymous") {
    if (!source) return;
    const current = epoch.current;
    void run(async () => {
      setState({ phase: "exporting" });
      const result = preview ? previewTransferExport(format) : await invoke(format === "pack" ? "session.portability.pack" : "session.portability.anonymize", { sessionId: context!.sessionId!, targetSessionId: source.sessionId });
      if (current === epoch.current) setState({ phase: "complete", exported: result });
    });
  }
  function chooseArchive() {
    const current = epoch.current;
    void run(async () => {
      if (preview) { setState({ phase: "complete", preview: previewTransferImport() }); return; }
      const chosen = await globalThis.ompStudioChrome?.importArtifact?.({ kind: "export", sessionId: context!.sessionId! });
      if (current !== epoch.current || chosen?.ok && chosen.cancelled) return;
      if (!chosen?.ok || !chosen.artifact) throw Error(chosen && !chosen.ok ? chosen.message : "Desktop file picker unavailable");
      if (!chosen.artifact.name.toLowerCase().endsWith(".tar")) throw Error(zh ? "请选择 OMP 导出的 .tar 会话包。" : "Choose an OMP .tar session archive.");
      setState({ phase: "preparing" });
      const result = await invoke("session.portability.prepare", { sessionId: context!.sessionId!, artifactId: chosen.artifact.artifactId, ...(destination ? { targetWorkspaceId: destination } : {}) });
      if (current === epoch.current) setState({ phase: "complete", preview: result });
    });
  }
  function importArchive() {
    const review = state.preview; if (!review) return;
    const current = epoch.current;
    void run(async () => {
      setState({ phase: "importing", preview: review });
      const result = preview ? { sessionId: "demo-imported", mode: "forked" as const, workspaceId: "demo-workspace" } : await invoke("session.portability.import", { sessionId: context!.sessionId!, token: review.token });
      if (current === epoch.current) { setState({ phase: "complete", imported: result }); if (!preview) onImported?.(); }
    });
  }
  const review = state.preview, exported = state.exported;
  return <section className="transfer-workspace" aria-label={zh ? "会话迁移与诊断导出" : "Session transfer and diagnostic export"}>
    <header className="transfer-heading"><div><span className="feature-eyebrow">{zh ? "会话与工件" : "SESSIONS & ARTIFACTS"}{preview ? zh ? " · 演示" : " · DEMO" : ""}</span><h2>{zh ? "在另一处继续工作" : "Continue in another workspace"}</h2><p>{zh ? "迁移包含会话、子代理记录与相关工件。匿名导出用于诊断，移除消息正文与敏感内容。" : "Transfer conversations, subagent transcripts and artifacts. Anonymous exports remove conversation content for diagnostics."}</p></div><Icon name="export" /></header>
    {!enabled ? <p className="feature-status">{zh ? "连接支持迁移功能的 Runtime 后可操作。" : "Connect a compatible Runtime to transfer sessions."}</p> : null}
    <div className="transfer-columns"><section><h3>{zh ? "导出会话" : "Export a session"}</h3><label className="feature-status">{zh ? "来源会话" : "Source session"}<select className="select" value={source?.sessionId ?? ""} disabled={working || !sessions.length} onChange={event => { setSelected(event.target.value); setConfirmMove(false); }}>{sessions.map(row => <option key={row.sessionId} value={row.sessionId}>{row.title}</option>)}</select></label>
      <div className="transfer-choice"><Icon name="archive" /><div><strong>{zh ? "完整会话包" : "Complete session archive"}</strong><p>{zh ? "保留真实内容，可导入并继续。不会自动标记源会话已迁移。" : "Preserves content for continuation. The source is not marked as moved automatically."}</p></div><button className="btn outline" disabled={!enabled || working || !source || !supports("session.portability.pack")} onClick={() => exportSession("pack")}>{zh ? "打包" : "Pack"}</button></div>
      <div className="transfer-choice"><Icon name="file" /><div><strong>{zh ? "匿名诊断包" : "Anonymous diagnostic archive"}</strong><p>{zh ? "保留时序、用量与工具结构，正文替换为匿名标记。" : "Retains timing, usage and tool structure, replacing prose with redacted markers."}</p></div><button className="btn outline" disabled={!enabled || working || !source || !supports("session.portability.anonymize")} onClick={() => exportSession("anonymous")}>{zh ? "匿名导出" : "Anonymize"}</button></div>
      {exported ? <div className="transfer-result" role="status"><strong>{exported.asset.name}</strong><p>{exported.members} {zh ? "个文件" : "files"} · {(exported.asset.bytes / 1048576).toFixed(2)} MiB</p>{exported.warnings.map(warning => <p key={warning}>{warning}</p>)}<button className="btn primary" disabled={working} onClick={() => { if (preview) setNotice(zh ? "演示：文件已准备好，未写入磁盘。" : "Demo: file ready; nothing written."); else void run(async () => { const result = await globalThis.ompStudioChrome?.exportArtifact?.({ artifactId: exported.asset.artifactId }); if (!result?.ok) throw Error(result?.message ?? "Desktop export unavailable"); if (!result.cancelled) setNotice(zh ? "文件已保存。" : "File saved."); }); }}>{zh ? "保存文件…" : "Save file…"}</button></div> : null}
      <details className="transfer-advanced"><summary>{zh ? "源副本已交接" : "Source copy has moved"}</summary><p>{zh ? "在目标机器确认导入后，再标记源副本。以后恢复源副本会创建分支；请先切换离开该会话。" : "Mark only after confirming import on the destination. Resuming the source will fork it. Switch away from that session first."}</p><input className="input" aria-label={zh ? "迁移目标说明" : "Move destination label"} value={moveLabel} maxLength={256} onChange={event => { setMoveLabel(event.target.value); setConfirmMove(false); }} placeholder={zh ? "例如：办公室电脑" : "For example: office computer"} /><button className="btn small outline" disabled={!enabled || working || !source || !moveLabel.trim() || (!preview && source.sessionId === context?.sessionId)} onClick={() => setConfirmMove(true)}>{zh ? "标记已迁移" : "Mark moved"}</button>{confirmMove ? <div role="alertdialog" aria-label={zh ? "确认源副本已迁移" : "Confirm source moved"}><p>{source?.title} → {moveLabel}</p><button className="btn primary" disabled={working} onClick={() => void run(async () => { if (!preview) await invoke("session.portability.moved", { sessionId: context!.sessionId!, targetSessionId: source!.sessionId, label: moveLabel.trim() }); setConfirmMove(false); setNotice(zh ? "源副本已标记为迁移。" : "Source marked as moved."); })}>{zh ? "确认标记" : "Confirm"}</button><button className="btn ghost" onClick={() => setConfirmMove(false)}>{zh ? "取消" : "Cancel"}</button></div> : null}</details>
    </section><section><h3>{zh ? "导入会话包" : "Import a session archive"}</h3><label className="feature-status">{zh ? "目标工作区" : "Destination workspace"}<select className="select" value={preview ? "demo" : destination} disabled={working || !!review} onChange={event => setDestination(event.target.value)}>{preview ? <option value="demo">OMP Studio · 演示</option> : workspaces.map(row => <option key={row.workspaceId} value={row.workspaceId}>{row.name}{row.active ? " · " + (zh ? "当前" : "current") : ""}</option>)}</select></label>
      {!review && !state.imported ? <button className="transfer-drop" disabled={!enabled || working || !!review || !supports("session.portability.prepare") || (!preview && !globalThis.ompStudioChrome?.importArtifact)} onClick={chooseArchive}><Icon name="folder" /><strong>{zh ? "选择 OMP 会话包" : "Choose an OMP archive"}</strong><span>.tar · {zh ? "最多 64 MiB，先检查再导入" : "Up to 64 MiB; inspect before import"}</span></button> : null}
      {review ? <div className="transfer-review"><span className="feature-eyebrow">{zh ? "导入前检查" : "IMPORT REVIEW"}</span><h4>{review.title}</h4><dl><dt>{zh ? "源版本" : "Source version"}</dt><dd>OMP {review.upstreamVersion}</dd><dt>{zh ? "内容" : "Contents"}</dt><dd>{review.messages} {zh ? "条消息" : "messages"} · {review.artifacts} {zh ? "个工件" : "artifacts"} · {review.blobs} blobs</dd><dt>{zh ? "来源" : "From"}</dt><dd>{review.sourceDirectory}</dd><dt>{zh ? "目标" : "To"}</dt><dd>{review.destinationDirectory}</dd></dl><p>{review.conflicts ? zh ? "本地已有同 ID 会话。导入将创建新分支，保留原会话。" : "A local copy exists. Import creates a fork and preserves it." : zh ? "导入为独立会话，原有会话保持不变。" : "Import as a separate session, preserving existing sessions."}</p><div className="feature-actions"><button className="btn primary" disabled={working || Date.now() >= review.expiresAt} onClick={importArchive}>{zh ? "确认导入" : "Confirm import"}</button><button className="btn outline" disabled={working} onClick={() => void run(async () => { if (!preview) await invoke("session.portability.cancel", { sessionId: context!.sessionId!, token: review.token }); setState({ phase: "idle" }); })}>{zh ? "取消" : "Cancel"}</button></div></div> : null}
      {state.imported ? <div className="transfer-result" role="status"><strong>{zh ? "会话已导入" : "Session imported"}</strong><p>{state.imported.mode === "forked" ? zh ? "已创建分支，原会话保留。" : "Created a fork; original preserved." : zh ? "会话与工件已就绪。" : "Conversation and artifacts are ready."}</p><button className="btn primary" disabled={!preview && (!state.imported.workspaceId || !onOpen)} onClick={() => { if (preview) setNotice(zh ? "演示：已选择导入的会话。" : "Demo: imported session selected."); else if (state.imported?.workspaceId) onOpen?.(state.imported.sessionId, state.imported.workspaceId as WorkspaceId); }}>{zh ? "打开导入会话" : "Open imported session"}</button><button className="btn ghost" disabled={working} onClick={() => setState({ phase: "idle" })}>{zh ? "导入另一个会话包" : "Import another archive"}</button></div> : null}
    </section></div>
    {working ? <div className="transfer-progress" role="status"><progress /><span>{state.phase === "importing" ? zh ? "正在导入会话与工件…" : "Importing conversation and artifacts…" : state.phase === "preparing" ? zh ? "正在检查归档完整性…" : "Checking archive integrity…" : zh ? "正在处理…" : "Working…"}</span></div> : null}
    {error || state.error ? <p role="alert" className="feature-error">{error || state.error}</p> : null}{notice ? <p role="status" className="feature-status">{notice}</p> : null}
  </section>;
}
