import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { DictationCaptureState, DictationConfiguration } from "@omp-studio/studio-protocol";
import type { DictationAudioApi, DictationDesktopEvent, DictationRecovery } from "../../../desktop/src/dictation-audio-shared";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { DictationControl } from "../composer/DictationControl";
import { DictationSettingsPane } from "../settings/DictationSettingsPane";
import { snapshotFromText } from "../composer/serialize";
import { updateAppSettings } from "../settings/appSettings";
import { PREVIEW_DICTATION_CONFIGURATION, PREVIEW_DICTATION_TEXT } from "../preview/dictationPreview";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../App.css";
import "../styles/typography.css";

// Isolated QA entry: synthetic WebAudio input and a deterministic private bridge.
// It cannot connect to a real Host, microphone, model download, or provider.
const events = new Set<(event: DictationDesktopEvent) => void>();
const commands: Record<string, unknown> = {};
let config: DictationConfiguration = { ...PREVIEW_DICTATION_CONFIGURATION, configurationId: "qa-dictation-local-v2" };
let current: DictationRecovery | null = null;
let failFlush = false;
let frameCount = 0;
let busyReady = false;
let counter = 0;
const emit = (state: DictationCaptureState) => {
  if (!current) return;
  current = { ...current, state };
  for (const listener of events) listener({ kind: "state", audioId: current.audioId, owner: current.owner, state });
};
const initialState = (): DictationCaptureState => ({ phase: "prepared", committedText: "", partialText: "", submit: false });
const client = {
  command: async (kind: string, input: Record<string, unknown>) => {
    const requestId = `qa-request-${++counter}`;
    const result = kind === "dictation.inspect" ? { ...config }
      : kind === "dictation.open" ? { protocolVersion: 2, audioId: crypto.randomUUID(), sessionId: input.sessionId, expiresAt: Date.now() + 30000, configuration: { ...config } }
        : kind === "preferences.features.set" ? (config = { ...config, enabled: input.value === true }, { key: input.key, value: input.value, source: "global" })
          : { text: "", phase: "off" };
    commands[requestId] = { requestId, status: "completed", result: { result } };
    return { requestId };
  },
  getState: () => ({ commands }),
  subscribe: () => () => {},
} as unknown as StudioClient;
const api: DictationAudioApi = {
  attachDictationAudio: async ({ channel, owner, recoveryId }) => {
    if (current && !recoveryId) return { ok: false, message: "Resolve the retained capture first" };
    current = { audioId: channel.audioId, owner, state: initialState(), bytes: recoveryId ? current?.bytes ?? 0 : 0, durationMs: recoveryId ? current?.durationMs ?? 0 : 0, retained: false, canReplay: !!recoveryId, configuration: channel.configuration };
    frameCount = 0;
    return { ok: true, recovery: current };
  },
  controlDictationAudio: async ({ audioId, input }) => {
    if (!current || current.audioId !== audioId) return { ok: false, message: "Audio target changed" };
    if (input.kind === "start") {
      emit({ ...current.state, phase: "preparing" });
      if (!busyReady) setTimeout(() => { if (current?.audioId === audioId && !current.retained) emit({ ...current.state, phase: "ready" }); }, 150);
    }
    if (input.kind === "recording") emit({ ...current.state, phase: "recording" });
    if (input.kind === "stop") {
      emit({ ...current.state, phase: "transcribing" });
      setTimeout(() => { if (current?.audioId === audioId && !current.retained) emit(failFlush ? { ...current.state, phase: "error", error: { code: "QA_NETWORK", message: "模拟转写失败：音频已留在内存，可重试。" } } : { phase: "complete", committedText: PREVIEW_DICTATION_TEXT, partialText: "", submit: false }); }, 200);
    }
    return { ok: true };
  },
  appendDictationAudio: async ({ bytes, sequence }) => {
    if (!current) return { ok: false, message: "Capture ended" };
    if (sequence !== frameCount++) return { ok: false, message: "Audio sequence mismatch" };
    current = { ...current, bytes: current.bytes + bytes.byteLength / 2, durationMs: (current.bytes + bytes.byteLength / 2) / 32, canReplay: true };
    if (!current.retained && frameCount % 15 === 0) emit({ phase: "recording", committedText: "", partialText: PREVIEW_DICTATION_TEXT.slice(0, Math.min(PREVIEW_DICTATION_TEXT.length, frameCount / 3)), submit: false });
    return { ok: true };
  },
  drainDictationAudio: async () => ({ ok: true }),
  getDictationRecovery: async () => ({ ok: true, recovery: current }),
  replayDictationAudio: async ({ audioId }) => {
    if (current?.audioId === audioId) emit({ phase: "complete", committedText: PREVIEW_DICTATION_TEXT, partialText: "", submit: false });
    return { ok: true };
  },
  retainDictationAudio: async () => {
    if (current && !current.retained) {
      current = { ...current, retained: true };
      for (const listener of events) listener({ kind: "retained", recovery: current });
    }
    return { ok: true, recovery: current };
  },
  releaseDictationAudio: async ({ audioId }) => {
    if (current?.audioId === audioId) {
      current = null;
      for (const listener of events) listener({ kind: "released", audioId });
    }
    return { ok: true };
  },
  onDictationAudio: listener => { events.add(listener); return () => { events.delete(listener); }; },
};
Object.defineProperty(globalThis, "ompStudioChrome", { configurable: true, value: { ...api, platform: "win32" } });
Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
  if (new URLSearchParams(location.search).has("denyMicrophone")) throw new DOMException("Permission denied", "NotAllowedError");
  const context = new AudioContext({ sampleRate: 16000 });
  const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
  oscillator.frequency.value = 230; gain.gain.value = .12;
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
  for (const track of destination.stream.getTracks()) {
    const stop = track.stop.bind(track);
    track.stop = () => { stop(); void context.close(); };
  }
  return destination.stream;
} });
Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { configurable: true, value: async () => [] });
const search = new URLSearchParams(location.search), theme = search.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
updateAppSettings({ dictationToggleShortcut: "Alt+H", dictationDeviceId: "" });

function Harness() {
  const composer = useRef<ChipComposerHandle>(null);
  const [text, setText] = useState("请在这里补充说明。");
  const [target, setTarget] = useState("qa-one");
  const [visible, setVisible] = useState(true);
  const [sent, setSent] = useState(0);
  const [settings, setSettings] = useState(false);
  useEffect(() => { composer.current?.setSnapshot(snapshotFromText("请在这里补充说明。")); }, []);
  const seed = () => {
    composer.current?.setSnapshot({ text: "Before src/api.ts after", images: [], doc: { nodes: [{ type: "text", value: "Before " }, { type: "chip", chip: { id: "qa-file", kind: "file", label: "api.ts", path: "src/api.ts" } }, { type: "text", value: " after" }] } });
    composer.current?.focus();
  };
  return <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px" }}>
    <h1 style={{ fontSize: 21 }}>语音输入 · 交互验收</h1>
    <p className="muted small">隔离测试：真实输入框和 AudioWorklet，合成音频与模拟转写服务。不使用物理麦克风或付费模型。</p>
    <div className="dictation-actions">
      <button className="btn small" onClick={seed}>载入带文件胶囊草稿</button>
      <button className="btn small" onClick={() => setTarget(value => value === "qa-one" ? "qa-two" : "qa-one")}>切换会话</button>
      <button className="btn small" onClick={() => setVisible(value => !value)}>切换输入区可见性</button>
      <button className="btn small" onClick={() => { failFlush = !failFlush; }}>切换转写失败</button>
      <button className="btn small" onClick={() => { busyReady = !busyReady; }}>切换准备等待</button>
      <button className="btn small" onClick={() => setSettings(value => !value)}>演示语音设置</button>
    </div>
    <p className="small">当前会话：<output id="qa-target">{target}</output> · 已发送：<output id="qa-sent">{sent}</output></p>
    <div className="composer" style={{ marginTop: 350, maxWidth: 800 }} hidden={!visible}>
      <ChipComposer id="qa-composer" ref={composer} onChange={value => setText(value.text)} onSubmit={() => setSent(value => value + 1)} />
      <div className="composer-bar"><div className="cb-group"><DictationControl client={client} sessionId={target} draftId="composer" available visible={visible} composerRef={composer} onSubmit={() => setSent(value => value + 1)} onSettings={() => setSettings(true)} /></div></div>
    </div>
    <p className="tiny muted">持久草稿（不包含临时转写）：</p><pre id="qa-draft" style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
    {settings ? <PreviewModeProvider switchEnabled><DictationSettingsPane visible /></PreviewModeProvider> : null}
  </main>;
}
const mounted = createRoot(document.getElementById("root")!);
mounted.render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled={false}><Harness /></PreviewModeProvider></I18nProvider>);
import.meta.hot?.dispose(() => mounted.unmount());
