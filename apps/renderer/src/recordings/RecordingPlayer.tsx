import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "../i18n";
import { applyRecordedFrame, RECORDING_MAX_BYTES, type PlaybackRecording, type RecordedScreen } from "./format";
import "./recordings.css";

/** Read-only xterm: no PTY, keyboard forwarding, links, clipboard or terminal control IPC. */
export function RecordingPlayer({ artifactId, demoText }: { artifactId?: string | undefined; demoText?: string | undefined }) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [recording, setRecording] = useState<PlaybackRecording>(); const [error, setError] = useState("");
  const [loading, setLoading] = useState(false); const [playing, setPlaying] = useState(false); const [position, setPosition] = useState(0); const [speed, setSpeed] = useState(1);
  const [source, setSource] = useState<{ text: string; name: string }>(); const [seek, setSeek] = useState(0);
  const node = useRef<HTMLDivElement>(null); const term = useRef<Terminal | undefined>(undefined); const epoch = useRef(0);
  const cursor = useRef(0); const renderedAt = useRef(0); const screen = useRef<RecordedScreen | undefined>(undefined); const writeTail = useRef<Promise<void>>(Promise.resolve());
  const screenDirty = useRef(false);
  const fileGeneration = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current; setRecording(undefined); setPosition(0); setPlaying(false); setError(""); setLoading(true);
    const controller = new AbortController(); const worker = new Worker(new URL("./recording.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ recording?: PlaybackRecording; error?: string }>) => {
      if (epoch.current !== generation) return;
      setLoading(false); if (event.data.error) setError(event.data.error); else setRecording(event.data.recording);
      worker.terminate();
    };
    worker.onerror = () => { if (epoch.current === generation) { setLoading(false); setError("Recording parser failed"); } worker.terminate(); };
    void (async () => {
      if (source || demoText) { worker.postMessage({ text: source?.text ?? demoText }); return; }
      if (!artifactId) { setLoading(false); worker.terminate(); return; }
      const response = await fetch(`omp-artifact://library/${encodeURIComponent(artifactId)}`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("Recording unavailable; import or open it in Desktop");
      const size = Number(response.headers.get("content-length")); if (size > RECORDING_MAX_BYTES) throw new Error("Recording exceeds 32 MiB");
      const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0; const parts: string[] = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > RECORDING_MAX_BYTES) throw new Error("Recording exceeds 32 MiB"); parts.push(decoder.decode(next.value, { stream: true })); } parts.push(decoder.decode()); }
      finally { await reader.cancel().catch(() => {}); }
      if (generation === epoch.current) worker.postMessage({ text: parts.join("") });
    })().catch(cause => { if (generation === epoch.current && !controller.signal.aborted) { setLoading(false); setError(cause instanceof Error ? cause.message : String(cause)); } worker.terminate(); });
    return () => { epoch.current++; controller.abort(); worker.terminate(); };
  }, [artifactId, source, demoText]);
  useEffect(() => {
    if (!node.current || !recording) return;
    const terminal = new Terminal({ cols: recording.cols, rows: recording.rows, disableStdin: true, cursorBlink: false, fontSize: 12, scrollback: 1000, allowProposedApi: false, theme: { background: "#17191d", foreground: "#d9dce3" } });
    terminal.open(node.current); term.current = terminal; cursor.current = 0; renderedAt.current = -1;
    writeTail.current = Promise.resolve();
    screen.current = { cols: recording.cols, rows: recording.rows, history: [], viewport: [] };
    setSeek(value => value + 1);
    return () => { term.current = undefined; terminal.dispose(); };
  }, [recording]);
  useEffect(() => {
    if (!recording || !playing || document.hidden) return;
    let frame = 0; const start = performance.now(); const initial = position;
    const tick = () => {
      const at = Math.min(recording.durationMs, initial + (performance.now() - start) * speed); setPosition(at);
      if (at >= recording.durationMs) setPlaying(false); else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [recording, playing, speed, seek]);
  useEffect(() => { const hide = () => { if (document.hidden) setPlaying(false); }; document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide); }, []);
  const paintGeneration = useRef(0);
  useEffect(() => {
    const terminal = term.current; if (!terminal || !recording) return;
    const generation = ++paintGeneration.current;
    const paint = async () => {
      if (paintGeneration.current !== generation || term.current !== terminal) return;
      let changed = false;
      if (position < renderedAt.current || renderedAt.current < 0) { terminal.reset(); cursor.current = 0; screen.current = { cols: recording.cols, rows: recording.rows, history: [], viewport: [] }; terminal.resize(recording.cols, recording.rows); changed = true; }
      const write = (text: string) => new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); terminal.write(text, () => { clearTimeout(timer); resolve(); }); });
      let work = 0;
      while (cursor.current < recording.events.length && recording.events[cursor.current]!.at <= position) {
        if (paintGeneration.current !== generation || term.current !== terminal) return;
        const event = recording.events[cursor.current++]!;
        changed = true; renderedAt.current = event.at;
        if (recording.format === "ompcast") { applyRecordedFrame(screen.current!, event.frame); screenDirty.current = true; }
        else if (event.frame.t === "resize") terminal.resize(event.frame.cols, event.frame.rows);
        else if (event.frame.t === "output") await write(event.frame.data);
        if (++work % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (recording.format === "ompcast" && screen.current && (changed || screenDirty.current)) {
        terminal.reset();
        terminal.resize(screen.current.cols, screen.current.rows);
        await write([...screen.current.history, ...screen.current.viewport].map(row => row + "\x1b[0m\x1b[K").join("\r\n"));
        screenDirty.current = false;
      }
      renderedAt.current = position;
    };
    writeTail.current = writeTail.current.then(paint).catch(() => {});
  }, [recording, position, seek]);
  return <section className="recording-player" aria-label={zh ? "录制回放" : "Recording playback"}>
    <div className="recording-controls"><label className="btn small outline">{zh ? "打开录制文件" : "Open recording"}<input type="file" accept=".ompcast,.studiocast" aria-label={zh ? "选择录制文件" : "Choose recording"} onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > RECORDING_MAX_BYTES) { setError("Recording exceeds 32 MiB"); return; } const generation = ++fileGeneration.current; void file.text().then(text => { if (generation === fileGeneration.current) setSource({ text, name: file.name }); }).catch(cause => { if (generation === fileGeneration.current) setError(cause instanceof Error ? cause.message : String(cause)); }); event.target.value = ""; }} /></label><span className="small muted">{source?.name ?? recording?.title ?? ""}</span></div>
    {loading ? <p role="status">{zh ? "正在读取录制…" : "Loading recording…"}</p> : null}{error ? <p role="alert">{error}</p> : null}
    {recording ? <><div className="recording-controls"><button className="btn small" onClick={() => { if (position >= recording.durationMs) { setPosition(0); renderedAt.current = -1; setSeek(value => value + 1); } setPlaying(value => !value); }}>{playing ? zh ? "暂停" : "Pause" : zh ? "播放" : "Play"}</button><select className="select" aria-label={zh ? "回放速度" : "Playback speed"} value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[0.5, 1, 2, 4].map(value => <option key={value} value={value}>{value}×</option>)}</select><span className="small mono">{(position / 1000).toFixed(1)} / {(recording.durationMs / 1000).toFixed(1)}s · {recording.format}</span></div><input type="range" className="recording-seek" aria-label={zh ? "回放位置" : "Playback position"} min={0} max={recording.durationMs || 1} value={position} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); setSeek(value => value + 1); }} />{recording.truncated ? <p className="small muted">{zh ? "文件末尾不完整，已恢复完整帧。" : "The incomplete final line was ignored."}</p> : null}</> : null}
    <div className="recording-screen" ref={node} />
  </section>;
}
