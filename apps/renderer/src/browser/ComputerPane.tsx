import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientBootstrap, CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { ComputerObservationResultMap, StudioComputerStatus } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceEmpty, WorkspaceStatus } from "../workspaces/Workspace";
import { PREVIEW_COMPUTER, PREVIEW_COMPUTER_IMAGE } from "../preview/computerPreview";
import "./browser.css";

export function ComputerPane({ client, sessionId, available, visible, capabilities }: { client: StudioClient; sessionId?: string | undefined; available: boolean; visible: boolean; capabilities?: ClientBootstrap["capabilityManifest"] | undefined }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<StudioComputerStatus>(); const [selected, setSelected] = useState(""); const [picture, setPicture] = useState<string>(); const [capturedAt, setCapturedAt] = useState<number>();
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [enableConfirm, setEnableConfirm] = useState(false);
  const generation = useRef(0); const currentBlob = useRef<string | undefined>(undefined);
  const can = (kind: string) => preview || (available && !!sessionId && capabilities?.capabilities.some(item => item.id === kind && item.grade !== "unavailable") === true);
  const canRead = can("computer.status");
  const invoke = useCallback(async <K extends keyof ComputerObservationResultMap>(kind: K, input: CommandInput<K>): Promise<ComputerObservationResultMap[K]> => { const handle = await client.command(kind, input); return (await waitReceipt<{ result: ComputerObservationResultMap[K] }>(client, handle.requestId, 30000)).result; }, [client]);
  const clearPicture = useCallback(() => { if (currentBlob.current) URL.revokeObjectURL(currentBlob.current); currentBlob.current = undefined; setPicture(undefined); setCapturedAt(undefined); }, []);
  useEffect(() => { setStatus(preview ? PREVIEW_COMPUTER : undefined); setSelected(preview ? PREVIEW_COMPUTER.targets[0]!.id : ""); setError(""); setNotice(""); setEnableConfirm(false); }, [preview, sessionId]);
  useEffect(() => {
    generation.current++; clearPicture(); setBusy(false);
    if (!visible || !canRead) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!preview && !document.hidden) { const value = await invoke("computer.status", { sessionId: sessionId! }); if (active) { setStatus(value); setSelected(current => value.targets.some(target => target.id === current) ? current : value.targets[0]?.id ?? ""); } } }
      catch (cause) { if (active) setError(hostErrorMessage(cause, zh ? "电脑状态不可用" : "Computer status unavailable")); }
      finally { if (active && !preview) timer = setTimeout(() => void poll(), 4000); }
    };
    const release = () => { generation.current++; clearPicture(); if (!preview && sessionId) void invoke("computer.observe.release", { sessionId }).catch(() => {}); };
    const onHide = () => { if (document.hidden) release(); }; document.addEventListener("visibilitychange", onHide);
    void poll(); return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onHide); release(); };
  }, [visible, canRead, preview, sessionId, invoke, clearPicture, zh]);
  const capture = async () => {
    if (!selected || busy || !can("computer.capture")) return; const epoch = generation.current; setBusy(true); setError("");
    try {
      if (preview) { clearPicture(); setPicture(PREVIEW_COMPUTER_IMAGE); setCapturedAt(Date.now()); return; }
      const value = await invoke("computer.capture", { sessionId: sessionId!, targetId: selected });
      if (epoch !== generation.current) return;
      const result = await globalThis.ompStudioChrome?.readComputerCapture?.({ captureId: value.captureId, sessionId: value.sessionId, targetId: value.targetId });
      if (epoch !== generation.current) return;
      if (!result?.ok) throw new Error(result?.message ?? "Private computer capture transport unavailable");
      clearPicture(); currentBlob.current = URL.createObjectURL(new Blob([result.data], { type: "image/png" })); setPicture(currentBlob.current); setCapturedAt(Date.now());
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "截图失败" : "Capture failed")); }
    finally { if (epoch === generation.current) setBusy(false); }
  };
  return <section className="browser-pane" aria-label={zh ? "电脑观察" : "Computer observation"}>
    <div className="browser-toolbar"><strong>Computer Use</strong>{preview ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}<WorkspaceStatus state={status?.running ? "running" : "idle"} /></div>
    {!canRead ? <WorkspaceEmpty icon="monitor" title={zh ? "此 Runtime 尚不支持电脑观察" : "Computer observation unavailable"}>{zh ? "连接支持此能力的 Runtime 后重试。" : "Connect a Runtime that supports this capability."}</WorkspaceEmpty> : null}
    {error ? <p className="browser-error" role="alert">{error}</p> : null}{notice ? <p role="status" className="browser-hint">{notice}</p> : null}
    {status ? <><div className="computer-permissions"><span>{zh ? "截图" : "Capture"} · {status.capturePermission}</span><span>{zh ? "原生输入权限" : "Native input permission"} · {status.inputPermission}</span><span>{zh ? "辅助功能" : "Accessibility"} · {status.axPermission}</span></div>{status.reason ? <p role="status" className="browser-hint">{status.reason}</p> : null}{!status.enabled ? <button className="btn small primary" disabled={!can("computer.configure")} onClick={() => setEnableConfirm(true)}>{zh ? "启用原生电脑能力" : "Enable native Computer Use"}</button> : null}</> : null}
    <div className="browser-toolbar"><select className="select" aria-label={zh ? "屏幕或窗口" : "Screen or window"} value={selected} disabled={!status?.available || busy} onChange={event => { generation.current++; clearPicture(); setSelected(event.target.value); setBusy(false); }}><option value="">{zh ? "选择目标" : "Select a target"}</option>{status?.targets.map(target => <option key={target.id} value={target.id}>{target.kind === "display" ? zh ? "屏幕" : "Display" : zh ? "窗口" : "Window"} · {target.name}</option>)}</select></div>
    <div className="browser-toolbar"><button className="btn small primary" disabled={!selected || !status?.available || busy || !can("computer.capture") || (!preview && !globalThis.ompStudioChrome?.readComputerCapture)} onClick={() => void capture()}>{busy ? "…" : zh ? "刷新截图" : "Refresh capture"}</button><button className="btn small outline danger" disabled={!can("computer.stop")} onClick={() => { if (preview) { setStatus(value => value ? { ...value, running: 0 } : value); setNotice(zh ? "演示：已请求停止" : "Demo: stop requested"); return; } void invoke("computer.stop", { sessionId: sessionId! }).then(() => setNotice(zh ? "已请求停止当前会话及其子代理的电脑操作。" : "Stop requested for this session and its agents.")).catch(cause => setError(hostErrorMessage(cause, "Computer stop failed"))); }}>{zh ? "停止电脑操作" : "Stop computer actions"}</button></div>
    {picture ? <div className="browser-picture"><img src={picture} alt={zh ? "所选电脑目标截图" : "Selected computer target capture"} onLoad={event => { const image = event.currentTarget; if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 4_000_000) { clearPicture(); setError(zh ? "截图超过资源限制" : "Capture exceeds resource limits"); } }} onError={() => { clearPicture(); setError(zh ? "截图无法解码" : "Capture cannot be decoded"); }} /></div> : <WorkspaceEmpty icon="monitor" title={zh ? "选择目标后刷新截图" : "Select a target and refresh"} />}
    <p className="browser-hint">{zh ? "仅观察屏幕与窗口，不在 Studio 转发电脑鼠标或键盘。" : "Observe screens and windows. Studio does not forward desktop mouse or keyboard input."}{capturedAt ? ` · ${new Date(capturedAt).toLocaleTimeString()}` : ""}</p>
    {enableConfirm ? <div className="session-options-confirm" role="dialog" aria-label={zh ? "启用电脑能力" : "Enable Computer Use"}><p>{zh ? "将 computer.enabled 保存到原生全局配置。具体电脑输入仍由原生工具审批控制。" : "Save computer.enabled in native global configuration. Native tool approvals still govern computer input."}</p><button className="btn small primary" onClick={() => { if (preview) { setStatus(PREVIEW_COMPUTER); setEnableConfirm(false); return; } void invoke("computer.configure", { sessionId: sessionId!, enabled: true }).then(() => setEnableConfirm(false)).catch(cause => setError(hostErrorMessage(cause, "Cannot enable Computer Use"))); }}>{zh ? "确认" : "Confirm"}</button><button className="btn small outline" onClick={() => setEnableConfirm(false)}>{zh ? "取消" : "Cancel"}</button></div> : null}
  </section>;
}
