import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { StudioClient } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import { useAppSettings } from "../settings/appSettings";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { Icon } from "../icons";
import type { ChipComposerHandle } from "./ChipComposer";
import { useDictation } from "./useDictation";
import { dictationDesktopApi, type DictationViewPhase } from "./dictationSession";
import { DictationDetails } from "./DictationDetails";
import { MicrophoneSetup } from "../media/MicrophoneSetup";
import { MicrophoneSettingsButton } from "../media/microphoneAccess";
import { waitReceipt, hostErrorMessage } from "../hostError";
import "./dictation.css";

export interface DictationControlProps {
  client?: StudioClient | undefined;
  sessionId?: string | undefined;
  draftId: string;
  label?: string;
  available: boolean;
  visible?: boolean;
  composerRef: RefObject<ChipComposerHandle | null>;
  ensureSession?: ((signal: AbortSignal) => Promise<string>) | undefined;
  onSubmit?: (() => void) | undefined;
  onSettings?: (() => void) | undefined;
  onModels?: (() => void) | undefined;
}
const LABELS: Record<DictationViewPhase, [string, string]> = {
  off: ["语音输入", "Voice input"], inspecting: ["正在检查听写…", "Checking dictation…"], review: ["准备语音输入", "Set up voice input"],
  preparing: ["正在准备识别模型…", "Preparing the speech model…"], opening: ["正在打开麦克风…", "Opening the microphone…"],
  recording: ["正在聆听", "Listening"], transcribing: ["正在完成转写…", "Finishing transcription…"],
  retained: ["有一段听写待处理", "A recording needs your attention"], complete: ["听写完成", "Dictation complete"], error: ["听写未能开始", "Could not start dictation"],
};
function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DictationControl({ client, sessionId, draftId, label = "Composer", available, visible = true, composerRef, ensureSession, onSubmit, onSettings, onModels }: DictationControlProps) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const t = (cn: string, en: string) => zh ? cn : en;
  const target = useExecutionTarget();
  const { settings } = useAppSettings();
  const { session, view } = useDictation({
    ...(client ? { client } : {}), ...(sessionId ? { sessionId } : {}), draftId, label,
    available, visible, remote: !!target.id, zh, deviceId: settings.dictationDeviceId,
    editor: () => composerRef.current, ...(ensureSession ? { ensureSession } : {}), ...(onSubmit ? { onSubmit } : {}),
  });
  const [menu, setMenu] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");
  const [copied, setCopied] = useState(false);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const apiAvailable = !!dictationDesktopApi(window.ompStudioChrome);
  const active = ["inspecting", "preparing", "opening", "recording", "transcribing"].includes(view.phase);
  const recovery = view.recovery;
  const ownRecovery = session.ownsRecovery();
  const open = visible && (menu || active || (!panelDismissed && view.phase !== "off" && (view.phase !== "complete" || !!view.message)));
  useEffect(() => { setPanelDismissed(false); setCopied(false); }, [view.phase, recovery?.audioId]);

  useLayoutEffect(() => {
    const editor = composerRef.current;
    editor?.setDictationBinding({
      enabled: available && visible && apiAvailable && !target.id && !!view.configuration?.enabled && !recovery,
      active,
      toggleShortcut: settings.dictationToggleShortcut,
      holdKeys: view.configuration?.hotkeys?.pushToTalk ?? ["space"],
      toggleKeys: view.configuration?.hotkeys?.toggle ?? [],
      onStart: mode => { void session.start(mode); },
      onStop: () => { void session.stop(); },
      onCancel: () => { void session.cancel(); },
      onInterrupt: () => { void session.interrupt(); },
    });
  });
  useEffect(() => () => composerRef.current?.setDictationBinding(undefined), [composerRef]);
  useEffect(() => {
    if (view.phase !== "recording" || !view.startedAt) return;
    const update = () => setElapsed(Date.now() - view.startedAt!);
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [view.phase, view.startedAt]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!active && !recovery && !root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) { setMenu(false); session.dismiss(); }
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !active) { setMenu(false); session.dismiss(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open, active, recovery, session]);
  useLayoutEffect(() => {
    const element = panel.current, anchor = root.current;
    if (!open || !element || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(390, window.innerWidth - 32);
      element.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
      element.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 10)}px`;
      element.style.maxHeight = `${Math.max(120, Math.min(540, rect.top - 22))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, view.phase]);
  const enable = async () => {
    if (!client || saving) return;
    setSaving(true); setLocalError("");
    const controller = new AbortController();
    try {
      const owner = ensureSession ? await ensureSession(controller.signal) : sessionId;
      if (!owner) throw new Error(t("请先打开一个会话。", "Open a conversation first."));
      const handle = await client.command("preferences.features.set", { sessionId: owner, key: "stt.enabled", value: true, scope: "global" });
      await waitReceipt(client, handle.requestId, 30000);
      await session.inspect();
    } catch (cause) { setLocalError(hostErrorMessage(cause, t("无法启用听写", "Could not enable dictation"))); }
    finally { setSaving(false); }
  };
  const press = () => {
    setLocalError("");
    setPanelDismissed(false);
    if (active) { void session.stop(); return; }
    if (recovery) { setMenu(true); return; }
    setMenu(false);
    void session.start("click");
  };
  const openOptions = () => {
    setMenu(true);
    setPanelDismissed(false);
    void session.inspect();
  };
  const text = recovery ? recovery.state.committedText + recovery.state.partialText : "";
  const phaseLabel = LABELS[view.phase][zh ? 0 : 1];
  const modeHint = view.configuration?.mode === "batch" ? t("停止录音后开始转写", "Transcription starts after you stop") : view.configuration?.mode === "segmented" ? t("稍作停顿后，文字会分段出现", "Text appears between phrases") : t("识别结果会显示在输入位置", "Recognized words appear at your cursor");
  return <div ref={root} className={`dictation-control${active ? " is-active" : ""}${recovery ? " has-recovery" : ""}`}>
    <button type="button" className="icon-btn small dictation-mic" aria-label={active ? t("停止听写", "Stop dictation") : t("语音输入", "Voice input")} aria-description={t("右键打开语音输入选项，也可按菜单键或 Shift+F10", "Right-click, press the menu key or Shift+F10 for voice input options")} aria-haspopup="dialog" aria-pressed={active} aria-expanded={open} data-tip={active ? t("停止并填入草稿 · 右键打开选项", "Stop and fill draft · right-click for options") : t("语音输入 · 右键打开选项", "Voice input · right-click for options")} onPointerDown={event => event.preventDefault()} onClick={press} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openOptions(); }} onKeyDown={event => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault(); event.stopPropagation(); openOptions();
      }
    }}>
      <Icon name={view.phase === "recording" ? "stop" : "mic"} extra="sm" />
    </button>
    {open ? createPortal(<div ref={panel} className="dictation-panel" role="dialog" aria-label={t("语音输入状态", "Voice input status")}>
      <header className="dictation-head"><span className={`dictation-status-mark ${view.phase}`}><Icon name={recovery || view.phase === "error" ? "alert-c" : "mic"} extra="sm" /></span><strong role="status">{phaseLabel}</strong>{view.phase === "recording" ? <time>{clock(elapsed)}</time> : null}<span className="spacer" />{!active ? <button type="button" className="icon-btn small" aria-label={t("收起听写面板", "Close dictation panel")} onClick={() => { setMenu(false); session.dismiss(); setPanelDismissed(true); }}><Icon name="x" extra="sm" /></button> : null}</header>
      {active ? <>
        {view.phase === "recording" ? <><div className="dictation-meter-row"><meter className="dictation-level" min={0} max={1} value={view.level} aria-label={t("录音输入电平", "Recording input level")} /><span className="tiny muted">{view.level < .015 && elapsed > 2500 ? t("没有检测到明显声音", "No clear sound detected") : t("麦克风已打开", "Microphone is on")}</span></div><p className="tiny muted">{modeHint}</p></> : <p className="small muted">{view.phase === "opening" ? t("如出现系统权限提示，请允许麦克风。准备完成前不会显示正在录音。", "Allow microphone access if your system asks. Listening starts only when the input is ready.") : view.capture?.message || (view.phase === "transcribing" ? t("麦克风已关闭，正在处理最后一段。", "The microphone is off. Processing the last phrase.") : t("模型和接收器准备好后才打开麦克风。", "The microphone opens after the model and receiver are ready."))}</p>}
        {view.capture?.progress ? <div className="dictation-progress"><progress max={100} {...(view.capture.progress.percent === undefined ? {} : { value: view.capture.progress.percent })} aria-label={t("模型准备进度", "Model preparation progress")} /><span>{view.capture.progress.percent === undefined ? t("准备中", "Preparing") : `${view.capture.progress.percent}%`}</span></div> : null}
        <div className="dictation-actions">{view.phase === "recording" ? <button type="button" className="btn small primary" onClick={() => void session.stop()}>{t("停止并填入草稿", "Stop and fill draft")}</button> : null}<button type="button" className="btn small ghost" onClick={() => void session.cancel()}>{t("取消并丢弃本次", "Cancel and discard")}</button></div>
      </> : recovery && !view.pendingRetry ? <>
        <p className="small">{t("录音已停止，仅保存在本次应用内存中。", "Recording is stopped and retained only in this app's memory.")} {clock(recovery.durationMs)}</p>
        {!ownRecovery ? <p className="dictation-warning">{t("这段内容属于另一个输入位置，请回到原会话或 BTW 后处理。", "This belongs to another input. Return to its conversation or BTW to recover it.")} {recovery.owner.label}</p> : null}
        {text ? <p className="dictation-recovery-text">{text}</p> : <p className="tiny muted">{t("尚无已识别文字，可重新转写录音。", "No text has been recognized yet. Retry transcription from the audio.")}</p>}
        <div className="dictation-actions"><button type="button" className="btn small primary" disabled={view.inserted || !ownRecovery || !recovery.canReplay || !available} onClick={() => void session.start("retry", false, true)}>{t("重试转写", "Retry transcription")}</button><button type="button" className="btn small outline" disabled={view.inserted || !ownRecovery || !text} onPointerDown={event => event.preventDefault()} onClick={() => void session.keepText()}>{t("保留文字", "Keep text")}</button><button type="button" className="btn small ghost" disabled={!text} onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(cause => setLocalError(hostErrorMessage(cause, "Copy failed"))); }}>{copied ? t("已复制", "Copied") : t("复制", "Copy")}</button><button type="button" className="btn small ghost" onClick={() => void session.discardRecovery()}>{t("丢弃", "Discard")}</button></div>
        {recovery.configuration.cloud ? <p className="tiny muted">{t("重试会再次调用转写服务，可能重复计费。不会自动重试或切换服务。", "Retry calls the service again and may be billed again. Retries and provider changes are never automatic.")}</p> : null}
      </> : <>
        {!apiAvailable || !available || target.id ? <p className="dictation-warning">{target.id ? t("远程工作区暂不转发本机麦克风，请切回本机工作区。", "Remote workspaces do not forward the local microphone. Select a local workspace.") : !apiAvailable ? t("此窗口没有新版桌面听写通道。请使用更新后的桌面应用。", "This window has no updated desktop dictation channel. Use the updated desktop app.") : t("请先连接支持听写的 Runtime。", "Connect a Runtime that supports dictation first.")}</p> : null}
        {view.configuration ? <DictationDetails configuration={view.configuration} /> : <p className="small muted">{t("准备后会显示实际生效的模型与语言。", "The active model and language appear after preparation.")}</p>}
        {view.configuration && !view.configuration.enabled ? <button type="button" className="btn small primary" disabled={saving} onClick={() => void enable()}>{saving ? t("正在启用…", "Enabling…") : t("启用语音输入", "Enable voice input")}</button> : null}
        {menu ? <MicrophoneSetup visible={visible && menu} /> : null}
        <div className="dictation-actions">{view.configuration?.enabled && !view.configuration.blockedReason && available && apiAvailable && !target.id ? <button type="button" className="btn small primary" onPointerDown={event => event.preventDefault()} onClick={() => { setMenu(false); void session.start(view.pendingRetry ? "retry" : "click", true, view.pendingRetry === true); }}>{view.configuration.downloadRequired ? t("下载模型并开始", "Download model and start") : view.configuration.cloud ? t("使用此服务并开始", "Use this service and start") : t("开始听写", "Start dictation")}</button> : null}{onModels ? <button type="button" className="btn small outline" onClick={onModels}>{t("选择转写模型", "Choose speech model")}</button> : null}{onSettings ? <button type="button" className="btn small ghost" onClick={onSettings}>{t("语音输入设置", "Voice input settings")}</button> : null}</div>
        <p className="tiny muted">{t("点击麦克风开始或停止，识别结果填入草稿；自动发送默认关闭。", "Click the microphone to start or stop and fill the draft. Automatic submission is off by default.")}</p>
      </>}
      {view.message || localError ? <p className={view.phase === "complete" ? "small" : "dictation-warning"} role={view.phase === "complete" ? "status" : "alert"}>{localError || view.message}</p> : null}
      {!active && (view.phase === "error" || localError) ? <MicrophoneSettingsButton zh={zh} /> : null}
    </div>, document.body) : null}
  </div>;
}
