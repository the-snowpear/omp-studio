import { PromptCachePanel } from "./PromptCachePanel";
import type { SessionId, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import type { StudioClient, ThreadId } from "@omp-studio/client-contract";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { DockPanel, useDock } from "../dock/DockContext";
import { DockPanelMeter, type PanelMeter } from "../dock/panelMeters";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_CONTEXT_CARD } from "../preview/contextCardPreview";
import { useViewedSessionTelemetry, type ViewedSessionTelemetryState } from "../telemetry/useViewedSessionTelemetry";
import "./contextCard.css";
import { useWideLayout } from "../layout/useWideLayout";
import { SessionCompactionInput } from "./SessionCompactionInput";
import { useSessionCompaction } from "./useSessionCompaction";
import { CONTEXT_GROUP_TINT, type ContextUsageGroup } from "../contextViewer/contextViewMath";

type ContextUsage = NonNullable<SessionTelemetrySnapshot["context"]>;
const PARTS = [
  { key: "messagesTokens", zh: "对话消息", en: "Messages", group: "messages" },
  { key: "systemToolsTokens", zh: "工具定义", en: "Tool definitions", group: "tools" },
  { key: "systemContextTokens", zh: "系统上下文", en: "System context", group: "instructions" },
  { key: "systemPromptTokens", zh: "系统提示词", en: "System prompt", group: "system" },
  { key: "skillsTokens", zh: "技能目录", en: "Skills", group: "system" },
] as const;

function contextUsageSegments(context: ContextUsage, zh: boolean) {
  const counts: Record<ContextUsageGroup, number> = {
    messages: context.messagesTokens,
    tools: context.systemToolsTokens,
    instructions: context.systemContextTokens,
    system: context.systemPromptTokens + context.skillsTokens,
  };
  const labels = { messages: zh ? "对话消息" : "Messages", tools: zh ? "工具定义" : "Tool definitions", instructions: zh ? "系统上下文" : "System context", system: zh ? "提示词与技能" : "Prompt and skills" };
  return (Object.keys(counts) as ContextUsageGroup[]).map(group => ({ id: group, group, label: labels[group], tokens: counts[group], color: CONTEXT_GROUP_TINT[group] }));
}

/** From this width the card is a dashboard: a ring beside the full breakdown. */
const CONTEXT_WIDE_MIN = 640;
const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return value.toLocaleString();
}

export function ContextCard({ context, status = "live", source, demo = false, onOpenDetails, onCompact, compactDisabled = false, compacting = false, thresholdControl, thresholdPercent, cacheControl, queueInstead = false }: {
  context: ContextUsage | null | undefined;
  status?: ViewedSessionTelemetryState["status"];
  source?: ViewedSessionTelemetryState["source"];
  demo?: boolean;
  onOpenDetails?: (() => void) | undefined;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compacting?: boolean | undefined;
  thresholdControl?: ReactNode;
  cacheControl?: ReactNode;
  queueInstead?: boolean | undefined;
  thresholdPercent?: number | null | undefined;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [rootRef, wide] = useWideLayout<HTMLDivElement>(CONTEXT_WIDE_MIN);
  if (!context) return <div className={`context-card context-card-empty${wide ? " is-wide" : ""}`} ref={rootRef} role="status">
    <span>{status === "loading" ? zh ? "正在读取上下文…" : "Reading context…" : zh ? "暂无上下文用量" : "Context usage unavailable"}</span>
    <p>{zh ? "当前会话尚未提供可用的上下文数据。" : "This session has not reported context usage."}</p>
    {thresholdControl ? <footer className="context-card-footer">{thresholdControl}</footer> : null}
  </div>;

  const capacity = context.contextWindow;
  const percent = context.percent;
  const rows: { id: string; label: string; tokens: number; color: string; group?: ContextUsageGroup }[] = PARTS.map(part => ({ id: part.key, group: part.group, label: zh ? part.zh : part.en, tokens: context[part.key], color: CONTEXT_GROUP_TINT[part.group] }));
  const segments = contextUsageSegments(context, zh);
  rows.push({ id: "free", label: zh ? "剩余空间" : "Free space", tokens: Math.max(0, capacity - context.usedTokens), color: "var(--context-free)" });
  const provenance = demo ? zh ? "演示" : "Demo"
    : source === "persisted" ? zh ? "上次记录" : "Last observed"
    : source === "archive-recomputed" ? zh ? "重新估算" : "Recomputed"
    : context.anchored ? zh ? "已按实际用量校准" : "Calibrated to usage"
    : zh ? "原生估算" : "Native estimate";

  const footer = <footer className="context-card-footer">
      {thresholdControl ?? <span className="context-card-source">{provenance}</span>}
      <div className="context-card-actions">
        {onCompact ? <button type="button" className="context-card-compact" onClick={onCompact} disabled={compactDisabled || compacting}
          aria-label={compacting ? zh ? "正在压缩上下文" : "Compacting context" : zh ? "压缩上下文" : "Compact context"}
          aria-busy={compacting} data-tip={compacting ? zh ? "正在压缩上下文" : "Compacting context" : queueInstead ? zh ? "当前工作结束后压缩" : "Compact after current work yields" : zh ? "立即压缩当前会话的上下文" : "Compact this session's context now"}>
          <Icon name={compacting ? "clock" : "restore"} extra="sm" /><span>{compacting ? zh ? "压缩中" : "Compacting" : queueInstead ? zh ? "排队压缩" : "Queue compaction" : zh ? "压缩" : "Compact"}</span>
        </button> : null}
        {onOpenDetails ? <button type="button" className="context-card-details" onClick={onOpenDetails}
          aria-label={zh ? "查看详情" : "View details"} data-tip={zh ? "查看详情" : "View details"}>
          <span className="context-card-details-text">{zh ? "查看详情" : "View details"}</span>
          <Icon name="chevron-r" extra="sm" />
        </button> : null}
      </div>
    </footer>;

  if (wide) {
    const tone = percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal";
    const largest = Math.max(1, ...rows.filter(row => row.id !== "free").map(row => row.tokens));
    let offset = 0;
    const arcs = segments.filter(row => row.tokens > 0).map(row => {
      const length = Math.min(RING_LENGTH - offset, row.tokens / capacity * RING_LENGTH);
      const arc = { row, length, offset };
      offset += length;
      return arc;
    });
    const marker = thresholdPercent == null ? null : Math.min(100, thresholdPercent) / 100 * 2 * Math.PI;
    return <div className="context-card is-wide" ref={rootRef}>
      <div className="context-dash">
        <section className="context-dash-main">
          <div className="context-ring" data-tone={tone}>
            <svg viewBox="0 0 132 132" role="meter" aria-label={zh ? "上下文占用" : "Context usage"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)} aria-valuetext={`${percent.toFixed(1)}%`}>
              <circle className="context-ring-track" cx="66" cy="66" r={RING_RADIUS} />
              {arcs.map(({ row, length, offset: start }) => <circle key={row.id} cx="66" cy="66" r={RING_RADIUS} stroke={row.color} data-context-group={row.group}
                strokeDasharray={`${Math.max(0, length - 1.25)} ${RING_LENGTH - Math.max(0, length - 1.25)}`} strokeDashoffset={-start} tabIndex={0} role="img" aria-label={`${row.label} · ${tokens(row.tokens)} tokens`} data-tip={`${row.label} · ${tokens(row.tokens)} tokens`}><title>{`${row.label} · ${tokens(row.tokens)} tokens`}</title></circle>)}
              {marker === null ? null : <line className="context-ring-marker" x1={66 + (RING_RADIUS - 10) * Math.sin(marker)} y1={66 - (RING_RADIUS - 10) * Math.cos(marker)}
                x2={66 + (RING_RADIUS + 10) * Math.sin(marker)} y2={66 - (RING_RADIUS + 10) * Math.cos(marker)}>
                <title>{zh ? `压缩触发点 · ${thresholdPercent!.toFixed(1)}%` : `Compaction trigger · ${thresholdPercent!.toFixed(1)}%`}</title></line>}
            </svg>
            <div className="context-ring-label">
              <strong>{Math.round(percent)}<span>%</span></strong>
              <span>{zh ? "已使用" : "used"}</span>
            </div>
          </div>
          <div className="context-dash-side">
            <div className="context-dash-capacity" title={`${context.usedTokens.toLocaleString()} / ${capacity.toLocaleString()} tokens`}>
              <b>{tokens(context.usedTokens)}</b><span>/ {tokens(capacity)} tokens</span>
              <span className="context-dash-source">{provenance}</span>
            </div>
            <div className="context-dash-rows" role="list" aria-label={zh ? "上下文构成" : "Context composition"}>
              {rows.map(row => <div key={row.id} className={`context-dash-row${row.id === "free" ? " is-free" : ""}`} role="listitem">
                <i className="context-card-dot" data-context-group={row.group} style={{ background: row.color }} aria-hidden="true" />
                <span className="context-card-label">{row.label}</span>
                <span className="context-dash-bar" aria-hidden="true">{row.id === "free" ? null : <i style={{ width: `${row.tokens / largest * 100}%`, background: row.color }} />}</span>
                <span className="context-card-tokens" title={`${row.tokens.toLocaleString()} tokens`}>{tokens(row.tokens)}</span>
                <span className="context-card-percent">{(row.tokens / capacity * 100).toFixed(1)}%</span>
              </div>)}
            </div>
          </div>
        </section>
        {cacheControl}
        {footer}
      </div>
    </div>;
  }

  return <div className="context-card" ref={rootRef}>
    <div className="context-card-summary">
      <div className="context-card-used" data-tone={percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal"}>
        <strong>{Math.round(percent)}<span>%</span></strong><span data-tip={provenance}>{zh ? "已使用" : "used"}</span>
      </div>
      <span className="context-card-capacity" title={`${context.usedTokens.toLocaleString()} / ${capacity.toLocaleString()} tokens`}>
        <b>{tokens(context.usedTokens)}</b><span>/</span>{tokens(capacity)}
      </span>
    </div>
    <div className="context-card-meter-wrap"><div className="context-card-meter" role="meter" aria-label={zh ? "上下文占用" : "Context usage"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)} aria-valuetext={`${percent.toFixed(1)}%`}>
      {[...segments, rows.at(-1)!].filter(row => row.tokens > 0).map(row => <i key={row.id} data-context-group={row.group} style={{ width: `${row.tokens / capacity * 100}%`, background: row.color }} tabIndex={0} role="img" aria-label={`${row.label} · ${tokens(row.tokens)} tokens`} data-tip={`${row.label} · ${tokens(row.tokens)} tokens`} />)}
    </div>{thresholdPercent != null ? <span className="context-card-threshold-marker" style={{ left: `${Math.min(100, thresholdPercent)}%` }} data-tip={zh ? `压缩触发点 · ${thresholdPercent.toFixed(1)}%` : `Compaction trigger · ${thresholdPercent.toFixed(1)}%`} /> : null}</div>
    <div className="context-card-rows" role="list" aria-label={zh ? "上下文构成" : "Context composition"}>
      {rows.map(row => <div key={row.id} className={`context-card-row${row.id === "free" ? " is-free" : ""}`} role="listitem">
        <i className="context-card-dot" data-context-group={row.group} style={{ background: row.color }} aria-hidden="true" />
        <span className="context-card-label">{row.label}</span>
        <span className="context-card-tokens" title={`${row.tokens.toLocaleString()} tokens`}>{tokens(row.tokens)}</span>
        <span className="context-card-percent">{(row.tokens / capacity * 100).toFixed(1)}%</span>
      </div>)}
    </div>
    {cacheControl}
    {footer}
  </div>;
}

type ContextSourceProps = {
  client: StudioClient;
  viewedSessionId: SessionId | undefined;
  liveSessionId: SessionId | undefined;
  liveTelemetry: SessionTelemetrySnapshot | undefined;
  refreshToken?: number | undefined;
  onOpenDetails: () => void;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compacting?: boolean | undefined;
  viewedThreadId?: ThreadId | undefined;
  compactionAvailable?: boolean | undefined;
  previewSessionId?: string | undefined;
  queueInstead?: boolean | undefined;
  compactionRefreshKey?: string | undefined;
};

export function ContextDockCard({ client, visible, viewedSessionId, liveSessionId, liveTelemetry, refreshToken, onOpenDetails, onCompact, compactDisabled, compacting, viewedThreadId, compactionAvailable = false, previewSessionId, compactionRefreshKey, queueInstead, render }: ContextSourceProps & {
  visible: boolean;
  render?: (card: ReactNode, context: ContextUsage | null | undefined) => ReactNode;
}) {
  const { preview, marks } = usePreviewMode();
  const view = useViewedSessionTelemetry({ client: preview ? null : client, preview, enabled: visible, viewedSessionId, liveSessionId, liveTelemetry, ...(refreshToken === undefined ? {} : { refreshToken }) });
  // Native context bodies belong to the active Runtime; archive reads only supply usage.
  const canInspect = preview || viewedSessionId === undefined || viewedSessionId === liveSessionId;
  const context = preview ? PREVIEW_CONTEXT_CARD : view.telemetry?.context;
  const sessionId = preview ? previewSessionId ?? "preview-context" : viewedSessionId ?? liveSessionId;
  const compaction = useSessionCompaction({ client, sessionId, threadId: viewedThreadId, liveSessionId, enabled: compactionAvailable,
    visible, preview, contextWindow: context?.contextWindow, refreshKey: compactionRefreshKey });
  const triggerPercent = compaction.state?.automatic && compaction.state.triggerTokens && context?.contextWindow
    ? compaction.state.triggerTokens / context.contextWindow * 100 : null;
  const card = <ContextCard context={context} status={view.status} source={view.source} demo={preview && marks} onOpenDetails={canInspect ? onOpenDetails : undefined}
    cacheControl={canInspect ? <PromptCachePanel client={client} sessionId={liveSessionId} visible={visible} /> : undefined}
    queueInstead={queueInstead} onCompact={onCompact} compactDisabled={compactDisabled} compacting={compacting} thresholdPercent={triggerPercent}
    thresholdControl={<SessionCompactionInput key={`${preview}:${sessionId}`} {...compaction} onSave={compaction.save} enabled={preview || compactionAvailable && !!sessionId} />} />;
  return render ? render(card, context) : card;
}

function ContextDockChrome({ context, children }: { context: ContextUsage | null | undefined; children: ReactNode }) {
  const { resolvedLanguage } = useI18n();
  const { preview, marks } = usePreviewMode();
  const meter = useMemo<PanelMeter>(() => {
    const percent = context?.percent ?? null;
    const zh = resolvedLanguage === "zh";
    const label = (percent === null ? zh ? "上下文用量不可用" : "Context usage unavailable" : zh ? `上下文已使用 ${Math.round(percent)}%` : `${Math.round(percent)}% context used`)
      + (preview && marks ? zh ? " · 演示" : " · Demo" : "");
    const segments = context && context.contextWindow > 0 ? contextUsageSegments(context, zh).map(part => ({
      id: part.id, percent: part.tokens / context.contextWindow * 100, color: part.color,
      label: `${part.label} ${tokens(part.tokens)} · ${(part.tokens / context.contextWindow * 100).toFixed(1)}%`,
    })) : undefined;
    return {
      percent, label,
      tone: percent !== null && percent >= 90 ? "danger" : percent !== null && percent >= 75 ? "warning" : "normal",
      ...(segments ? { segments, detail: `${label}\n${segments.map(segment => segment.label).join("\n")}` } : {}),
    };
  }, [context, resolvedLanguage, preview, marks]);
  return <><DockPanelMeter id="context" value={meter} /><DockPanel id="context">{children}</DockPanel></>;
}

/** Live usage can feed a folded header; expensive archive probes require an open body. */
export function ContextDockPanel(props: ContextSourceProps) {
  const { hosts } = useDock();
  const host = hosts.get("context");
  const visibility = useSyncExternalStore(host.subscribe, host.snapshot);
  const visible = visibility.visible;
  return <ContextDockCard {...props} visible={visible} render={(card, context) => <ContextDockChrome context={context}>{card}</ContextDockChrome>} />;
}
