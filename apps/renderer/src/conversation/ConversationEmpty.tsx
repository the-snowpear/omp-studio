import { useEffect, useMemo, useState } from "react";
import type { SessionHistoryEntry, SessionHistoryReadModel, StudioClient, TokenUsageReadModel } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useOperatorProfile } from "../settings/operatorProfile";
import { ensureRuntimeConnection } from "../runtimeEnsure";
import { ActionProgressBar, type ActionProgress } from "../ActionProgressBar";
import {
  EMPTY_USAGE,
  USAGE_POLL_MS,
  buildPreviewUsage,
  fmtTokens,
  totalsByDayFromUsage,
} from "../usage/tokenUsage";
import { buildActivityHeatmap, heatCellTip } from "./activityHeatmap";
import { collectHistoryRecents, collectPreviewRecents, type EmptyRecentRow } from "./emptyRecents";

export function greetingPart(now = new Date(), lang: "zh" | "en" = "zh"): string {
  const hour = now.getHours();
  if (hour < 5) return lang === "en" ? "Good late night" : "夜深了";
  if (hour < 11) return lang === "en" ? "Good morning" : "上午好";
  if (hour < 13) return lang === "en" ? "Good day" : "中午好";
  if (hour < 18) return lang === "en" ? "Good afternoon" : "下午好";
  return lang === "en" ? "Good evening" : "晚上好";
}

export function ConversationEmpty({
  client,
  history,
  projectName,
  runningSessionId,
  waitingSessionId,
  hiddenPreviewThreadIds,
  onSelectThread,
  onSelectPreviewThread,
  onOpenHistory,
  runtimeConnected = true,
  onOpenDiagnostics,
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
  /** Real-mode subtitle: do not claim Runtime is ready when it is not. */
  runtimeConnected?: boolean;
  onOpenDiagnostics?: () => void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const effectiveProjectName = projectName ?? t("conversation.noProjectSelected");
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
            unavailableReason: resolvedLanguage === "en" ? "Failed to load usage." : "用量读取失败。",
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
  }, [preview, client, resolvedLanguage]);

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
    () => buildActivityHeatmap(totalsByDayFromUsage(usage), Date.now(), resolvedLanguage),
    [usage, resolvedLanguage],
  );
  const recents = useMemo((): EmptyRecentRow[] => {
    if (preview) return collectPreviewRecents(hiddenPreviewThreadIds ?? new Set(), resolvedLanguage);
    const entries = (history ?? fetchedHistory)?.entries ?? [];
    return collectHistoryRecents({
      entries,
      projectName: effectiveProjectName,
      ...(runningSessionId === undefined ? {} : { runningSessionId }),
      ...(waitingSessionId === undefined ? {} : { waitingSessionId }),
      lang: resolvedLanguage,
    });
  }, [effectiveProjectName, fetchedHistory, hiddenPreviewThreadIds, history, resolvedLanguage, preview, runningSessionId, waitingSessionId]);

  const greet = `${greetingPart(new Date(), resolvedLanguage)}，${profile.displayName}`;
  const usageReason = !preview && liveUsage?.unavailableReason ? liveUsage.unavailableReason : undefined;
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);
  const [reconnectProgress, setReconnectProgress] = useState<ActionProgress | null>(null);

  const reconnect = async () => {
    if (preview || client === undefined) return;
    setReconnectBusy(true);
    setReconnectNotice(null);
    setReconnectProgress({ label: t("conversation.reconnectingRuntime"), step: 1, steps: 2 });
    const result = await ensureRuntimeConnection(client, {}, setReconnectProgress);
    setReconnectNotice(result.ok ? t("conversation.reconnectedRuntime") : result.message);
    setReconnectBusy(false);
    setReconnectProgress(null);
  };

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
          {preview
            ? t("home.previewSubtitle")
            : runtimeConnected
              ? t("home.readySubtitle")
              : t("home.disconnectedSubtitle")}
        </p>
        {!preview && !runtimeConnected ? (
          <div className="ce-runtime-actions ce-anim" style={{ ["--d" as string]: "680ms" }}>
            {client !== undefined ? (
              <button type="button" className="btn primary" disabled={reconnectBusy} onClick={() => void reconnect()}>
                {reconnectBusy ? t("common.loading") : t("conversation.reconnectRuntime")}
              </button>
            ) : null}
            {onOpenDiagnostics ? (
              <button type="button" className="btn outline" onClick={onOpenDiagnostics}>{t("conversation.diagnostics")}</button>
            ) : null}
            {reconnectNotice ? <span className="tiny muted">{reconnectNotice}</span> : null}
            {reconnectProgress !== null ? (
              <ActionProgressBar compact label={reconnectProgress.label} step={reconnectProgress.step} steps={reconnectProgress.steps} />
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="ce-heat" aria-labelledby="ceHeatH">
        <div className="ce-heat-head ce-anim" style={{ ["--d" as string]: "700ms" }}>
          <h2 id="ceHeatH"><span className="ce-heat-pi" aria-hidden="true">π</span>{t("home.activityHeatmap")}{preview ? <span className="chip purple xs">{t("common.demo")}</span> : null}</h2>
          <span className="ce-heat-stats">
            {usageReason
              ? usageReason
              : <>{t("home.thisYear")} · <b>{fmtTokens(heatmap.tokens)}</b> tok · <b>{heatmap.activeDays}</b> {t("home.activeDays")}</>}
          </span>
        </div>
        <div className="ce-heat-board" style={{ ["--ce-weeks" as string]: String(heatmap.weeks) }}>
          <div className="ce-heat-months" aria-hidden="true">
            {heatmap.months.map((month) => (
              <span key={`${month.week}-${month.label}`} style={{ ["--mw" as string]: String(month.week) }}>{month.label}</span>
            ))}
          </div>
          <div className="ce-heat-days" aria-hidden="true">
            <span style={{ gridRowStart: 1 }}>{resolvedLanguage === "en" ? "Mon" : "一"}</span>
            <span style={{ gridRowStart: 3 }}>{resolvedLanguage === "en" ? "Wed" : "三"}</span>
            <span style={{ gridRowStart: 5 }}>{resolvedLanguage === "en" ? "Fri" : "五"}</span>
          </div>
          <div className="ce-heat-cells">
            {heatmap.cells.map((cell) => (
              <span
                key={cell.ts}
                className={cell.future || cell.pad ? "ce-hc is-future" : "ce-hc"}
                data-l={cell.level}
                data-tip={heatCellTip(cell, resolvedLanguage)}
                style={{ ["--cw" as string]: cell.week, ["--cd" as string]: cell.dow }}
              />
            ))}
          </div>
          <div className="ce-heat-legend" aria-hidden="true">
            {t("home.less")}{[0, 1, 2, 3, 4].map((level) => <i key={level} data-l={level} />)}{t("home.more")}
          </div>
        </div>
      </section>

      <section className="ce-recent ce-anim" style={{ ["--d" as string]: "820ms" }} aria-labelledby="ceRecentH">
        <div className="ce-recent-head">
          <h2 id="ceRecentH">{t("conversation.recentConversations")}</h2>
          <button type="button" className="ce-history" onClick={onOpenHistory}>
            <Icon name="history" extra="sm" />{t("conversation.allHistory")}
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
                aria-label={`${t("conversation.continueConversation", { title: row.title })} (${row.statusLabel}, ${row.time})`}
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
            <div className="ce-recent-empty">{t("conversation.noRecentConversations")}</div>
          )}
        </div>
      </section>

      <div className="ce-tips ce-anim" style={{ ["--d" as string]: "880ms" }}>
        <span className="ce-tip"><span className="kbd">Ctrl ⇧ O</span>{t("conversation.tipNewChat")}</span>
        <span className="ce-tip"><span className="kbd">Ctrl K</span>{t("conversation.tipSearch")}</span>
        <span className="ce-tip"><span className="kbd">/</span>{t("conversation.tipCommands")}</span>
        <span className="ce-tip"><span className="kbd">@</span>{t("conversation.tipContext")}</span>
      </div>
    </div>
  );
}
