import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { RecordingPlayer } from "./RecordingPlayer";
import "./recordings.css";
type Api = NonNullable<typeof globalThis.ompStudioTerminal>;
type Status = Awaited<ReturnType<NonNullable<Api["recordingStatus"]>>>;
export function TerminalRecordingControls({ api, id, ended, workspaceId, sessionId }: { api: Api; id: string; ended: boolean; workspaceId?: string | undefined; sessionId?: string | undefined }) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<Status>(); const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [playback, setPlayback] = useState(false); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await api.recordingStatus?.(id); if (active) setStatus(value); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) timer = setTimeout(() => void poll(), 1000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [api, id, refresh]);
  const run = async (action: () => Promise<Status | undefined>) => {
    if (busy) return; setBusy(true); setError("");
    try { const value = await action(); setStatus(value); setRefresh(value => value + 1); setConfirm(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const recording = status?.state === "recording";
  return <>
    <div className="terminal-recording-controls"><button className="btn small outline" disabled={busy || !api.recordingStart || ended || status?.state === "saving"} onClick={() => recording ? void run(() => api.recordingStop?.(id) ?? Promise.resolve(undefined)) : setConfirm(true)}>{recording ? zh ? "停止并保存录制" : "Stop and save recording" : zh ? "录制 Shell" : "Record shell"}</button>
      {status && status.state !== "idle" ? <span className="mono">{status.state} · {(status.elapsedMs / 1000).toFixed(0)}s · {(status.bytes / 1024).toFixed(0)} KiB</span> : null}
      <button className="btn small" onClick={() => setPlayback(value => !value)}>{playback ? zh ? "收起回放" : "Hide playback" : zh ? "录制回放" : "Playback"}</button>
      {status?.artifactId ? <span className="muted">{zh ? "已存入产物库，可在媒体页导出" : "Saved to the artifact library; export from Media"}</span> : null}
    </div>
    {confirm ? <div className="terminal-recording-confirm"><p>{zh ? "从现在开始保存这个终端的输出和尺寸，不记录按键。输出中的敏感内容也会进入录制文件。关闭终端会自动停止并保存。" : "Capture this terminal’s output and size from now on, without recording keystrokes. Sensitive output is included. Closing the terminal stops and saves the recording."}</p><button className="btn small primary" disabled={busy || ended} onClick={() => void run(() => api.recordingStart?.({ id, ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) }) ?? Promise.resolve(undefined))}>{zh ? "开始录制" : "Start recording"}</button><button className="btn small" onClick={() => setConfirm(false)}>{zh ? "取消" : "Cancel"}</button></div> : null}
    {error || status?.notice ? <p className="small" role="status">{error || status?.notice}</p> : null}
    {playback ? <RecordingPlayer key={status?.artifactId ?? "import"} artifactId={status?.artifactId} /> : null}
  </>;
}
