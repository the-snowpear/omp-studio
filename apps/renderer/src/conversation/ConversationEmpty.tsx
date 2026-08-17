import { useEffect, useMemo, useState } from "react";
import type { SessionHistoryEntry, SessionHistoryReadModel, StudioClient, TokenUsageReadModel } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { useOperatorProfile } from "../settings/operatorProfile";
import {
  EMPTY_USAGE,
  USAGE_POLL_MS,
  buildPreviewUsage,
  fmtTokens,
  totalsByDayFromUsage,
} from "../usage/tokenUsage";
import { buildActivityHeatmap, heatCellTip } from "./activityHeatmap";
import { collectHistoryRecents, collectPreviewRecents, type EmptyRecentRow } from "./emptyRecents";

export function greetingPart(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "上午好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function ConversationEmpty({
  client,
  history,
  projectName = "未选择项目",
  runningSessionId,
  waitingSessionId,
  hiddenPreviewThreadIds,
  onSelectThread,
  onSelectPreviewThread,
  onOpenHistory,
}: {
  client?: StudioClient;
  history?: SessionHistoryReadModel;
  projectName?: string;
  runningSessionId?: string;
  waitingSessionId?: string;
  hiddenPreviewThreadIds?: ReadonlySet<string>;
  onSelectThread?: (entry: SessionHistoryEntry) => void;
  onSelectPreviewThread?: (threadId: string) => void;
  onOpenHistory: () => void;
}) {
  const { preview } = usePreviewMode();
  const { profile } = useOperatorProfile();
  const previewUsage = useMemo(() => buildPreviewUsage(), []);
  const [liveUsage, setLiveUsage] = useState<TokenUsageReadModel | null>(null);
  const [fetchedHistory, setFetchedHistory] = useState<SessionHistoryReadModel | undefined>(undefined);

  useEffect(() => {
    if (preview || !client) {
      setLiveUsage(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await client.query("usage.get", {});
        if (!cancelled) setLiveUsage(next);
      } catch {
        if (!cancelled) {
          setLiveUsage({
            ...EMPTY_USAGE,
            generatedAt: new Date().toISOString(),
            unavailableReason: "用量读取失败。",
          });
        }
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, USAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [preview, client]);

  useEffect(() => {
    if (preview || !client || history !== undefined) {
      setFetchedHistory(undefined);
      return;
    }
    let cancelled = false;
    void client.query("history.list", { limit: 20, status: "active" }).then(
      (next) => { if (!cancelled) setFetchedHistory(next); },
      () => { if (!cancelled) setFetchedHistory({ entries: [], total: 0 }); },
    );
    return () => { cancelled = true; };
  }, [preview, client, history]);

  const usage = preview ? previewUsage : (liveUsage ?? EMPTY_USAGE);
  const heatmap = useMemo(
    () => buildActivityHeatmap(totalsByDayFromUsage(usage)),
    [usage],
  );
  const recents = useMemo((): EmptyRecentRow[] => {
    if (preview) return collectPreviewRecents(hiddenPreviewThreadIds ?? new Set());
    const entries = (history ?? fetchedHistory)?.entries ?? [];
    return collectHistoryRecents({
      entries,
      projectName,
      ...(runningSessionId === undefined ? {} : { runningSessionId }),
      ...(waitingSessionId === undefined ? {} : { waitingSessionId }),
    });
  }, [fetchedHistory, hiddenPreviewThreadIds, history, preview, projectName, runningSessionId, waitingSessionId]);

  const greet = `${greetingPart()}，${profile.displayName}`;
  const usageReason = !preview && liveUsage?.unavailableReason ? liveUsage.unavailableReason : undefined;

  return (
    <div className="convo-empty" role="region" aria-labelledby="ceGreet">
      <div className="ce-hero">
        <svg className="ce-pi ce-anim" style={{ ["--d" as string]: "0ms" }} viewBox="0 0 321 309" aria-hidden="true">
          <defs>
            <linearGradient id="piStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#a78bf0" stopOpacity=".95" />
              <stop offset=".5" stopColor="#a78bf0" stopOpacity=".75" />
              <stop offset="1" stopColor="#a78bf0" stopOpacity=".55" />
            </linearGradient>
          </defs>
          <path className="ce-pi-glyph" d="M20 20 H301 V79 H231 V289 H173 V79 H116 V219 H58 V79 H20 Z" />
        </svg>
        <h1 className="ce-greet ce-anim" style={{ ["--d" as string]: "500ms" }} id="ceGreet">{greet}</h1>
        <p className="ce-sub ce-anim" style={{ ["--d" as string]: "620ms" }}>
          {preview ? "预览模式 · 演示数据。开始一个新任务，或继续最近的对话。" : "OMP 已就绪。开始一个新任务，或继续最近的对话。"}
        </p>
      </div>

      <section className="ce-heat" aria-labelledby="ceHeatH">
        <div className="ce-heat-head ce-anim" style={{ ["--d" as string]: "700ms" }}>
          <h2 id="ceHeatH"><span className="ce-heat-pi" aria-hidden="true">π</span>活动轨迹{preview ? <span className="chip purple xs">演示</span> : null}</h2>
          <span className="ce-heat-stats">
            {usageReason
              ? usageReason
              : <>近 1 年 · <b>{fmtTokens(heatmap.tokens)}</b> tok · <b>{heatmap.activeDays}</b> 活跃天</>}
          </span>
        </div>
        <div className="ce-heat-board" style={{ ["--ce-weeks" as string]: String(heatmap.weeks) }}>
          <div className="ce-heat-months" aria-hidden="true">
            {heatmap.months.map((month) => (
              <span key={`${month.week}-${month.label}`} style={{ ["--mw" as string]: String(month.week) }}>{month.label}</span>
            ))}
          </div>
          <div className="ce-heat-days" aria-hidden="true">
            <span style={{ gridRowStart: 1 }}>一</span>
            <span style={{ gridRowStart: 3 }}>三</span>
            <span style={{ gridRowStart: 5 }}>五</span>
          </div>
          <div className="ce-heat-cells">
            {heatmap.cells.map((cell) => (
              <span
                key={cell.ts}
                className={cell.future || cell.pad ? "ce-hc is-future" : "ce-hc"}
                data-l={cell.level}
                data-tip={heatCellTip(cell)}
                style={{ ["--cw" as string]: cell.week, ["--cd" as string]: cell.dow }}
              />
            ))}
          </div>
          <div className="ce-heat-legend" aria-hidden="true">
            少{[0, 1, 2, 3, 4].map((level) => <i key={level} data-l={level} />)}多
          </div>
        </div>
      </section>

      <section className="ce-recent ce-anim" style={{ ["--d" as string]: "820ms" }} aria-labelledby="ceRecentH">
        <div className="ce-recent-head">
          <h2 id="ceRecentH">最近对话</h2>
          <button type="button" className="ce-history" onClick={onOpenHistory}>
            <Icon name="history" extra="sm" />全部历史
          </button>
        </div>
        <div className="ce-rows">
          {recents.length ? recents.map((row) => {
            const dot = row.status === "running" ? "green pulse" : row.status === "approval" ? "amber" : "gray";
            return (
              <button
                key={row.id}
                type="button"
                className="ce-row"
                aria-label={`继续对话：${row.title}（${row.statusLabel}，${row.time}）`}
                onClick={() => {
                  if (preview) {
                    if (row.previewThreadId) onSelectPreviewThread?.(row.previewThreadId);
                    return;
                  }
                  if (row.entry) onSelectThread?.(row.entry);
                }}
              >
                <span className={`dot ${dot}`} aria-hidden="true" />
                <span className="ce-row-title">{row.title}</span>
                <span className="ce-row-meta">
                  <span className="ce-meta-proj">{row.project}</span>
                  <span className="ce-meta-sep" aria-hidden="true" />
                  {row.time}
                </span>
              </button>
            );
          }) : (
            <div className="ce-recent-empty">暂无最近对话</div>
          )}
        </div>
      </section>

      <div className="ce-tips ce-anim" style={{ ["--d" as string]: "880ms" }}>
        <span className="ce-tip"><span className="kbd">Ctrl ⇧ O</span>新建对话</span>
        <span className="ce-tip"><span className="kbd">Ctrl K</span>统一搜索</span>
        <span className="ce-tip"><span className="kbd">/</span>命令</span>
        <span className="ce-tip"><span className="kbd">@</span>引用上下文</span>
      </div>
    </div>
  );
}
