import { openWebRtcCapture } from "./webrtcCapture";
import { AppSelect } from "../AppSelect";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import { type LiveAudioResultMap, type LiveAudioState, type LiveAudioOperation } from "@omp-studio/studio-protocol";
import { WorkspaceStatus } from "../workspaces/Workspace";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { getPreviewLiveAudio } from "../preview/liveAudioPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { openLiveCapture } from "./liveCapture";
import { MicrophoneDeniedError, MicrophoneSettingsButton, ensureMicrophoneAccess } from "./microphoneAccess";

export function LiveAudioPane({ client, sessionId, available, visible = true, remote = false, webrtcAvailable = false }: { remote?: boolean; webrtcAvailable?: boolean; client: StudioClient; sessionId?: string | undefined; available: boolean; visible?: boolean }) {
  const { preview, marks } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const t = (cn: string, en: string) => zh ? cn : en;
  const [endpointDraft, setEndpointDraft] = useState<string | undefined>();
  const [keyDraft, setKeyDraft] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [state, setState] = useState<LiveAudioState>(); const [voiceDraft, setVoice] = useState<string>();
  const voice = voiceDraft ?? state?.voice ?? "sol"; const [device, setDevice] = useState(""); const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [review, setReview] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [micDenied, setMicDenied] = useState(false);
  const generation = useRef(0); const lock = useRef(false); const capture = useRef<{ stop(): void; setMuted?(muted: boolean): void } | undefined>(undefined); const abort = useRef<AbortController | undefined>(undefined); const audioId = useRef<string | undefined>(undefined); const confirm = useRef<HTMLButtonElement>(null);
  const zhRef = useRef(zh); zhRef.current = zh;
  const desktop = !remote && !!globalThis.ompStudioChrome?.attachLiveAudio && !!navigator.mediaDevices?.getUserMedia;
  const useWebRtc = !desktop;
  const enabled = visible && (preview || ((desktop || webrtcAvailable && typeof RTCPeerConnection === "function" && !!navigator.mediaDevices?.getUserMedia) && available && !!sessionId));
  const active = !!state && !["off", "error"].includes(state.phase);
  const invoke = useCallback(async <K extends keyof LiveAudioResultMap>(kind: K, input: CommandInput<K>): Promise<LiveAudioState> => {
    if (useWebRtc) {
      const operation = { ...input, kind } as LiveAudioOperation;
      if (operation.kind === "live.audio.status") return client.query("live.webrtc.status", { sessionId: operation.sessionId, ...(audioId.current ? { audioId: audioId.current } : {}) });
      if (operation.kind === "live.audio.mute") return client.query("live.webrtc.mute", { sessionId: operation.sessionId, audioId: operation.audioId, muted: operation.muted });
      if (operation.kind === "live.audio.release") return client.query("live.webrtc.release", { sessionId: operation.sessionId, audioId: operation.audioId });
    }
    const handle = await client.command(kind, input); return (await waitReceipt<{ result: LiveAudioState }>(client, handle.requestId, 30000)).result;
  }, [client, useWebRtc]);
  const release = useCallback(() => {
    abort.current?.abort(); capture.current?.stop(); capture.current = undefined;
    const id = audioId.current; audioId.current = undefined;
    if (id && sessionId && !useWebRtc) void invoke("live.audio.release", { sessionId, audioId: id }).catch(() => {});
  }, [invoke, sessionId, useWebRtc]);
  useEffect(() => {
    if (!preview) return;
    const localized = getPreviewLiveAudio(zh);
    setState(previous => previous ? { ...localized, voice: previous.voice, phase: previous.phase, attached: previous.attached, muted: previous.muted, inputLevel: previous.inputLevel, outputLevel: previous.outputLevel } : localized);
  }, [preview, zh]);
  useEffect(() => {
    generation.current++; lock.current = false; setEndpointDraft(undefined); setKeyDraft(""); setVoice(undefined); setSettingsSaved(false); setBusy(false); setError(""); setReview(false); setState(preview ? getPreviewLiveAudio(zhRef.current) : undefined);
    let alive = true;
    const hide = () => { if (document.hidden) { generation.current++; lock.current = false; setBusy(false); release(); setReview(false); setState(previous => previous ? { ...previous, phase: "off", attached: false, inputLevel: 0, outputLevel: 0 } : previous); } };
    document.addEventListener("visibilitychange", hide);
    if (!preview && enabled && sessionId && !document.hidden) {
      void invoke("live.audio.status", { sessionId })
        .then(next => {
          if (alive && !lock.current) {
            setState(next);
            if (capture.current && (!next.attached || ["off", "error"].includes(next.phase))) release();
          }
        })
        .catch(cause => {
          if (alive) { release(); setError(hostErrorMessage(cause, "Live disconnected")); }
        });
    }
    return () => { alive = false; generation.current++; document.removeEventListener("visibilitychange", hide); release(); };
  }, [preview, enabled, sessionId, invoke, release, visible]);
  useEffect(() => {
    if (preview || !enabled || !active || !sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const next = await invoke("live.audio.status", { sessionId });
          if (!alive) return;
          if (!lock.current) {
            setState(next);
            if (!next.attached || ["off", "error"].includes(next.phase)) {
              if (capture.current) release();
              return;
            }
          }
        }
      } catch (cause) {
        if (alive) { release(); setError(hostErrorMessage(cause, "Live disconnected")); }
        return;
      }
      if (alive && !document.hidden) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer); };
  }, [preview, enabled, active, sessionId, invoke, release]);
  useEffect(() => { if (review) confirm.current?.focus(); }, [review]);
  const start = async () => {
    if (lock.current || !enabled) return; const epoch = generation.current; lock.current = true; setBusy(true); setError("");
    if (preview) { setState({ ...getPreviewLiveAudio(zh), voice, phase: "listening", attached: true, inputLevel: 0.2 }); setReview(false); setBusy(false); lock.current = false; return; }
    const access = ensureMicrophoneAccess(zh);
    if (access) {
      try { await access; setMicDenied(false); }
      catch (cause) { if (epoch === generation.current) { setMicDenied(cause instanceof MicrophoneDeniedError); setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); lock.current = false; } return; }
    }
    if (epoch !== generation.current) return;
    const controller = new AbortController(); abort.current = controller;
    try {
      if (useWebRtc) {
        const id = crypto.randomUUID(); audioId.current = id;
        const input = await openWebRtcCapture({ client, sessionId: sessionId!, audioId: id, voice, ...(device ? { deviceId: device } : {}), signal: controller.signal, onFault: message => { if (epoch === generation.current) { release(); setError(message); } } });
        capture.current = input;
        if (epoch === generation.current && !controller.signal.aborted) { setState(input.state); setReview(false); }
        else input.stop();
        return;
      }
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
  const stop = () => { generation.current++; lock.current = false; setBusy(false); release(); setReview(false); setState(previous => previous ? { ...previous, phase: "off", attached: false, muted: false, inputLevel: 0, outputLevel: 0 } : previous); };
  return <section className="live-audio-pane" aria-label={t("Live 实时语音", "Live realtime audio")}>
    <div className="media-toolbar"><h3>{t("Live 实时语音", "Live realtime audio")}</h3>{preview && marks ? <span className="chip gray">{t("演示", "Demo")}</span> : null}<WorkspaceStatus state={state?.phase ?? "disconnected"} /></div>
    <p className="small muted">{t("使用自定义服务端或 Codex OAuth 实时语音；任务交给当前对话，麦克风和播放设备来自此窗口，账户与任务使用当前工作环境。隐藏窗口、离开此页面、切换会话或连接中断会停止麦克风，需要手动重新开始。", "Uses a custom endpoint or Codex OAuth for realtime audio and delegates tasks to this conversation. Audio devices belong to this window; credentials and tasks belong to the selected work environment. Hiding the window, leaving this page, switching sessions or disconnecting stops the microphone; restart is always manual.")}</p>
    {!enabled ? <p className="muted">{t("Live 需要麦克风权限、支持实时语音的 Runtime，以及桌面音频通道或安全来源中的 WebRTC。", "Live requires microphone access, a supported Runtime, and desktop audio or WebRTC on a secure origin.")}</p> : null}
    <div className="media-parameter-grid"><label>{t("麦克风", "Microphone")}<AppSelect className="select" value={device} disabled={active || busy} onChange={event => setDevice(event.target.value)}><option value="">{t("系统默认", "System default")}</option>{devices.map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || t("麦克风", "Microphone") + " " + (index + 1)}</option>)}</AppSelect></label><label>{t("音色", "Voice")}<input className="input" value={voice} disabled={active || busy} onChange={event => { setVoice(event.target.value); setSettingsSaved(false); }} /></label></div>
    <form className="media-parameter-grid" onSubmit={async event => {
      event.preventDefault();
      const endpoint = endpointDraft ?? state?.endpoint ?? "";
      const epoch = generation.current; setBusy(true); setError("");
      try {
        if (!preview) {
          const settings: ["live.endpoint" | "live.voice" | "live.apiKey", string][] = [["live.endpoint", endpoint], ["live.voice", voice]];
          if (keyDraft) settings.push(["live.apiKey", keyDraft]);
          for (const [key, value] of settings) {
            const handle = await client.command("preferences.features.set", { sessionId: sessionId!, key, value, scope: "global" });
            await waitReceipt(client, handle.requestId);
          }
        }
        if (epoch === generation.current) {
          setState(old => old ? { ...old, endpoint, voice, apiKeyConfigured: !!keyDraft || !!old.apiKeyConfigured } : old);
          setKeyDraft(""); setSettingsSaved(true);
        }
      } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, t("无法保存设置", "Could not save settings"))); }
      finally { if (epoch === generation.current) setBusy(false); }
    }}>
      <label>{t("自定义服务端", "Live endpoint")}<input className="input mono" value={endpointDraft ?? state?.endpoint ?? ""} disabled={active || busy} placeholder="https://…" onChange={event => { setEndpointDraft(event.target.value); setSettingsSaved(false); }} /></label>
      <label>API Key<input className="input mono" type="password" autoComplete="off" value={keyDraft} disabled={active || busy} placeholder={state?.apiKeyConfigured ? "••••••••" : t("密钥、环境变量名或 !command", "Key, environment variable or !command")} onChange={event => { setKeyDraft(event.target.value); setSettingsSaved(false); }} /></label>
      <button className="btn small outline" disabled={!enabled || busy || active}>{t("保存连接设置", "Save connection settings")}</button>{settingsSaved && <span role="status">{t("已保存", "Saved")}</span>}
    </form>
    <div className="media-toolbar"><button className="btn small outline" disabled={!enabled || busy || active} onClick={() => { if (preview) return; void navigator.mediaDevices.enumerateDevices().then(rows => setDevices(rows.filter(row => row.kind === "audioinput"))).catch(cause => setError(hostErrorMessage(cause, "Devices unavailable"))); }}>{t("刷新设备", "Refresh devices")}</button><button className="btn small primary" disabled={!enabled || busy || active} onClick={() => setReview(true)}>{t("准备开始 Live", "Review Live call")}</button><button className="btn small outline" disabled={!active && !busy} onClick={stop}>{t("停止 Live", "Stop Live")}</button><button className="btn small outline" disabled={!active || busy || state?.phase === "prepared" || state?.phase === "connecting"} onClick={() => {
      if (!state) return; if (preview) { setState({ ...state, muted: !state.muted, phase: state.muted ? "listening" : "muted" }); return; }
      const id = audioId.current; const epoch = generation.current; capture.current?.setMuted?.(!state.muted); if (id && sessionId) void invoke("live.audio.mute", { sessionId, audioId: id, muted: !state.muted }).then(next => {if(epoch===generation.current)setState(next);}).catch(cause => {if(epoch===generation.current)setError(hostErrorMessage(cause, "Mute failed"));});
    }}>{state?.muted ? t("取消静音", "Unmute") : t("静音", "Mute")}</button></div>
    {state ? <><div className="live-audio-levels" hidden={useWebRtc}><label>{t("麦克风电平", "Microphone level")}<meter min={0} max={1} value={state.inputLevel} /></label><label>{t("播放电平", "Output level")}<meter min={0} max={1} value={state.outputLevel} /></label></div><div className="live-audio-transcripts" aria-label={t("实时转写", "Live transcripts")}>{state.transcripts.map(item => <p key={item.role + ":" + item.turn}><strong>{item.role === "user" ? t("你", "You") : t("语音助手", "Voice assistant")}</strong><span>{item.text}{item.final ? "" : " …"}</span></p>)}{!state.transcripts.length ? <p className="muted">{t("开始后显示最近 40 段转写；长段落保留末尾。音频不会写入对话记录。", "After starting, the latest 40 transcript segments appear here; long segments keep their ending. Audio is not stored in the conversation.")}</p> : null}</div></> : null}
    {state?.error || error ? <p role="alert" className="media-error">{error || state?.error}</p> : null}
    {micDenied ? <MicrophoneSettingsButton zh={zh} /> : null}
    {review ? <section className="media-review" aria-label={t("确认 Live 调用", "Confirm Live call")}><h4>{t("开始实时语音", "Start realtime audio")} · {voice}</h4><p>{t("确认后会打开所选麦克风，并通过你的 Codex OAuth 账户连接实时服务，可能产生费用。语音提出的任务可在当前会话中执行，继续受现有权限和审批设置约束。", "Confirmation opens the selected microphone and connects through your Codex OAuth account; charges may apply. Voice tasks can execute in this session under its existing permissions and approvals.")}</p><button ref={confirm} className="btn small primary" disabled={busy || !enabled} onClick={() => void start()}>{t("确认打开麦克风并连接", "Open microphone and connect")}</button><button className="btn small" disabled={busy} onClick={() => setReview(false)}>{t("返回", "Back")}</button></section> : null}
  </section>;
}
