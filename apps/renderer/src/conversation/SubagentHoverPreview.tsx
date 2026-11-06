import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionId } from "@omp-studio/client-contract";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { SurfaceProvider, surfaceWindow } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { ConvoTranscript } from "./ConvoTranscript";
import { SubagentHoverContext, type SubagentHoverCard } from "./SubagentHoverContext";
import { applyLiveSubagentRoster, findLiveSubagent, resolveSubagentMetrics, SubagentMetrics } from "./SubagentMetrics";
import { useSubagentConversation } from "./useSubagentConversation";
import { conversationFollowKey, useConversationScroll } from "./useConversationScroll";
import { useConversationViewLease } from "./conversationViews";
import type { SubagentConversationClient } from "./subagentConversationEngine";
import { saPill } from "./toolMeta";
import "./subagentHoverPreview.css";

export const SUBAGENT_HOVER_DELAY_MS = 300;
const EDGE = 12;
const GAP = 10;
const WIDTH = 560;
const HEIGHT = 520;

type HoverRequest = SubagentHoverCard & { readonly scope: string; readonly client: SubagentConversationClient | null };
type PreviewSource = {
  readonly client: SubagentConversationClient | null;
  readonly agents: readonly StudioAgentSnapshot[];
  readonly runtimeConnected: boolean;
  readonly parentSessionId?: SessionId;
  readonly liveSessionId?: SessionId;
};

/** The controller is stable; opening a preview only renders the portal, not its children. */
export function SubagentHoverProvider({ scope, enabled = true, children, ...source }: PreviewSource & {
  readonly scope: string;
  readonly enabled?: boolean;
  readonly children: ReactNode;
}) {
  const { preview } = usePreviewMode();
  const identity = JSON.stringify([scope, preview, source.parentSessionId, source.liveSessionId]);
  const options = useRef({ identity, enabled, client: source.client });
  options.current = { identity, enabled, client: source.client };
  const [shown, setShown] = useState<HoverRequest | null>(null);
  const current = useRef<HoverRequest | null>(null);
  const teardown = useRef<() => void>(() => {});

  const close = useCallback((anchor?: HTMLElement) => {
    if (anchor !== undefined && current.current?.anchor !== anchor) return;
    teardown.current();
    teardown.current = () => {};
    current.current = null;
    setShown(null);
  }, []);

  const open = useCallback((card: SubagentHoverCard) => {
    if (!options.current.enabled || current.current?.anchor === card.anchor) return;
    close();
    current.current = { ...card, scope: options.current.identity, client: options.current.client };
    const doc = card.anchor.ownerDocument;
    const win = surfaceWindow(doc);
    const dismiss = () => close();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onScroll = (event: Event) => {
      // Native scroll events are captured, including the preview's own tail writes.
      // Only scrolling an ancestor of the original card dismisses the preview.
      if ((event.target as Node | null)?.contains(card.anchor)) close();
    };
    const onVisibility = () => { if (doc.hidden) close(); };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("scroll", onScroll, true);
    doc.addEventListener("visibilitychange", onVisibility);
    doc.documentElement.addEventListener("pointerleave", dismiss);
    win.addEventListener("blur", dismiss);
    const timer = win.setTimeout(() => {
      if (card.anchor.isConnected) setShown(current.current);
      else close();
    }, SUBAGENT_HOVER_DELAY_MS);
    teardown.current = () => {
      win.clearTimeout(timer);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      doc.documentElement.removeEventListener("pointerleave", dismiss);
      win.removeEventListener("blur", dismiss);
    };
  }, [close]);

  const update = useCallback((card: SubagentHoverCard) => {
    const previous = current.current;
    if (previous?.anchor !== card.anchor) return;
    const keys = Object.keys(card.agent) as Array<keyof typeof card.agent>;
    if (keys.length === Object.keys(previous.agent).length
      && keys.every(key => card.agent[key] === previous.agent[key])
      && card.pill.cls === previous.pill.cls && card.pill.label === previous.pill.label
      && card.inspectable === previous.inspectable) return;
    const next = { ...previous, ...card };
    current.current = next;
    setShown(value => value?.anchor === card.anchor ? next : value);
  }, []);
  const control = useMemo(() => ({ open, update, close }), [open, update, close]);
  useLayoutEffect(() => { close(); }, [identity, source.client, enabled, close]);
  useEffect(() => () => { teardown.current(); current.current = null; }, []);

  const request = enabled && shown?.scope === identity && shown.client === source.client ? shown : null;
  const doc = request?.anchor.ownerDocument;
  const generation = request ? findLiveSubagent(request.agent, source.agents)?.generation : undefined;
  return <SubagentHoverContext.Provider value={control}>
    {children}
    {request && doc ? createPortal(
      <SurfaceProvider document={doc}>
        <SubagentHoverContext.Provider value={null}>
          <SubagentHoverPreview key={JSON.stringify([identity, request.target?.agentId, generation])}
            request={request} preview={preview} close={close} {...source} />
        </SubagentHoverContext.Provider>
      </SurfaceProvider>, doc.body,
    ) : null}
  </SubagentHoverContext.Provider>;
}

function SubagentHoverPreview({ request, preview, close, client, agents, runtimeConnected, parentSessionId, liveSessionId }: PreviewSource & {
  readonly request: HoverRequest;
  readonly preview: boolean;
  readonly close: () => void;
}) {
  const { marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const doc = request.anchor.ownerDocument;
  const win = surfaceWindow(doc);
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number; side: "above" | "below"; largeUi: boolean } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const rect = request.anchor.getBoundingClientRect();
      const width = Math.min(WIDTH, Math.max(0, win.innerWidth - EDGE * 2));
      const below = Math.max(0, win.innerHeight - EDGE - rect.bottom - GAP);
      const above = Math.max(0, rect.top - EDGE - GAP);
      const side = below < HEIGHT && above > below ? "above" : "below";
      const height = Math.min(HEIGHT, side === "above" ? above : below);
      if (height === 0 || width === 0) { close(); return; }
      const uiScale = Number(win.getComputedStyle(doc.documentElement).getPropertyValue("--ui-font-scale"));
      setBox({ width, height, side, largeUi: uiScale > 1.25,
        left: Math.max(EDGE, Math.min(rect.left, win.innerWidth - EDGE - width)),
        top: side === "above" ? rect.top - GAP - height : rect.bottom + GAP });
    };
    place();
    const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(place) : undefined;
    observer?.observe(request.anchor);
    win.addEventListener("resize", place);
    return () => { observer?.disconnect(); win.removeEventListener("resize", place); };
  }, [request.anchor, win, close]);

  const live = findLiveSubagent(request.agent, agents);
  const agent = preview ? request.agent : applyLiveSubagentRoster(request.agent, agents);
  const pill = preview ? request.pill : saPill(agent);
  const model = live?.resolvedModel ?? request.target?.resolvedModel;
  const scrollerRef = useRef<HTMLElement | null>(null);
  const snapshot = useSubagentConversation({ preview, previewStream: true, client: preview ? null : client,
    target: request.target ?? null, runtimeConnected,
    ...(live?.generation === undefined ? {} : { agentGeneration: live.generation }),
    ...((request.target?.parentSessionId ?? parentSessionId) === undefined ? {} : { parentSessionId: (request.target?.parentSessionId ?? parentSessionId) as SessionId }),
    ...(liveSessionId === undefined ? {} : { liveSessionId }) });
  useConversationViewLease(snapshot.state.identity, preview, scrollerRef, runtimeConnected);
  const scroll = useConversationScroll({ scrollerRef, identityKey: snapshot.identityKey,
    itemCount: snapshot.rows.length, loadingOlder: false, contentKey: conversationFollowKey(snapshot.state) });
  const { state, rows } = snapshot;
  const loading = rows.length === 0 && (state.hydrateStatus === "idle" || state.hydrateStatus === "loading" || state.hydrateStatus === "resyncing");
  const density = box && (box.height < 440 || box.width < 440 && box.largeUi) ? box.height < 320 ? "tight" : "compact" : undefined;
  const unavailable = state.unavailableReason ?? (zh ? "暂无子 Agent 对话。" : "No agent conversation yet.");
  const costHint = zh ? density ? "API 等价估算" : "费用为 API 等价估算" : density ? "API estimate" : "API-equivalent cost estimate";
  const openHint = zh ? density ? "点击打开完整对话" : "点击卡片打开完整对话" : density ? "Open full conversation" : "Click to open the full conversation";
  const metrics = resolveSubagentMetrics(preview ? undefined : live?.usage, agent);

  return <aside id={request.id} role="tooltip" aria-label={zh ? `${agent.name} 的对话预览` : `${agent.name} conversation preview`}
    className={`sa-hover-preview ${agent.status}`} data-activity={pill.cls} data-placement={box?.side} data-density={density}
    style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : { visibility: "hidden" }}>
    <header className="sa-hover-head">
      <span className="sa-hover-avatar" aria-hidden="true"><Icon name="bot" /></span>
      <div className="sa-hover-identity">
        <div className="sa-hover-heading">
          <strong>{agent.name}</strong>
          {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
          <span className={`hub-act ${pill.cls}`}><span className="sa-hover-dot" aria-hidden="true" /><span className="sa-hover-status-label">{pill.label}</span></span>
        </div>
        <div className="sa-hover-meta">
          {model ? <span className="sa-hover-model">{model}</span> : null}
          {live?.modelRole ? <span className="sa-hover-role">{live.modelRole}</span> : null}
          {agent.dur ? <span className="sa-hover-duration"><Icon name="clock" extra="sm" />{agent.dur}</span> : null}
          {request.target ? <span className="sa-hover-agent-id">{request.target.agentId}</span> : null}
        </div>
      </div>
    </header>
    {agent.task ? <div className="sa-hover-brief">
      <div className="sa-hover-task"><span>{zh ? "任务" : "Task"}</span><p>{agent.task}</p></div>
    </div> : null}
    <div className="sa-hover-chat-label"><span>{zh ? "对话" : "Conversation"}</span>
      {!preview && !runtimeConnected ? <span className="sa-hover-offline">{zh ? "已离线" : "Offline"}</span> : null}
      {(preview || runtimeConnected) && state.hydrateStatus === "resyncing" ? <span>{zh ? "正在同步" : "Syncing"}</span> : null}
    </div>
    <section ref={scrollerRef} className="convo-scroll conversation-surface sa-hover-scroll" inert onScroll={scroll.onScroll}>
      <div className="convo-doc sa-hover-doc" role="log" aria-live="off">
        {loading ? <div className="sa-hover-skeleton" role="status" aria-label={zh ? "正在读取子 Agent 对话…" : "Loading agent conversation…"}>
          <span /><span /><span />
        </div> : null}
        {state.hydrateStatus === "error" ? <div className="sa-hover-empty" role="status"><Icon name="alert" extra="sm" /><p>{state.error?.message}</p></div> : null}
        {!loading && state.hydrateStatus !== "error" && rows.length === 0 ? <div className="sa-hover-empty" role="status"><Icon name="message" /><p>{unavailable}</p></div> : null}
        {rows.length > 0 ? <>
          {!preview && !runtimeConnected ? <div className="convo-notice info">{zh ? "已离线，显示已读取的对话。" : "Offline. Showing the conversation already loaded."}</div> : null}
          <ConvoTranscript scrollerRef={scrollerRef} rows={rows} {...(snapshot.demo ? { demo: true } : {})} />
        </> : null}
      </div>
    </section>
    {request.inspectable || Object.keys(metrics).length > 0 ? <footer className="sa-hover-foot">
      <SubagentMetrics {...metrics} showTooltips={false} />
      <div className="sa-hover-hint">
        {agent.cost ? <span>{costHint}</span> : null}
        {request.inspectable ? <span>{openHint}<Icon name="chevron-r" extra="sm" /></span> : null}
      </div>
    </footer> : null}
  </aside>;
}
