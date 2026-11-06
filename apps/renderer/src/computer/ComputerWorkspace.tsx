import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComputerAction, ComputerFrame, ComputerStructureNode, ComputerStructureSnapshot } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useSurfaceChrome, useSurfaceDocument } from "../dock/SurfaceContext";
import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { buildComputerPreview, previewComputerFrame, previewComputerStructure } from "../preview/computerPreview";
import { actionName, controlLabel, foregroundLabel, workspaceEmpty, workspaceStatus } from "./presentation";
import { computerCommand, computerWorkspaceSource, type ComputerReadState } from "./workspaceSource";
import { ComputerActivity } from "./ComputerActivity";
import { ComputerFrameView } from "./ComputerFrameView";
import { ComputerStructure } from "./ComputerStructure";
import { ComputerSettings } from "./ComputerSettings";
import { hasComputerCapability, type ComputerPaneProps } from "./types";
import "./computerWorkspace.css";

const EMPTY: ComputerReadState = { snapshot: undefined, actions: [], frames: [], loading: false, loadingMore: false, nextCursor: undefined, error: "" };
const noSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function ComputerWorkspace(props: ComputerPaneProps) {
  const { client, available, visible, capabilities, width = 480, height = 600, sessionName, onRevealConversation, onRevealApproval, onOpenSettings } = props;
  const sessionId = props.sessionId ?? "preview";
  const scopeKey = props.scopeKey ?? sessionId;
  const executionTarget = props.executionTarget ?? { kind: "unknown" as const };
  const { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const doc = useSurfaceDocument(), chrome = useSurfaceChrome();
  const [documentVisible, setDocumentVisible] = useState(!doc.hidden);
  useEffect(() => { const change = () => setDocumentVisible(!doc.hidden); change(); doc.addEventListener("visibilitychange", change); return () => doc.removeEventListener("visibilitychange", change); }, [doc]);
  const isVisible = visible && documentVisible;
  const source = useMemo(() => computerWorkspaceSource(client, sessionId, scopeKey), [client, sessionId, scopeKey]);
  const live = isVisible && available && !!props.sessionId && !preview;
  const state = useSyncExternalStore(live ? source.subscribe : noSubscribe, preview ? emptySnapshot : source.getSnapshot);
  const mediaRevision = source.mediaRevision;
  const [demo, setDemo] = useState(() => buildComputerPreview(sessionId, props.previewScenario));
  const snapshot = preview ? demo.snapshot : state.snapshot;
  const actions = preview ? demo.actions : state.actions;
  const frames = preview ? demo.snapshot.frames : state.frames;
  const [fixedTarget, setFixedTarget] = useState(""), [agent, setAgent] = useState("");
  const [selection, setSelection] = useState<{ action?: ComputerAction; frameId?: string; frame?: ComputerFrame; missing?: boolean } | undefined>(() => preview && props.previewScenario === "history" ? { action: demo.actions[1]!, frameId: demo.snapshot.frames[0]!.frameId, frame: demo.snapshot.frames[0]! } : undefined);
  const [extraFrame, setExtraFrame] = useState<ComputerFrame>();
  const [automatic, setAutomatic] = useState(false), [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState<"stop" | "handoff" | "continue" | "enable" | "save" | undefined>();
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [details, setDetails] = useState(false), [stepsOpen, setStepsOpen] = useState(false);
  const [structure, setStructure] = useState<ComputerStructureSnapshot>(), [structureLoading, setStructureLoading] = useState(false);
  const [node, setNode] = useState<ComputerStructureNode>();
  const generation = useRef(0), selectionGeneration = useRef(0), writeLock = useRef(false);
  const controlRequest = useRef(0), controlPending = useRef<"stop" | "handoff" | "continue" | undefined>(undefined);
  const previousMediaRevision = useRef(mediaRevision);
  useEffect(() => {
    if (previousMediaRevision.current === mediaRevision) return;
    previousMediaRevision.current = mediaRevision;
    generation.current++; selectionGeneration.current++; controlRequest.current++; controlPending.current = undefined;
    setSelection(undefined); setExtraFrame(undefined); setStructure(undefined); setNode(undefined); setAutomatic(false); setBusy(undefined);
  }, [mediaRevision]);
  useEffect(() => { generation.current++; selectionGeneration.current++; return () => { generation.current++; selectionGeneration.current++; }; }, [source, preview]);
  useEffect(() => { if (!isVisible) { generation.current++; selectionGeneration.current++; setExtraFrame(undefined); setStructure(undefined); setNode(undefined); setCapturing(false); setStructureLoading(false); setBusy(undefined); } }, [isVisible]);
  const can = (kind: string) => preview || available && !!props.sessionId && hasComputerCapability(capabilities, kind);
  const active = snapshot?.active.filter(action => !agent || action.agentId === agent || agent === "main" && !action.agentId) ?? [];
  const executionFrames = frames.filter(frame => frame.source === "execution" && (!agent || frame.agentId === agent || agent === "main" && !frame.agentId));
  const latest = [...executionFrames].sort((a, b) => b.capturedAt - a.capturedAt)[0];
  const targetId = fixedTarget || active.find(action => action.targetId)?.targetId || latest?.targetId || "";
  const currentExecutionFrame = fixedTarget ? [...executionFrames].filter(frame => frame.targetId === fixedTarget).sort((a, b) => b.capturedAt - a.capturedAt)[0] : latest;
  const currentFrame = extraFrame?.targetId === targetId && (!currentExecutionFrame || extraFrame.capturedAt > currentExecutionFrame.capturedAt) ? extraFrame : currentExecutionFrame;
  const frame = selection ? (frames.find(item => item.frameId === selection.frameId) ?? selection.frame) : currentFrame;
  const validTarget = !!snapshot?.targets.some(target => target.id === targetId);
  const observeAllowed = isVisible && !selection && validTarget && !!snapshot?.capabilities.capture && !!snapshot?.capabilities.observationOnly && !snapshot.screen.locked && !snapshot.screen.asleep && can("computer.observe.open") && can("computer.observe.close") && can("computer.frame.capture");
  const structureAllowed = isVisible && !selection && validTarget && !!snapshot?.capabilities.accessibility && !!snapshot?.capabilities.observationOnly && !snapshot.screen.locked && !snapshot.screen.asleep && can("computer.observe.open") && can("computer.observe.close") && can("computer.structure.get");
  const selectFrame = useCallback(async (action?: ComputerAction, frameId?: string) => {
    const stamp = ++selectionGeneration.current;
    setSelection({ ...(action ? { action } : {}), ...(frameId ? { frameId } : {}) });
    setStructure(undefined); setNode(undefined); setError("");
    if (!frameId) return;
    try {
      const selected = preview ? demo.snapshot.frames.find(item => item.frameId === frameId) ?? previewComputerFrame(sessionId) : await source.getFrame(frameId);
      if (stamp !== selectionGeneration.current) return;
      setSelection({ ...(action ? { action } : {}), frameId, ...(selected ? { frame: selected } : { missing: true }) });
    } catch (cause) { if (stamp === selectionGeneration.current) { setSelection({ ...(action ? { action } : {}), frameId, missing: true }); setError(hostErrorMessage(cause, zh ? "无法读取历史画面" : "Cannot read historical frame")); } }
  }, [source, preview, demo.snapshot.frames, sessionId, zh]);
  const selectFrameRef = useRef(selectFrame); selectFrameRef.current = selectFrame;
  useEffect(() => {
    const intent = props.frameIntent;
    if (!intent) return;
    void selectFrameRef.current(undefined, intent.frameId);
  }, [props.frameIntent?.id]);
  useEffect(() => {
    if (!automatic || !observeAllowed) return;
    if (preview) {
      setExtraFrame({ ...previewComputerFrame(sessionId, 3), frameId: "computer-preview-observation", targetId, targetName: snapshot?.targets.find(target => target.id === targetId)?.name ?? targetId, source: "observation", delivered: false });
      return;
    }
    return source.observe(targetId, update => {
      if (update.frame) setExtraFrame(update.frame);
      if (update.error) setError(update.error);
      if (update.paused) { setAutomatic(false); setNotice(zh ? "自动观察已暂停；空闲 30 秒、锁屏或目标不可用时不再采集。" : "Automatic observation paused after 30 seconds idle, screen lock, or target loss."); }
    });
  }, [automatic, observeAllowed, source, targetId, preview, sessionId, zh]);
  const capture = async () => {
    if (!observeAllowed || capturing) return;
    const stamp = generation.current;
    setCapturing(true); setError(""); setNotice("");
    try {
      const next = preview ? { ...previewComputerFrame(sessionId, 3), frameId: "computer-preview-observation", capturedAt: Date.now(), targetId, targetName: snapshot?.targets.find(target => target.id === targetId)?.name ?? targetId, source: "observation" as const, delivered: false } : await source.capture(targetId);
      if (stamp === generation.current) setExtraFrame(next);
    } catch (cause) { if (stamp === generation.current) setError(hostErrorMessage(cause, zh ? "观察截图失败" : "Observation capture failed")); }
    finally { if (stamp === generation.current) setCapturing(false); }
  };
  const control = async (kind: "stop" | "handoff" | "continue") => {
    if (kind === "continue" && !snapshot || !can(`computer.control.${kind === "continue" ? "continue" : "stop"}`) || controlPending.current === "stop" || controlPending.current === "handoff" || kind === "continue" && controlPending.current) return;
    // Stop may supersede a pending continue. A delayed continue receipt cannot undo the new stop.
    const request = ++controlRequest.current;
    controlPending.current = kind;
    const stamp = generation.current;
    const current = () => request === controlRequest.current && stamp === generation.current && source.mediaRevision === mediaRevision;
    setBusy(kind); setError(""); setNotice("");
    try {
      if (preview) {
        setDemo(value => ({ ...value, snapshot: { ...value.snapshot, control: { ...value.snapshot.control, status: kind === "continue" ? "continuing" : "stopped", revision: value.snapshot.control.revision + (kind === "continue" ? 0 : 1), foreground: "none" }, active: [] } }));
      } else if (kind === "continue") {
        const result = await computerCommand(client, "computer.control.continue", { sessionId, revision: snapshot!.control.revision });
        if (!current()) return;
        source.setControl(result.control);
        if (result.queued) setNotice(zh ? "继续请求已进入对话队列，尚未恢复电脑操作。" : "Continue is queued in the conversation; computer actions have not resumed.");
      } else {
        const result = await computerCommand(client, "computer.control.stop", { sessionId, reason: kind });
        if (!current()) return;
        source.setControl(result);
        if (kind === "handoff" && result.status === "stopped") setNotice(zh ? "本会话已让出操作。请切换到系统中的目标应用；这不代表你独占整台电脑。" : "This session has stopped input. Switch to the target app on your desktop; this is not exclusive control of the computer.");
      }
    } catch (cause) { if (current()) setError(hostErrorMessage(cause, zh ? "操作未确认，请读取最新状态后再决定" : "Action was not confirmed. Read the latest state before retrying.")); }
    finally { if (request === controlRequest.current) { controlPending.current = undefined; if (stamp === generation.current) setBusy(undefined); } }
  };
  const enable = async () => {
    if (writeLock.current || !can("preferences.features.set")) return;
    writeLock.current = true; setBusy("enable"); setError("");
    const stamp = generation.current;
    try {
      if (preview) setDemo(value => ({ ...value, snapshot: { ...value.snapshot, enabled: true } }));
      else {
        const handle = await client.command("preferences.features.set", { sessionId, key: "computer.enabled", value: true, scope: "session" });
        const { waitReceipt } = await import("../hostError");
        await waitReceipt(client, handle.requestId);
        if (stamp === generation.current) await source.refresh();
      }
    } catch (cause) { if (stamp === generation.current) setError(hostErrorMessage(cause, zh ? "无法启用电脑操作" : "Cannot enable computer use")); }
    finally { writeLock.current = false; if (stamp === generation.current) setBusy(current => current === "enable" ? undefined : current); }
  };
  const readStructure = async () => {
    if (structureLoading || !structureAllowed) return;
    const stamp = generation.current, selectedStamp = selectionGeneration.current;
    setStructureLoading(true); setError("");
    try {
      const next = preview ? previewComputerStructure(sessionId, targetId) : await source.structure(targetId);
      if (stamp !== generation.current || selectedStamp !== selectionGeneration.current) return;
      setStructure(next); setNode(undefined);
      // Only the structure's own frame has a proven coordinate mapping.
      if (next.frame) setExtraFrame(next.frame);
    } catch (cause) { if (stamp === generation.current) setError(hostErrorMessage(cause, zh ? "无法读取界面结构" : "Cannot read interface structure")); }
    finally { if (stamp === generation.current) setStructureLoading(false); }
  };
  const reveal = async (action?: Pick<ComputerAction, "sessionId" | "toolCallId" | "agentId">) => {
    const found = await onRevealConversation?.(action);
    if (found === false) setNotice(zh ? "该动作不在已加载的对话中。请加载更早消息后再定位。" : "This action is not in the loaded conversation. Load earlier messages, then locate it again.");
  };
  const save = async () => {
    if (!frame || preview || busy || executionTarget.kind !== "local" || !chrome?.saveComputerFrame) return;
    const stamp = generation.current; setBusy("save"); setError("");
    try {
      const result = await chrome.saveComputerFrame({ scopeSessionId: sessionId, frameId: frame.frameId, origin: "local" });
      if (stamp !== generation.current) return;
      if (!result.ok) throw Error(result.message);
      setNotice(zh ? "这张画面已保存到产物库。" : "This frame was saved to the artifact library.");
    } catch (cause) { if (stamp === generation.current) setError(hostErrorMessage(cause, zh ? "保存失败" : "Save failed")); }
    finally { if (stamp === generation.current) setBusy(current => current === "save" ? undefined : current); }
  };
  const historyEmpty: [string, string] = selection?.missing ? [zh ? "历史图像不可用" : "Historical image unavailable", zh ? "图像可能已过期或未保存。不会补拍替换历史。" : "The image may have expired or was not saved. No replacement capture will be taken."] : [zh ? "此步骤没有截图" : "This step has no screenshot", zh ? "只展示真实关联画面，不会为历史步骤补拍。" : "Only truly linked frames appear here; historical steps are never recaptured."];
  const agents = new Map(actions.map(action => [action.agentId ?? "main", action.agentName ?? action.agentId ?? (zh ? "主会话" : "Main session")]));
  const changedTarget = (value: string) => { selectionGeneration.current++; setFixedTarget(value); setSelection(undefined); setExtraFrame(undefined); setStructure(undefined); setNode(undefined); };
  const stopBusy = busy === "stop" || busy === "handoff" || snapshot?.control.status === "stopping";
  return <section className="computer-workspace" data-wide={width >= 760 || undefined} data-low={height < 340 || undefined} aria-label={zh ? "电脑工作区" : "Computer workspace"}>
    <header className="cw-header"><div className="cw-identity"><Icon name="monitor" /><div><strong>{zh ? "电脑" : "Computer"}</strong><span>{executionTarget.kind === "local" ? zh ? "本机" : "Local computer" : executionTarget.kind === "remote" ? executionTarget.name ?? (zh ? "远端设备" : "Remote computer") : zh ? "执行设备未知" : "Execution device unknown"} · {sessionName ?? props.sessionId ?? (zh ? "未选择会话" : "No session")}</span></div>{preview && marks ? <span className="cw-demo">{zh ? "演示" : "Demo"}</span> : null}</div><button className="cw-button cw-stop" disabled={!can("computer.control.stop") || stopBusy} onClick={() => void control("stop")}><Icon name="stop" />{stopBusy ? zh ? "停止中" : "Stopping" : zh ? "停止电脑操作" : "Stop computer actions"}</button></header>
    <div className="cw-controlbar"><div className="cw-current" role="status"><strong>{busy === "stop" || busy === "handoff" ? zh ? "正在请求停止，尚未确认" : "Requesting stop; not yet confirmed" : workspaceStatus(snapshot, zh)}</strong><span>{active[0] ? `${active[0].agentName ?? active[0].agentId ?? (zh ? "主会话" : "Main session")} · ${actionName(active[0], zh)} · ${active[0].targetName ?? active[0].targetId ?? (zh ? "目标未知" : "Unknown target")} · ${foregroundLabel(snapshot?.control, zh)}` : foregroundLabel(snapshot?.control, zh)}</span></div><div className="cw-control-actions"><button className="cw-button" disabled={!can("computer.control.stop") || stopBusy} onClick={() => void control("handoff")}>{zh ? "我来操作" : "I'll take over"}</button>{snapshot?.control.status === "stopped" || snapshot?.control.status === "unconfirmed" || snapshot?.control.status === "continuing" ? <button className="cw-button is-primary" disabled={!can("computer.control.continue") || !!busy || snapshot.control.status !== "stopped"} onClick={() => void control("continue")}>{zh ? "允许本会话继续电脑操作" : "Allow this session to continue"}</button> : null}<button className="cw-button" aria-expanded={details} onClick={() => setDetails(value => !value)}>{zh ? "详情" : "Details"}</button></div></div>
    <div className="cw-body">
      <div className="cw-main">
        <div className="cw-observe-tools"><AppSelect aria-label={zh ? "观察模式和目标" : "Observation mode and target"} value={fixedTarget} onChange={event => changedTarget(event.target.value)}><option value="">{zh ? "跟随代理" : "Follow agent"}</option>{snapshot?.targets.map(target => <option key={target.id} value={target.id}>{zh ? "固定观察" : "Fixed observation"} · {target.name}</option>)}{fixedTarget && !snapshot?.targets.some(target => target.id === fixedTarget) ? <option value={fixedTarget}>{zh ? "固定目标已消失" : "Fixed target disappeared"}</option> : null}</AppSelect>{agents.size > 1 ? <AppSelect aria-label={zh ? "代理来源" : "Agent source"} value={agent} onChange={event => { setAgent(event.target.value); changedTarget(fixedTarget); }}><option value="">{zh ? "所有代理" : "All agents"}</option>{[...agents].map(([id, name]) => <option value={id} key={id}>{name}</option>)}</AppSelect> : null}<button className="cw-button" disabled={!observeAllowed || capturing} onClick={() => void capture()}><Icon name="refresh" />{capturing ? zh ? "截图中" : "Capturing" : zh ? "刷新截图" : "Refresh capture"}</button><button className="cw-button" role="switch" aria-checked={automatic} disabled={!observeAllowed && !automatic} onClick={() => { setAutomatic(value => !value); setNotice(""); }}>{zh ? "自动观察" : "Automatic observation"}</button></div>
        {fixedTarget ? <p className="cw-subtle">{zh ? "固定的是观察画面，不是代理操作或授权范围。" : "Only observation is pinned; the agent's input or authorization scope is not changed."}{active[0]?.targetName ? ` ${zh ? "代理实际目标" : "Agent target"}：${active[0].targetName}` : ""}</p> : null}
        {snapshot?.reason || targetId && !validTarget ? <p className="cw-warning" role="status">{snapshot?.reason ?? (zh ? "观察目标已消失，已有画面仅供历史参考。请选择仍然存在的目标。" : "The observed target disappeared; the existing frame is historical. Select an available target.")}</p> : null}
        {snapshot?.control.foreground === "requested" ? <div className="cw-warning"><span>{foregroundLabel(snapshot.control, zh)}</span><button className="cw-button" disabled={!onRevealApproval} onClick={onRevealApproval}>{zh ? "前往原生审批" : "Go to native approval"}</button></div> : null}
        {!preview && (!available || state.loading) ? <p className="cw-subtle" role="status">{!available ? zh ? "当前连接不可用；保留的画面仅供历史参考。" : "Connection unavailable; retained frames are historical only." : zh ? "正在同步电脑状态…" : "Syncing Computer state…"}</p> : null}
        {snapshot?.screen.locked || snapshot?.screen.asleep ? <p className="cw-warning">{zh ? "屏幕已锁定或休眠，额外观察已暂停。已有图像不是当前画面。" : "Screen locked or asleep; extra observation paused. Existing images are not current."}</p> : null}
        {error || state.error ? <p className="cw-error" role="alert">{error || state.error}<button className="cw-button" disabled={!live} onClick={() => void source.refresh()}>{zh ? "读取最新状态" : "Read latest state"}</button></p> : null}
        {notice ? <p className="cw-notice" role="status">{notice}</p> : null}
        {selection ? <div className="cw-history-state"><span>{zh ? "正在查看历史" : "Viewing history"}</span><button className="cw-button" onClick={() => { selectionGeneration.current++; setSelection(undefined); setStructure(undefined); setNode(undefined); }}>{zh ? "回到当前" : "Back to current"}</button>{frame?.toolCallId ? <button className="cw-button" onClick={() => void reveal(frame)}>{zh ? "在对话中查看" : "View in conversation"}</button> : null}</div> : null}
        {snapshot && !snapshot.enabled && !selection ? <div className="cw-enable"><button className="cw-button is-primary" disabled={!can("preferences.features.set") || !!busy} onClick={() => void enable()}>{zh ? "为本次会话启用" : "Enable for this session"}</button><p>{zh ? "不会自动发送任务，也不会跳过原生审批。重新启用不会解除停止闸门。" : "No task is sent and native approvals still apply. Re-enabling does not clear a stop."}</p></div> : null}
        <ComputerFrameView frame={frame} scopeSessionId={sessionId} scopeKey={`${scopeKey}:${mediaRevision}`} executionTarget={executionTarget} visible={isVisible && (preview || available)} viewportHeight={Math.max(160, height - 225)} preview={preview} zh={zh} empty={selection ? historyEmpty : workspaceEmpty(snapshot, zh)} highlight={structure?.coordinateSpace === "frame" && structure.frame?.frameId === frame?.frameId ? node : undefined} onSave={!preview && chrome?.saveComputerFrame && executionTarget.kind === "local" ? () => void save() : undefined} />
        <div className="cw-bottom-links"><button className="cw-button" onClick={() => void reveal()} disabled={!onRevealConversation}><Icon name="message" />{zh ? "返回对话下达任务" : "Return to conversation"}</button><button className="cw-button cw-steps-toggle" aria-expanded={stepsOpen} onClick={() => setStepsOpen(value => !value)}>{zh ? "近期动作" : "Recent actions"} ({actions.length})</button></div>
        {details ? <div className="cw-details"><h3>{zh ? "诊断与观察详情" : "Diagnostics and observation"}</h3><dl>{[
          [zh ? "执行脚本入口" : "Computer prelude", snapshot ? snapshot.preludeAvailable ? zh ? "可用" : "Available" : zh ? "不可用" : "Unavailable" : undefined],
          [zh ? "后端" : "Backend", snapshot?.backend], [zh ? "截图权限" : "Capture permission", snapshot?.permissions.capture], [zh ? "输入权限" : "Input permission", snapshot?.permissions.input], [zh ? "辅助功能权限" : "Accessibility permission", snapshot?.permissions.accessibility],
          [zh ? "全局 Esc 停止" : "Global Escape", snapshot ? snapshot.capabilities.globalEscape ? zh ? "可用" : "Available" : zh ? "不可用，请使用此面板停止" : "Unavailable; stop from this panel" : undefined],
          [zh ? "锁屏与休眠检测" : "Lock and sleep detection", snapshot?.screen.known === true ? zh ? "支持" : "Supported" : zh ? "当前后端不提供可靠检测" : "Not reliably reported by this backend"],
          [zh ? "前台控制" : "Foreground control", foregroundLabel(snapshot?.control, zh)],
          [zh ? "会话停止状态" : "Session stop state", controlLabel(snapshot?.control, zh)],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? (zh ? "未知" : "Unknown")}</dd></div>)}</dl>{snapshot?.reason ? <p>{snapshot.reason}</p> : null}<p className="cw-subtle">{zh ? "默认不额外抓图。自动观察：活动时最多每 2 秒一帧，空闲每 5 秒，连续空闲 30 秒暂停。离开最后一个可见面板后释放观察。" : "No extra capture by default. Opt-in observation: at most every 2 seconds active, 5 seconds idle, paused after 30 seconds idle. The last visible panel releases observation."}</p><button className="cw-button" disabled={!structureAllowed || structureLoading} onClick={() => void readStructure()}>{structureLoading ? zh ? "正在读取结构…" : "Reading structure…" : structure ? zh ? "刷新界面结构" : "Refresh structure" : zh ? "读取界面结构" : "Read interface structure"}</button>{!snapshot?.capabilities.accessibility ? <p className="cw-subtle">{zh ? "此 Runtime 或目标未提供辅助功能结构；截图能力独立保留。" : "This Runtime or target does not provide accessibility structure. Capture remains independent."}</p> : null}{structure ? <ComputerStructure structure={structure} selected={node?.id} onSelect={setNode} zh={zh} /> : null}
          <ComputerSettings previewEnabled={preview ? snapshot?.enabled : undefined} onPreviewEnabled={enabled => setDemo(value => ({ ...value, snapshot: { ...value.snapshot, enabled, control: enabled ? value.snapshot.control : { ...value.snapshot.control, status: "stopped" }, active: enabled ? value.snapshot.active : [] } }))} client={client} context={{ sessionId: props.sessionId, available, capabilities }} visible={isVisible && details} onSaved={() => { if (!preview) void source.refresh(); }} />
          {onOpenSettings ? <button className="cw-button" onClick={onOpenSettings}>{zh ? "打开完整设置" : "Open full settings"}</button> : null}
        </div> : null}
      </div>
      <aside className="cw-steps" data-open={stepsOpen || undefined}><ComputerActivity actions={actions} selected={selection?.action?.id} onSelect={(action, frameId) => void selectFrame(action, frameId)} onReveal={action => void reveal(action)} more={!preview && !!state.nextCursor} busy={state.loadingMore} onMore={() => void source.loadMore()} zh={zh} /></aside>
    </div>
  </section>;
}
