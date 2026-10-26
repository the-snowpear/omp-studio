import { AppSelect } from "../AppSelect";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientBootstrap, CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { ComputerObservationResultMap, StudioComputerStatus } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceDialog } from "../workspaces/Workspace";
import { PREVIEW_COMPUTER, PREVIEW_COMPUTER_IMAGE } from "../preview/computerPreview";
import "./computer.css";

type ComputerPaneProps = {
  client: StudioClient;
  sessionId?: string | undefined;
  available: boolean;
  visible: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
};

const PERMISSION_LABELS: Record<string, [string, string]> = {
  granted: ["已授权", "Granted"],
  denied: ["未授权", "Not granted"],
  unknown: ["未检测", "Not checked"],
  unavailable: ["不可用", "Unavailable"],
  "prompt-or-granted": ["需要系统确认", "System confirmation"],
};

function computerReason(reason: string | undefined, zh: boolean): string | undefined {
  if (!zh) return reason;
  switch (reason) {
    case "Computer Use is disabled in native settings.": return "原生电脑能力尚未启用。";
    case "Private desktop capture transport is unavailable.": return "当前连接未提供电脑截图通道，请使用桌面客户端。";
    case "Screen capture is unavailable or permission has not been granted.": return "屏幕截图暂不可用，请检查系统的屏幕录制权限。";
    default: return reason;
  }
}

function ComputerIllustration({ locked, loading }: { locked: boolean; loading: boolean }) {
  return <div className={`computer-illustration${loading ? " is-loading" : ""}`} aria-hidden="true">
    <div className="computer-illustration-screen">
      <div className="computer-illustration-bar"><i /><i /><i /></div>
      <div className="computer-illustration-content"><span /><div><i /><i /><i /></div></div>
    </div>
    <span className="computer-illustration-stand" />
    <span className="computer-illustration-symbol"><Icon name={loading ? "refresh" : locked ? "lock" : "eye"} /></span>
  </div>;
}

export function ComputerPane({ client, sessionId, available, visible, capabilities }: ComputerPaneProps) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<StudioComputerStatus>();
  const [selected, setSelected] = useState("");
  const [capture, setCapture] = useState<{ src: string; time: number; width: number; height: number }>();
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [configureConfirm, setConfigureConfirm] = useState<boolean>();
  const [expanded, setExpanded] = useState(false);
  const generation = useRef(0);
  const captureGeneration = useRef(0);
  const currentBlob = useRef<string | undefined>(undefined);
  const can = (kind: string) => preview || (available && !!sessionId && capabilities?.capabilities.some(item => item.id === kind && item.grade !== "unavailable") === true);
  const canRead = can("computer.status");
  const desktopCapture = preview || !!globalThis.ompStudioChrome?.readComputerCapture;

  const invoke = useCallback(async <K extends keyof ComputerObservationResultMap>(kind: K, input: CommandInput<K>): Promise<ComputerObservationResultMap[K]> => {
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: ComputerObservationResultMap[K] }>(client, handle.requestId, 30000)).result;
  }, [client]);

  const clearCapture = useCallback(() => {
    if (currentBlob.current) URL.revokeObjectURL(currentBlob.current);
    currentBlob.current = undefined;
    setCapture(undefined);
    setExpanded(false);
  }, []);

  const applyStatus = useCallback((value: StudioComputerStatus) => {
    setStatus(value);
    setSelected(current => value.targets.some(target => target.id === current) ? current : value.targets[0]?.id ?? "");
    setLoadError("");
  }, []);

  useEffect(() => {
    captureGeneration.current++;
    clearCapture();
    setCapturing(false);
    setError("");
  }, [selected, clearCapture]);

  useEffect(() => {
    generation.current++;
    captureGeneration.current++;
    clearCapture();
    setStatus(preview ? PREVIEW_COMPUTER : undefined);
    setSelected(preview ? PREVIEW_COMPUTER.targets[0]!.id : "");
    setLoadError("");
    setError("");
    setNotice("");
    setCapturing(false);
    setConfiguring(false);
    setStopping(false);
    setConfigureConfirm(undefined);
    if (!visible || !canRead) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!preview && !document.hidden) {
          const value = await invoke("computer.status", { sessionId: sessionId! });
          if (active && !document.hidden) applyStatus(value);
        }
      } catch (cause) {
        if (active) setLoadError(hostErrorMessage(cause, zh ? "无法读取电脑状态" : "Cannot read computer status"));
      } finally {
        if (active && !preview) timer = setTimeout(() => void poll(), 4000);
      }
    };
    const release = () => {
      generation.current++;
      captureGeneration.current++;
      clearCapture();
      setCapturing(false);
      setConfiguring(false);
      setStopping(false);
      setConfigureConfirm(undefined);
      if (!preview && sessionId) void invoke("computer.observe.release", { sessionId }).catch(() => {});
    };
    const onHide = () => { if (document.hidden) release(); };
    document.addEventListener("visibilitychange", onHide);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHide);
      release();
    };
  }, [visible, canRead, preview, sessionId, invoke, clearCapture, applyStatus, zh]);

  const refreshCapture = async () => {
    if (!selected || capturing || !can("computer.capture") || !status?.available || !desktopCapture) return;
    const epoch = captureGeneration.current;
    setCapturing(true);
    setError("");
    setNotice("");
    try {
      if (preview) {
        clearCapture();
        setCapture({ src: PREVIEW_COMPUTER_IMAGE, time: Date.now(), width: 1280, height: 800 });
        return;
      }
      const value = await invoke("computer.capture", { sessionId: sessionId!, targetId: selected });
      if (epoch !== captureGeneration.current) return;
      const result = await globalThis.ompStudioChrome!.readComputerCapture!({ captureId: value.captureId, sessionId: value.sessionId, targetId: value.targetId });
      if (epoch !== captureGeneration.current) return;
      if (!result.ok) throw new Error(result.message);
      clearCapture();
      currentBlob.current = URL.createObjectURL(new Blob([result.data], { type: "image/png" }));
      setCapture({ src: currentBlob.current, time: Date.now(), width: value.width, height: value.height });
    } catch (cause) {
      if (epoch === captureGeneration.current) setError(hostErrorMessage(cause, zh ? "截图失败，请重试" : "Capture failed. Try again."));
    } finally {
      if (epoch === captureGeneration.current) setCapturing(false);
    }
  };

  const configure = async (enabled: boolean) => {
    const epoch = generation.current;
    setConfiguring(true);
    setError("");
    setNotice("");
    try {
      if (preview) {
        applyStatus(enabled ? PREVIEW_COMPUTER : { ...PREVIEW_COMPUTER, enabled: false, available: false, capturePermission: "unknown", inputPermission: "unknown", axPermission: "unknown", targets: [] });
        clearCapture();
        setConfigureConfirm(undefined);
        return;
      }
      await invoke("computer.configure", { sessionId: sessionId!, enabled });
      if (epoch !== generation.current) return;
      const value = await invoke("computer.status", { sessionId: sessionId! });
      if (epoch !== generation.current) return;
      applyStatus(value);
      if (!value.enabled) clearCapture();
      setConfigureConfirm(undefined);
      if (value.enabled !== enabled) setNotice(zh ? "全局设置已保存，当前会话仍使用自己的电脑能力设置。" : "Global preference saved. This session has its own Computer Use setting.");
    } catch (cause) {
      if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "无法更新电脑能力设置" : "Cannot update Computer Use settings"));
    } finally {
      if (epoch === generation.current) setConfiguring(false);
    }
  };

  const stop = async () => {
    const epoch = generation.current;
    setStopping(true);
    setError("");
    setNotice("");
    try {
      if (preview) {
        setStatus(value => value ? { ...value, running: 0 } : value);
        setNotice(zh ? "演示：已请求停止" : "Demo: stop requested");
        return;
      }
      await invoke("computer.stop", { sessionId: sessionId! });
      if (epoch !== generation.current) return;
      setNotice(zh ? "已请求停止当前会话及其子代理的电脑操作。" : "Stop requested for this session and its agents.");
      const value = await invoke("computer.status", { sessionId: sessionId! });
      if (epoch === generation.current) applyStatus(value);
    } catch (cause) {
      if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "停止电脑操作失败" : "Cannot stop computer actions"));
    } finally {
      if (epoch === generation.current) setStopping(false);
    }
  };

  const target = status?.targets.find(item => item.id === selected);
  const displays = status?.targets.filter(item => item.kind === "display") ?? [];
  const windows = status?.targets.filter(item => item.kind === "window") ?? [];
  const running = status?.running ?? 0;
  const loading = canRead && !status && !loadError;
  const stateLabel = !canRead ? zh ? "未连接" : "Disconnected"
    : loading ? zh ? "连接中" : "Connecting"
    : running ? zh ? `${running} 项操作中` : `${running} active`
    : !status ? zh ? "连接失败" : "Connection failed"
    : !status.enabled ? zh ? "未启用" : "Disabled"
    : status.available ? zh ? "已就绪" : "Ready" : zh ? "未就绪" : "Not ready";
  const permissionRows = [
    { label: zh ? "屏幕录制" : "Screen capture", value: status?.capturePermission, icon: "monitor" },
    { label: zh ? "键鼠输入" : "Mouse & keyboard", value: status?.inputPermission, icon: "keyboard" },
    { label: zh ? "辅助功能" : "Accessibility", value: status?.axPermission, icon: "steering" },
  ];
  const granted = permissionRows.filter(row => row.value === "granted").length;
  const permissionSummary = !status ? zh ? "等待检测" : "Not checked"
    : !status.enabled ? zh ? "启用后检测" : "Checked when enabled"
    : granted === 3 ? zh ? "全部已授权" : "All granted"
    : permissionRows.some(row => row.value === "denied") ? zh ? "需要授权" : "Permission needed"
    : zh ? "查看权限状态" : "View permissions";

  let emptyTitle: string;
  let emptyDescription: string;
  if (!canRead) {
    emptyTitle = zh ? "等待连接电脑" : "Waiting for a computer";
    emptyDescription = zh ? "连接支持 Computer Use 的会话后，可在这里查看屏幕与窗口。" : "Connect a session with Computer Use to view its screens and windows.";
  } else if (loading) {
    emptyTitle = zh ? "正在读取电脑状态" : "Connecting to your computer";
    emptyDescription = zh ? "正在检测原生能力与可观察的目标。" : "Checking native capabilities and available targets.";
  } else if (!status) {
    emptyTitle = zh ? "暂时无法连接电脑" : "Cannot connect to the computer";
    emptyDescription = zh ? "请检查会话连接，电脑状态会自动重试。" : "Check your session connection. Status will retry automatically.";
  } else if (!status.enabled) {
    emptyTitle = zh ? "开启电脑观察" : "Enable computer observation";
    emptyDescription = zh ? "查看代理操作的屏幕与窗口，随时掌握当前进展。" : "View the screens and windows your agent is working with.";
  } else if (!desktopCapture) {
    emptyTitle = zh ? "在桌面客户端查看" : "Open the desktop app";
    emptyDescription = zh ? "电脑截图通过桌面客户端读取，请在 OMP Studio 桌面版打开此面板。" : "Open this panel in the OMP Studio desktop app to view computer captures.";
  } else if (!status.available) {
    emptyTitle = status.capturePermission === "denied" ? zh ? "需要屏幕录制权限" : "Screen recording permission needed" : zh ? "电脑截图暂不可用" : "Screen capture unavailable";
    emptyDescription = computerReason(status.reason, zh) ?? (zh ? "请在系统设置中允许屏幕录制，授权后会自动更新。" : "Allow screen recording in system settings. Status updates automatically.");
  } else if (!target) {
    emptyTitle = status.reason ? zh ? "无法读取观察目标" : "Cannot read computer targets" : zh ? "暂无可观察的目标" : "No targets available";
    emptyDescription = computerReason(status.reason, zh) ?? (zh ? "连接显示器或打开应用窗口后，目标会自动出现在列表中。" : "Connect a display or open an app window. Targets appear automatically.");
  } else {
    emptyTitle = zh ? "画面已准备就绪" : "Ready for a closer look";
    emptyDescription = zh ? "刷新截图，查看所选屏幕或窗口的当前画面。" : "Refresh the capture to view this screen or window.";
  }

  return <section className="computer-pane" aria-label={zh ? "电脑观察" : "Computer observation"}>
    <header className="computer-heading">
      <span className="computer-heading-icon"><Icon name="monitor" /></span>
      <div className="computer-heading-copy"><div><h2>Computer Use</h2>{preview ? <span className="computer-demo">{zh ? "演示" : "Demo"}</span> : null}</div><p>{zh ? "屏幕与窗口观察" : "Screens & windows"}</p></div>
      <span className={`computer-state${running ? " is-active" : status?.enabled && status.available ? " is-ready" : ""}`} role="status"><i />{stateLabel}</span>
    </header>

    <div className="computer-content">
      <div className="computer-target-section">
        <div className="computer-section-label"><label htmlFor="computer-target">{zh ? "观察目标" : "Observation target"}</label><span>{status?.available ? zh ? `${displays.length} 个屏幕 · ${windows.length} 个窗口` : `${displays.length} displays · ${windows.length} windows` : zh ? "屏幕 / 应用窗口" : "Display / app window"}</span></div>
        <div className="computer-target-tools">
          <div className="computer-target-select"><Icon name={target?.kind === "window" ? "panel" : "monitor"} /><AppSelect id="computer-target" aria-label={zh ? "屏幕或窗口" : "Screen or window"} value={selected} disabled={!status?.available || configuring} onChange={event => { setSelected(event.target.value); setNotice(""); }}>
            <option value="">{!status?.enabled ? zh ? "启用后选择目标" : "Enable to select a target" : zh ? "选择屏幕或窗口" : "Select a screen or window"}</option>
            {displays.length ? <optgroup label={zh ? "屏幕" : "Displays"}>{displays.map(item => <option key={item.id} value={item.id}>{item.name}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ""}</option>)}</optgroup> : null}
            {windows.length ? <optgroup label={zh ? "应用窗口" : "App windows"}>{windows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup> : null}
          </AppSelect></div>
          <button type="button" className="computer-button computer-refresh" aria-label={zh ? "刷新截图" : "Refresh capture"} disabled={!selected || !status?.available || capturing || configuring || !can("computer.capture") || !desktopCapture} onClick={() => void refreshCapture()}><Icon name="refresh" extra={capturing ? "computer-spin" : ""} /><span>{capturing ? zh ? "截图中" : "Capturing" : zh ? "刷新截图" : "Refresh"}</span></button>
        </div>
      </div>

      {error || loadError ? <p className="computer-feedback is-error" role="alert"><Icon name="alert-c" /><span>{error || loadError}</span></p> : null}
      {notice ? <p className="computer-feedback" role="status"><Icon name="check" /><span>{notice}</span></p> : null}

      <div className="computer-viewer">
        <div className="computer-viewer-head"><span><Icon name={target?.kind === "window" ? "panel" : "monitor"} /><span>{target?.name ?? (zh ? "屏幕预览" : "Screen preview")}</span></span><span className="computer-viewer-mode"><Icon name="eye" />{zh ? "仅观察" : "View only"}</span></div>
        <div className={`computer-canvas${capture ? " has-capture" : ""}`} aria-busy={capturing}>
          {capture ? <button type="button" className="computer-capture-open" aria-label={zh ? "查看大图" : "Enlarge capture"} onClick={() => setExpanded(true)}><img key={capture.src + capture.time} src={capture.src} alt={zh ? "所选电脑目标截图" : "Selected computer target capture"} draggable={false} onLoad={event => {
            const image = event.currentTarget;
            if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 4_000_000) { clearCapture(); setError(zh ? "截图超过资源限制" : "Capture exceeds resource limits"); }
          }} onError={() => { clearCapture(); setError(zh ? "截图无法解码，请重新刷新" : "Capture cannot be decoded. Refresh to retry."); }} /><span className="computer-enlarge"><Icon name="expand" />{zh ? "查看大图" : "Enlarge"}</span></button> : <div className="computer-empty">
            <ComputerIllustration locked={!!status && !status.enabled} loading={loading || capturing} />
            <h3>{capturing ? zh ? "正在获取画面" : "Capturing your screen" : emptyTitle}</h3>
            <p>{emptyDescription}</p>
            {canRead && status && !status.enabled ? <button type="button" className="computer-button is-primary computer-enable" disabled={!can("computer.configure")} onClick={() => setConfigureConfirm(true)}><Icon name="zap" />{zh ? "启用 Computer Use" : "Enable Computer Use"}</button> : null}
            {status?.enabled && status.available && target && desktopCapture ? <button type="button" className="computer-button is-primary" disabled={capturing || !can("computer.capture")} onClick={() => void refreshCapture()}><Icon name="image" />{zh ? "获取截图" : "Capture screen"}</button> : null}
          </div>}
          {capturing && capture ? <div className="computer-capture-progress"><Icon name="refresh" extra="computer-spin" />{zh ? "正在刷新画面…" : "Refreshing capture…"}</div> : null}
        </div>
        <div className="computer-viewer-foot"><span><i className={capture ? "has-capture" : ""} />{capture ? zh ? "最近截图" : "Last capture" : zh ? "尚未截图" : "No capture yet"}{capture ? <time dateTime={new Date(capture.time).toISOString()}>{new Date(capture.time).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour12: false })}</time> : null}</span><span>{capture ? `${capture.width} × ${capture.height}` : zh ? "手动刷新" : "Manual refresh"}</span></div>
      </div>

      <details className="computer-permissions">
        <summary><span><Icon name="settings" />{zh ? "系统权限" : "System permissions"}</span><span className={status?.enabled && granted === 3 ? "is-granted" : ""}>{permissionSummary}<Icon name="chevron-d" /></span></summary>
        <div className="computer-permission-body">
          <div className="computer-setting"><div><strong>{zh ? "原生电脑能力" : "Native Computer Use"}</strong><p>{zh ? "对所有会话生效，输入遵循原生审批" : "Global preference. Native input approvals apply."}</p></div><button type="button" className="computer-switch" role="switch" aria-label={zh ? "原生电脑能力" : "Native Computer Use"} aria-checked={!!status?.enabled} disabled={!status || !can("computer.configure") || configuring} onClick={() => setConfigureConfirm(!status?.enabled)}><span /></button></div>
          <dl>{permissionRows.map(row => <div key={row.icon}><dt><Icon name={row.icon} />{row.label}</dt><dd className={status?.enabled && row.value === "granted" ? "is-granted" : status?.enabled && row.value === "denied" ? "is-denied" : ""}>{!status ? zh ? "未检测" : "Not checked" : !status.enabled ? zh ? "待启用" : "Enable to check" : PERMISSION_LABELS[row.value ?? "unknown"]?.[zh ? 0 : 1] ?? (zh ? "未检测" : "Not checked")}</dd></div>)}</dl>
          {status?.enabled ? <p className="computer-permission-note">{zh ? "权限由操作系统管理，状态自动更新。" : "Permissions are managed by your OS and update automatically."}{status.backend !== "unavailable" ? <span>{({ win32: "Windows", quartz: "macOS", x11: "X11", wayland: "Wayland", demo: zh ? "演示环境" : "Demo" } as Record<string, string>)[status.backend] ?? status.backend}</span> : null}</p> : null}
        </div>
      </details>

      <div className="computer-session-control"><div><span className={running ? "is-active" : ""}><i />{!status ? zh ? "等待电脑活动状态" : "Waiting for activity status" : running ? zh ? `${running} 项电脑操作进行中` : `${running} computer actions active` : zh ? "当前没有电脑操作" : "No computer actions running"}</span><p>{zh ? "当前会话及其子代理" : "This session and its agents"}</p></div><button type="button" className={`computer-button computer-stop${running ? " is-running" : ""}`} aria-label={zh ? "停止电脑操作" : "Stop computer actions"} disabled={!can("computer.stop") || stopping} onClick={() => void stop()}><Icon name="stop" />{stopping ? zh ? "停止中" : "Stopping" : zh ? "停止操作" : "Stop actions"}</button></div>
      <p className="computer-hint"><Icon name="eye" /><span>{zh ? "此处仅查看截图，电脑操作由对话中的代理执行。" : "View captures here. Your agent operates the computer through the conversation."}</span></p>
    </div>

    {configureConfirm !== undefined ? <WorkspaceDialog title={configureConfirm ? zh ? "启用 Computer Use" : "Enable Computer Use" : zh ? "关闭 Computer Use" : "Disable Computer Use"} onClose={() => { if (!configuring) setConfigureConfirm(undefined); }}><div className="computer-confirm"><span className="computer-confirm-icon"><Icon name={configureConfirm ? "monitor" : "lock"} /></span><p>{configureConfirm ? zh ? "启用后，代理可以使用原生电脑工具查看屏幕、操作键鼠。具体操作仍遵循原生工具审批。" : "Allow your agent to view screens and use native mouse and keyboard tools. Native tool approvals still apply." : zh ? "关闭后，不再允许新的电脑调用。中断当前正在执行的操作，请使用「停止操作」。" : "Disable new computer calls. Use Stop actions to interrupt work already in progress."}</p><p className="computer-confirm-note">{zh ? "此设置将保存为所有会话的全局偏好。" : "This preference is saved globally for all sessions."}</p>{error ? <p className="computer-feedback is-error" role="alert">{error}</p> : null}<div className="computer-confirm-actions"><button type="button" className="computer-button" disabled={configuring} onClick={() => setConfigureConfirm(undefined)}>{zh ? "取消" : "Cancel"}</button><button type="button" className="computer-button is-primary" disabled={configuring} onClick={() => void configure(configureConfirm)}>{configuring ? <Icon name="refresh" extra="computer-spin" /> : null}{configuring ? zh ? "保存中…" : "Saving…" : configureConfirm ? zh ? "确认启用" : "Enable" : zh ? "确认关闭" : "Disable"}</button></div></div></WorkspaceDialog> : null}
    {expanded && capture ? <WorkspaceDialog title={target?.name ?? (zh ? "电脑截图" : "Computer capture")} onClose={() => setExpanded(false)}><div className="computer-expanded"><img src={capture.src} alt={zh ? "电脑截图大图" : "Enlarged computer capture"} /><p>{capture.width} × {capture.height}<span>{new Date(capture.time).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour12: false })}</span></p></div></WorkspaceDialog> : null}
  </section>;
}
