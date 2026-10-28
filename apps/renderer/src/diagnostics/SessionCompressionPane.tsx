import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "@omp-studio/client-contract";
import type { CompressionState, AutoCompressionStatus, SessionCompressionResultMap } from "@omp-studio/studio-protocol";
import type { FeatureSettingsProps } from "../settings/useFeatureSettings";
import { FeatureSettingsPane } from "../settings/FeatureSettingsPane";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewCompression } from "../preview/sessionCompressionPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import "./sessionCompression.css";
const size = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
export function SessionCompressionPane(props: FeatureSettingsProps) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [state, setState] = useState<CompressionState>({ phase: "idle" }), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [automatic, setAutomatic] = useState<AutoCompressionStatus>();
  const epoch = useRef(0), lock = useRef(false);
  const supports = (id: string) => preview || props.context?.capabilities?.capabilities.some(row => row.id === id && row.grade !== "unavailable") === true;
  const enabled = preview || !!(props.client && props.context?.available && props.context.sessionId && supports("maintenance.compression.scan"));
  const invoke = useCallback(async <K extends keyof SessionCompressionResultMap>(kind: K, input: CommandInput<K>) => {
    if (!props.client) throw Error("Runtime unavailable");
    const handle = await props.client.command(kind, input);
    return (await waitReceipt<{ result: SessionCompressionResultMap[K] }>(props.client, handle.requestId, 120000)).result;
  }, [props.client]);
  useEffect(() => {
    const current = ++epoch.current; lock.current = false; setBusy(false); setError(""); setState({ phase: "idle" });
    if (props.visible && enabled && !preview) void invoke("maintenance.compression.status", { sessionId: props.context!.sessionId! }).then(result => { if (current === epoch.current) setState(result); }).catch(cause => { if (current === epoch.current) setError(hostErrorMessage(cause, "Cannot read compression state")); });
    return () => { epoch.current++; };
  }, [props.visible, props.context?.sessionId, enabled, preview, invoke]);
  const working = busy || state.phase === "scanning" || state.phase === "applying";
  useEffect(() => {
    if (!props.visible || !working || preview || !enabled) return;
    const current = epoch.current;
    const timer = setInterval(() => { if (!document.hidden) void invoke("maintenance.compression.status", { sessionId: props.context!.sessionId! }).then(result => { if (current === epoch.current) setState(result); }).catch(() => {}); }, 1200);
    return () => clearInterval(timer);
  }, [props.visible, working, preview, enabled, props.context?.sessionId, invoke]);
  async function run(apply: boolean) {
    if (lock.current || !enabled || apply && !state.token) return;
    const current = epoch.current, token = state.token;
    lock.current = true; setBusy(true); setError(""); setState(previous => ({ ...previous, phase: apply ? "applying" : "scanning" }));
    try {
      const result = preview ? previewCompression(apply) : apply ? await invoke("maintenance.compression.apply", { sessionId: props.context!.sessionId!, token: token! }) : await invoke("maintenance.compression.scan", { sessionId: props.context!.sessionId! });
      if (current === epoch.current) setState(result);
    } catch (cause) { if (current === epoch.current) { const message = hostErrorMessage(cause, "Compression failed"); setError(message); setState({ phase: "failed", error: message }); } }
    finally { if (current === epoch.current) { lock.current = false; setBusy(false); } }
  }
  const summary = state.summary;
  return <section className="compression-pane" aria-label={zh ? "会话存储压缩" : "Session storage compression"}>
    <header className="feature-settings-head"><div><span className="feature-eyebrow">{zh ? "存储维护" : "STORAGE MAINTENANCE"}{preview ? zh ? " · 演示" : " · DEMO" : ""}</span><h3>{zh ? "压缩闲置会话，保留完整历史" : "Compress idle sessions, retain full history"}</h3></div><button className="btn outline" disabled={!enabled || working} onClick={() => void run(false)}>{working ? zh ? "处理中…" : "Working…" : zh ? "扫描候选文件" : "Scan candidates"}</button></header>
    <p className="feature-status">{zh ? "使用文件系统透明压缩，不删除会话。原生引擎跳过正在使用的会话；执行前重新检查文件身份，只处理本次预览中的文件。" : "Filesystem compression preserves sessions. Native checks skip active sessions and changed files; only reviewed candidates are processed."}</p>
    {!enabled ? <p className="feature-status">{zh ? "连接支持透明压缩的 Runtime 后可扫描。" : "Connect a Runtime with filesystem compression support."}</p> : null}
    {working ? <div className="transfer-progress" role="status"><progress /><span>{state.phase === "applying" ? zh ? "正在压缩已审核的文件…" : "Compressing reviewed files…" : zh ? "正在检查文件系统和闲置会话…" : "Checking filesystem and idle sessions…"}</span></div> : null}
    {summary ? <div className="feature-detail">{!summary.supported ? <p role="status" className="feature-status">{zh ? "此存储位置不支持 NTFS/APFS 透明压缩。" : "This storage location does not support NTFS/APFS compression."}</p> : <>
      <div className="compression-facts"><span><small>{zh ? "候选文件" : "Candidate files"}</small><strong>{summary.candidates}</strong></span><span><small>{zh ? "占用空间" : "Allocated space"}</small><strong>{size(summary.allocatedBefore)}</strong></span><span><small>{zh ? "跳过活动会话" : "Active sessions skipped"}</small><strong>{summary.skippedLive}</strong></span></div>
      {state.phase === "complete" ? <p role="status" className="feature-status">{zh ? "已压缩" : "Compressed"} {summary.compressed} / {summary.candidates} · {zh ? "处理后占用" : "Allocated after processing"} {size(summary.allocatedAfter)}</p> : null}
      {summary.files.length ? <div className="compression-table"><table><thead><tr><th>{zh ? "文件" : "File"}</th><th>{zh ? "原始大小" : "Logical size"}</th><th>{zh ? "磁盘占用" : "On disk"}</th></tr></thead><tbody>{summary.files.map(file => <tr key={file.name}><td><span className="mono">{file.name}</span><small>{file.sessionId}</small></td><td>{size(file.bytes)}</td><td>{size(file.allocated)}</td></tr>)}</tbody></table></div> : <p className="feature-status">{zh ? "没有符合条件的文件。" : "No eligible files."}</p>}
      {summary.truncated ? <p className="feature-status">{zh ? "本次最多处理 200 个文件，完成后可再次扫描。" : "This batch includes up to 200 files. Scan again after completion."}</p> : null}
      {state.phase === "ready" ? <div className="feature-actions"><button className="btn primary" disabled={working || !supports("maintenance.compression.apply") || !summary.candidates || Date.now() >= (state.expiresAt ?? 0)} onClick={() => void run(true)}>{zh ? "压缩这些文件" : "Compress these files"}</button><span className="feature-status">{zh ? "预览有效期 5 分钟" : "Preview expires in 5 minutes"} · {summary.method?.toUpperCase()}</span></div> : null}
    </>}{summary.errors.map((message, index) => <p className="feature-error" role="alert" key={index}>{message}</p>)}</div> : null}
    {error || state.error ? <p className="feature-error" role="alert">{error || state.error}</p> : null}
    <details><summary>{zh ? "最近自动压缩日志" : "Latest automatic compression log"}</summary><button className="btn small outline" onClick={() => {
      if (preview) { setAutomatic({ enabled: false, log: "演示：compress skipped: unsupported on this filesystem" }); return; }
      if (props.client && props.context?.sessionId) void props.client.command("maintenance.compression.auto.status", { sessionId: props.context.sessionId }).then(handle => waitReceipt<{ result: AutoCompressionStatus }>(props.client!, handle.requestId)).then(result => setAutomatic(result.result)).catch(cause => setError(hostErrorMessage(cause, "Compression log unavailable")));
    }}>{zh ? "读取日志" : "Read log"}</button>{automatic ? <><p>{automatic.enabled ? "Enabled" : "Disabled"} · {automatic.ranAt ? new Date(automatic.ranAt).toLocaleString() : "—"}</p><pre>{automatic.log}</pre></> : null}</details>
    <FeatureSettingsPane {...props} group="maintenance" />
  </section>;
}
