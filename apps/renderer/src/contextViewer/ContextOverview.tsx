import { useMemo } from "react";
import type { ContextViewIndex } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { allocateUsage, compactTokens, formatCapturedAt, meterSegments } from "./contextViewMath";

/** Top band: usage share, occupancy meter with the compaction threshold, and the facts behind the numbers. */
export function ContextOverview({ index, compact = false }: { index: ContextViewIndex; compact?: boolean }) {
  const { t, resolvedLanguage } = useI18n();
  const allocation = useMemo(() => allocateUsage(index.categories, index.usedTokens), [index]);
  const segments = useMemo(() => meterSegments(index, allocation), [index, allocation]);
  const window = index.contextWindow;
  const percent = window > 0 ? (index.usedTokens / window) * 100 : 0;
  const threshold = index.thresholdTokens;
  const thresholdShare = threshold !== null && window > 0 ? Math.min(1, threshold / window) : undefined;
  const gap = threshold === null ? undefined : threshold - index.usedTokens;
  const facts = <ul className="cv-facts">
    <li><span className="cv-fact-k">{t("contextViewer.overview.free")}</span><b>{compactTokens(index.freeTokens)}</b></li>
    <li><span className="cv-fact-k">{t("contextViewer.overview.buffer")}</span><b>{compactTokens(index.bufferTokens)}</b></li>
    <li><span className="cv-fact-k">{t("contextViewer.overview.threshold")}</span><b>{threshold === null ? t("contextViewer.overview.noThreshold") : compactTokens(threshold)}</b></li>
  </ul>;
  return (
    <section className="cv-overview">
      <div className="cv-overview-main">
        <div className="cv-used">
          <strong data-tone={percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal"}>
            {Math.round(percent)}
            <span>%</span>
          </strong>
          <div className="cv-used-meta">
            <span>{t("contextViewer.overview.used")}</span>
            <b>
              {compactTokens(index.usedTokens)} / {compactTokens(window)}
            </b>
          </div>
        </div>
        <div className="cv-meter-wrap">
          <div
            className="cv-meter"
            role="meter"
            aria-label={t("contextViewer.a11y.meter")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent * 10) / 10}
            aria-valuetext={`${t("contextViewer.overview.used")} ${index.usedTokens.toLocaleString()} / ${window.toLocaleString()} tokens · ${percent.toFixed(1)}%`}
          >
            {segments.map(segment => (
              <i
                key={segment.key}
                style={{ width: `${segment.share * 100}%`, backgroundColor: segment.color }}
                data-context-group={segment.key}
                data-striped={segment.striped ? "" : undefined}
                tabIndex={0}
                role="img"
                aria-label={`${t(`contextViewer.${segment.key === "buffer" || segment.key === "free" ? "categories" : "groups"}.${segment.key}`)} · ${segment.tokens.toLocaleString()} tokens · ${(segment.share * 100).toFixed(1)}%`}
                data-tip={`${t(`contextViewer.${segment.key === "buffer" || segment.key === "free" ? "categories" : "groups"}.${segment.key}`)} · ${segment.tokens.toLocaleString()} tokens · ${(segment.share * 100).toFixed(1)}%`}
              />
            ))}
          </div>
          {thresholdShare === undefined ? null : (
            <span
              className="cv-mark"
              style={{ left: `${thresholdShare * 100}%` }}
              title={`${t("contextViewer.overview.threshold")} ${compactTokens(threshold!)}`}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="cv-group-legend" aria-label={t("contextViewer.overview.details")}>
          {segments.filter(segment => segment.key !== "buffer" && segment.key !== "free").map(segment => <span key={segment.key}>
            <i className="cv-dot" data-context-group={segment.key} style={{ background: segment.color }} aria-hidden="true" />
            <span>{t(`contextViewer.groups.${segment.key}`)}</span><b>{compactTokens(segment.tokens)}</b>
          </span>)}
        </div>
        {!compact && facts}
      </div>
      <details className="cv-overview-details" open={!compact}>
        <summary>{t("contextViewer.overview.details")}</summary>
      {compact && facts}
      <div className="cv-overview-notes">
        <p>
          <span>{t("contextViewer.overview.model")}</span>
          <b>{index.model ? (index.model.name ?? index.model.id) : "—"}</b>
        </p>
        <p>
          <span>{t("contextViewer.overview.snapshotAt")}</span>
          <b>{formatCapturedAt(index.capturedAt, resolvedLanguage === "zh" ? "zh-CN" : "en-US")}</b>
        </p>
        {gap === undefined ? null : (
          <p>
            <span>{gap >= 0 ? t("contextViewer.overview.thresholdGap") : t("contextViewer.overview.thresholdExceeded")}</span>
            <b>{compactTokens(Math.abs(gap))}</b>
          </p>
        )}
        {index.savedTokens > 0 ? (
          <p>
            <span>{t("contextViewer.overview.saved")}</span>
            <b>{compactTokens(index.savedTokens)}</b>
          </p>
        ) : null}
        <p className="cv-note">{t("contextViewer.overview.attribution")}</p>
      </div>
      </details>
      {index.notices?.length ? <ul className="cv-notices" role="status">
        {index.notices.map((notice, position) => <li key={position}>{notice}</li>)}
      </ul> : null}
    </section>
  );
}
