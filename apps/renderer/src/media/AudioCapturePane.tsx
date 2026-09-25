import { useEffect, useRef, useState } from "react";
import type { ArtifactRecord } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { normalizeAudio, uploadMediaBlob } from "./audio";

export function AudioCapturePane({ workspaceId, sessionId, onSaved }: { workspaceId?: string | undefined; sessionId?: string | undefined; onSaved(artifact: ArtifactRecord): void }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [recording, setRecording] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | undefined>(undefined); const stream = useRef<MediaStream | undefined>(undefined); const epoch = useRef(0); const abort = useRef<AbortController | undefined>(undefined); const saving = useRef(false); const acquiring = useRef(false);
  const callback = useRef(onSaved); callback.current = onSaved;
  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined; setRecording(false); };
  useEffect(() => {
    epoch.current++; setError(""); setBusy(false); saving.current = false; acquiring.current = false;
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hide);
    return () => { epoch.current++; abort.current?.abort(); stop(); document.removeEventListener("visibilitychange", hide); };
  }, [sessionId, workspaceId, preview]);
  useEffect(() => { if (!recording) return; const started = Date.now(); const timer = setInterval(() => { const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(elapsed); if (elapsed >= 600) stop(); }, 250); return () => clearInterval(timer); }, [recording]);
  const save = async (blob: Blob, name: string, generation: number) => {
    if (generation !== epoch.current || saving.current) return;
    saving.current = true; setBusy(true); setError(""); const controller = new AbortController(); abort.current = controller;
    try { const wav = await normalizeAudio(blob, controller.signal); const artifact = await uploadMediaBlob(wav, name.replace(/\.[^.]+$/u, "") + ".wav", { workspaceId, sessionId }, controller.signal); if (epoch.current === generation) callback.current(artifact); }
    catch (cause) { if (epoch.current === generation && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch.current === generation) { setBusy(false); saving.current = false; } }
  };
  const begin = async () => {
    if (recording || busy || saving.current || acquiring.current) return;
    if (preview) { setRecording(true); setSeconds(0); return; }
    const generation = epoch.current; acquiring.current = true; setError(""); setBusy(true);
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (generation !== epoch.current || document.hidden) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(input, mimeType ? { mimeType } : undefined); recorder.current = capture;
      const chunks: Blob[] = []; let bytes = 0;
      capture.ondataavailable = event => { if (!event.data.size) return; bytes += event.data.size; if (bytes > 25 * 1024 * 1024) { setError("Recording reached the 25 MiB limit; the captured prefix will be saved"); stop(); return; } chunks.push(event.data); };
      capture.onstop = () => { input.getTracks().forEach(track => track.stop()); if (recorder.current === capture) recorder.current = undefined; if (generation === epoch.current) { setRecording(false); void save(new Blob(chunks, { type: capture.mimeType || "audio/webm" }), "recording.wav", generation); } };
      capture.onerror = () => { setError("Audio recording failed"); stop(); };
      capture.start(1000); setSeconds(0); setRecording(true);
    } catch (cause) { stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined; if (generation === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation === epoch.current) { acquiring.current = false; setBusy(false); } }
  };
  const available = preview || (!!globalThis.ompStudioChrome?.beginMediaUpload && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
  return <section className="media-audio-input" aria-label={zh ? "录音和音频导入" : "Record or import audio"}>
    <p className="small muted">{zh ? "先保存音频，再由你发起转写。最多 10 分钟 / 25 MiB；导入后转换为 16 kHz 单声道 WAV。隐藏窗口或切换会话会停止麦克风。" : "Save audio first, then request transcription. Up to 10 minutes / 25 MiB; normalized to 16 kHz mono WAV. Hiding the window or switching sessions stops capture."}</p>
    <div className="media-toolbar"><button className="btn small outline" disabled={!available || busy} onClick={() => recording ? (preview ? (setRecording(false), setError(zh ? "演示录音结束，请选择演示音频。" : "Demo recording ended; select demo audio.")) : stop()) : void begin()}>{recording ? zh ? "停止录音并保存" : "Stop and save audio" : zh ? "开始录音" : "Record audio"}</button>{recording ? <span className="chip red">● {seconds}s</span> : null}<label className="small">{zh ? "导入音频" : "Import audio"}<input type="file" accept="audio/*" disabled={busy || recording || (!preview && !globalThis.ompStudioChrome?.beginMediaUpload)} onChange={event => { const file = event.target.files?.[0]; if (file) { if (preview) setError(zh ? "演示模式不上传音频；使用下方演示音频。" : "Demo does not upload files; use demo audio below."); else void save(file, file.name, epoch.current); } event.target.value = ""; }} /></label></div>
    {!available ? <p className="small muted">{zh ? "当前客户端没有桌面录音 / 文件上传通道。" : "Desktop capture/upload is unavailable in this client."}</p> : null}{busy ? <p role="status">{zh ? "正在处理和保存音频…" : "Processing and saving audio…"}</p> : null}{error ? <p role="alert">{error}</p> : null}
  </section>;
}
