import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { DictationResultMap, DictationState } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { openLiveCapture, type LiveCapture } from "../media/liveCapture";
import { ensureMicrophoneAccess, MicrophoneDeniedError, MicrophoneSettingsButton } from "../media/microphoneAccess";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";

const DEMO: DictationState = { available: true, enabled: true, phase: "off", text: "", model: "local/nemotron-streaming-en-0.6b", language: "zh", cloud: false, downloadRequired: false };

/** Capture has its own temporary text. Only an explicit stop merges it into the owner's draft. */
export function DictationControl({ client, sessionId, available, onText }: { client: StudioClient; sessionId?: string | undefined; available: boolean; onText(text: string): void }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const target = useExecutionTarget();
  const [state, setState] = useState<DictationState>(); const [review, setReview] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [denied, setDenied] = useState(false);
  const generation = useRef(0); const capture = useRef<LiveCapture | undefined>(undefined); const id = useRef<string | undefined>(undefined); const abort = useRef<AbortController | undefined>(undefined); const locked = useRef(false); const finishing = useRef(false); const callback = useRef(onText); callback.current = onText;
  const enabled = preview || (available && !!sessionId && !target.id && !!globalThis.ompStudioChrome?.attachLiveAudio);
  const invoke = useCallback(async <K extends keyof DictationResultMap>(kind: K, input: CommandInput<K>): Promise<DictationState> => {
    const handle = await client.command(kind, input); return (await waitReceipt<{ result: DictationState }>(client, handle.requestId, kind === "dictation.stop" ? 130000 : 30000)).result;
  }, [client]);
  const cancel = useCallback(() => {
    generation.current++; abort.current?.abort(); capture.current?.stop(); capture.current = undefined; finishing.current = false; locked.current = false;
    const audioId = id.current; id.current = undefined;
    if (audioId && sessionId && !preview) void invoke("dictation.cancel", { sessionId, audioId }).catch(() => {});
    setBusy(false); setReview(false); setState(previous => previous ? { ...previous, phase: "off", text: "" } : previous);
  }, [invoke, sessionId, preview]);
  useEffect(() => {
    const epoch = ++generation.current; setState(preview ? DEMO : undefined); setError(""); setReview(false);
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!document.hidden && !locked.current) { const next = await invoke("dictation.status", { sessionId: sessionId! }); if (alive && !locked.current) setState(next); } }
      catch (cause) { if (alive) setError(hostErrorMessage(cause, "Dictation unavailable")); }
      finally { if (alive) timer = setTimeout(() => void poll(), id.current ? 300 : 3000); }
    };
    if (!preview && enabled) void poll();
    const hide = () => { if (document.hidden && !preview) cancel(); }; document.addEventListener("visibilitychange", hide);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener("visibilitychange", hide); cancel(); };
  }, [preview, enabled, sessionId, invoke, cancel]);
  const start = async () => {
    if (locked.current || !enabled) return; const epoch = generation.current; locked.current = true; setBusy(true); setError("");
    if (preview) { setState({ ...DEMO, phase: "recording", text: "请检查会话恢复后附件是否保留。" }); setReview(false); locked.current = false; setBusy(false); return; }
    const controller = new AbortController(); abort.current = controller;
    try {
      const access = ensureMicrophoneAccess(zh); if (access) await access;
      const input = await openLiveCapture({ signal: controller.signal, onFault: message => { if (finishing.current) return; cancel(); setError(message); }, attach: async () => {
        const prepared = await invoke("dictation.prepare", { sessionId: sessionId! });
        if (!prepared.audioId) throw new Error("Dictation input was not prepared");
        if (epoch !== generation.current || controller.signal.aborted) { void invoke("dictation.cancel", { sessionId: sessionId!, audioId: prepared.audioId }).catch(() => {}); throw new Error("Dictation target changed"); }
        id.current = prepared.audioId; const attached = await globalThis.ompStudioChrome!.attachLiveAudio!({ sessionId: sessionId!, audioId: prepared.audioId });
        if (!attached.ok) throw new Error(attached.message ?? "Microphone attach failed"); return prepared.audioId;
      } });
      capture.current = input;
      const next = await invoke("dictation.start", { sessionId: sessionId!, audioId: input.audioId });
      if (epoch === generation.current) { setState(next); setReview(false); }
    } catch (cause) { if (epoch === generation.current) { cancel(); setDenied(cause instanceof MicrophoneDeniedError); setError(hostErrorMessage(cause, "Could not start dictation")); } }
    finally { if (epoch === generation.current) { locked.current = false; setBusy(false); } }
  };
  const stop = async () => {
    if (locked.current) return;
    if (preview) { callback.current(state?.text ?? ""); setState(DEMO); return; }
    const audioId = id.current; if (!audioId || !sessionId) return;
    const epoch = generation.current; locked.current = true; finishing.current = true; setBusy(true);
    try {
      // Suspend device capture now, keeping its authenticated transport alive for native flush.
      capture.current?.pause();
      const next = await invoke("dictation.stop", { sessionId, audioId });
      if (epoch === generation.current) { setState(next); if (next.phase === "complete" && next.text) callback.current(next.text); else if (next.error) setError(next.error); }
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Dictation flush failed")); }
    finally { capture.current?.stop(); capture.current = undefined; id.current = undefined; finishing.current = false; if (epoch === generation.current) { locked.current = false; setBusy(false); } }
  };
  const active = state && ["starting", "recording", "transcribing"].includes(state.phase);
  return <section className="composer-dictation" aria-label={zh ? "草稿听写" : "Draft dictation"}>
    <button type="button" className="btn small ghost" disabled={!enabled || busy || active || !state?.enabled} onClick={() => setReview(true)} data-tip={target.id ? "远端目标未提供本机麦克风转发" : "听写只填草稿"}><Icon name="mic" extra="sm" />{zh ? "听写" : "Dictate"}</button>
    {active ? <><span role="status">{state.phase} · {preview ? "演示" : state.model}</span><button type="button" className="btn small outline" disabled={busy} onClick={() => void stop()}>{zh ? "停止并填入草稿" : "Stop and fill draft"}</button><button type="button" className="btn small ghost" onClick={cancel}>{zh ? "取消" : "Cancel"}</button><p aria-live="polite">{state.text}</p></> : null}
    {!enabled ? <span className="tiny muted">{zh ? target.id ? "远端目标没有本机音频转发" : "需要桌面麦克风通道" : "Desktop microphone transport is unavailable"}</span> : !state?.enabled ? <span className="tiny muted">{zh ? "在原生语音设置中开启" : "Enable in voice settings"}</span> : null}
    {error ? <p role="alert">{error}</p> : null}{denied ? <MicrophoneSettingsButton zh={zh} /> : null}
    {review ? <div className="media-review"><h4>{zh ? "开始草稿听写" : "Start draft dictation"}</h4><p>{state?.model} · {state?.language}</p><p>{state?.cloud ? zh ? "音频会发送到配置的转写服务，可能计费。" : "Audio is sent to the configured transcription service; charges may apply." : state?.downloadRequired ? `${zh ? "将下载本地模型" : "Downloads a local model"} ${state.downloadSize ?? ""}` : zh ? "使用已缓存的本地语音模型。" : "Uses the cached local speech model."} {zh ? "只填草稿、不发起 Agent 回合；与 Live 互斥。" : "Fills the draft only, never starts an agent turn; cannot run with Live."}</p><button type="button" className="btn small primary" disabled={busy} onClick={() => void start()}>{zh ? "确认打开麦克风" : "Open microphone"}</button><button type="button" className="btn small ghost" onClick={() => setReview(false)}>{zh ? "返回" : "Back"}</button></div> : null}
  </section>;
}
