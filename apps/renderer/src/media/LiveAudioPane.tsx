import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import { LIVE_AUDIO_VOICES, type LiveAudioResultMap, type LiveAudioState } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_LIVE_AUDIO } from "../preview/liveAudioPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { openLiveCapture, type LiveCapture } from "./liveCapture";

export function LiveAudioPane({ client, sessionId, available }: { client: StudioClient; sessionId?: string | undefined; available: boolean }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const t = (cn: string, en: string) => zh ? cn : en;
  const [state, setState] = useState<LiveAudioState>(); const [voice, setVoice] = useState("sol"); const [device, setDevice] = useState(""); const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [review, setReview] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const generation = useRef(0); const lock = useRef(false); const capture = useRef<LiveCapture | undefined>(undefined); const abort = useRef<AbortController | undefined>(undefined); const audioId = useRef<string | undefined>(undefined); const confirm = useRef<HTMLButtonElement>(null);
  const desktop = !!globalThis.ompStudioChrome?.attachLiveAudio && !!navigator.mediaDevices?.getUserMedia;
  const enabled = preview || (desktop && available && !!sessionId);
  const active = !!state && !["off", "error"].includes(state.phase);
  const invoke = useCallback(async <K extends keyof LiveAudioResultMap>(kind: K, input: CommandInput<K>): Promise<LiveAudioState> => {
    const handle = await client.command(kind, input); return (await waitReceipt<{ result: LiveAudioState }>(client, handle.requestId, 30000)).result;
  }, [client]);
  const release = useCallback(() => {
    abort.current?.abort(); capture.current?.stop(); capture.current = undefined;
    const id = audioId.current; audioId.current = undefined;
    if (id && sessionId) void invoke("live.audio.release", { sessionId, audioId: id }).catch(() => {});
  }, [invoke, sessionId]);
  useEffect(() => {
    const epoch = ++generation.current; lock.current = false; setBusy(false); setError(""); setReview(false); setState(preview ? PREVIEW_LIVE_AUDIO : undefined);
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const hide = () => { if (document.hidden) { release(); setReview(false); setState(previous => previous ? { ...previous, phase: "off", attached: false, inputLevel: 0, outputLevel: 0 } : previous); } };
    document.addEventListener("visibilitychange", hide);
    const poll = async () => {
      try {
        if (!document.hidden) {
          const next = await invoke("live.audio.status", { sessionId: sessionId! });
          if (alive && !lock.current) { setState(next); if (capture.current && (!next.attached || ["off", "error"].includes(next.phase))) release(); }
        }
      } catch (cause) { if (alive) { release(); setError(hostErrorMessage(cause, "Live disconnected")); } }
      finally { if (alive) timer = setTimeout(() => void poll(), 1000); }
    };
    if (!preview && enabled) void poll();
    return () => { alive = false; generation.current = epoch + 1; clearTimeout(timer); document.removeEventListener("visibilitychange", hide); release(); };
  }, [preview, enabled, sessionId, invoke, release]);
  useEffect(() => { if (review) confirm.current?.focus(); }, [review]);
  const start = async () => {
    if (lock.current || !enabled) return; const epoch = generation.current; lock.current = true; setBusy(true); setError("");
    if (preview) { setState({ ...PREVIEW_LIVE_AUDIO, voice, phase: "listening", attached: true, inputLevel: 0.2 }); setReview(false); setBusy(false); lock.current = false; return; }
    const controller = new AbortController(); abort.current = controller;
    try {
      const input = await openLiveCapture({ ...(device ? { deviceId: device } : {}), signal: controller.signal,
        onFault: message => { if (epoch === generation.current) { release(); setError(message); } },
        attach: async () => {
          const next = await invoke("live.audio.prepare", { sessionId: sessionId!, voice });
          if (!next.audioId) throw new Error("Runtime did not prepare an audio input");
          if (controller.signal.aborted || epoch !== generation.current) { void invoke("live.audio.release", { sessionId: sessionId!, audioId: next.audioId }).catch(() => {}); controller.signal.throwIfAborted(); throw new Error("Live session changed"); }
          audioId.current = next.audioId;
          const result = await globalThis.ompStudioChrome!.attachLiveAudio!({ audioId: next.audioId, sessionId: sessionId! });
          if (!result.ok) throw new Error(result.message ?? "Microphone could not attach"); return next.audioId;
        },
      });
      capture.current = input; controller.signal.throwIfAborted();
      const next = await invoke("live.audio.start", { sessionId: sessionId!, audioId: input.audioId });
      if (epoch === generation.current && !controller.signal.aborted) { setState(next); setReview(false); }
    } catch (cause) { const cancelled = controller.signal.aborted; if (epoch === generation.current) { release(); if (!cancelled) setError(hostErrorMessage(cause, "Unable to start Live")); } }
    finally { if (epoch === generation.current) { setBusy(false); lock.current = false; } }
  };
  const stop = () => { release(); setReview(false); setState(previous => previous ? { ...previous, phase: "off", attached: false, muted: false, inputLevel: 0, outputLevel: 0 } : previous); };
  return <section className="live-audio-pane" aria-label={t("Live 实时语音", "Live realtime audio")}>
    <div className="media-toolbar"><h3>{t("Live 实时语音", "Live realtime audio")}</h3>{preview ? <span className="chip gray">{t("演示", "Demo")}</span> : null}<span className="chip gray">{state?.phase ?? t("未连接", "Disconnected")}</span></div>
    <p className="small muted">{t("使用 Codex OAuth 实时语音；任务交给当前对话，声音从系统输出设备播放。隐藏窗口、离开此页面、切换会话或连接中断会停止麦克风，需要手动重新开始。", "Uses Codex OAuth realtime audio and delegates tasks to this conversation. Output uses the system device. Hiding the window, leaving this page, switching sessions or disconnecting stops the microphone; restart is always manual.")}</p>
    {!enabled ? <p className="muted">{t("Live 需要 Windows 桌面麦克风通道及已连接的活动 Runtime。Web 客户端暂不可用。", "Live requires desktop microphone access and an active Runtime. This Web client cannot capture Live audio.")}</p> : null}
    <div className="media-parameter-grid"><label>{t("麦克风", "Microphone")}<select className="select" value={device} disabled={active || busy} onChange={event => setDevice(event.target.value)}><option value="">{t("系统默认", "System default")}</option>{devices.map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || t("麦克风", "Microphone") + " " + (index + 1)}</option>)}</select></label><label>{t("音色", "Voice")}<select className="select" value={voice} disabled={active || busy} onChange={event => setVoice(event.target.value)}>{LIVE_AUDIO_VOICES.map(name => <option key={name}>{name}</option>)}</select></label></div>
    <div className="media-toolbar"><button className="btn small outline" disabled={!enabled || busy || active} onClick={() => { if (preview) return; void navigator.mediaDevices.enumerateDevices().then(rows => setDevices(rows.filter(row => row.kind === "audioinput"))).catch(cause => setError(hostErrorMessage(cause, "Devices unavailable"))); }}>{t("刷新设备", "Refresh devices")}</button><button className="btn small primary" disabled={!enabled || busy || active} onClick={() => setReview(true)}>{t("准备开始 Live", "Review Live call")}</button><button className="btn small outline" disabled={!active && !busy} onClick={stop}>{t("停止 Live", "Stop Live")}</button><button className="btn small outline" disabled={!active || busy || state?.phase === "prepared" || state?.phase === "connecting"} onClick={() => {
      if (!state) return; if (preview) { setState({ ...state, muted: !state.muted, phase: state.muted ? "listening" : "muted" }); return; }
      const id = audioId.current; if (id && sessionId) void invoke("live.audio.mute", { sessionId, audioId: id, muted: !state.muted }).then(setState).catch(cause => setError(hostErrorMessage(cause, "Mute failed")));
    }}>{state?.muted ? t("取消静音", "Unmute") : t("静音", "Mute")}</button></div>
    {state ? <><div className="live-audio-levels"><label>{t("麦克风电平", "Microphone level")}<meter min={0} max={1} value={state.inputLevel} /></label><label>{t("播放电平", "Output level")}<meter min={0} max={1} value={state.outputLevel} /></label></div><div className="live-audio-transcripts" aria-label={t("实时转写", "Live transcripts")}>{state.transcripts.map(item => <p key={item.role + ":" + item.turn}><strong>{item.role === "user" ? t("你", "You") : t("语音助手", "Voice assistant")}</strong><span>{item.text}{item.final ? "" : " …"}</span></p>)}{!state.transcripts.length ? <p className="muted">{t("开始后显示最近 40 段转写；长段落保留末尾。音频不会写入对话记录。", "After starting, the latest 40 transcript segments appear here; long segments keep their ending. Audio is not stored in the conversation.")}</p> : null}</div></> : null}
    {state?.error || error ? <p role="alert" className="media-error">{error || state?.error}</p> : null}
    {review ? <section className="media-review" aria-label={t("确认 Live 调用", "Confirm Live call")}><h4>{t("开始实时语音", "Start realtime audio")} · {voice}</h4><p>{t("确认后会打开所选麦克风，并通过你的 Codex OAuth 账户连接实时服务，可能产生费用。语音提出的任务可在当前会话中执行，继续受现有权限和审批设置约束。", "Confirmation opens the selected microphone and connects through your Codex OAuth account; charges may apply. Voice tasks can execute in this session under its existing permissions and approvals.")}</p><button ref={confirm} className="btn small primary" disabled={busy || !enabled} onClick={() => void start()}>{t("确认打开麦克风并连接", "Open microphone and connect")}</button><button className="btn small" disabled={busy} onClick={() => setReview(false)}>{t("返回", "Back")}</button></section> : null}
  </section>;
}
