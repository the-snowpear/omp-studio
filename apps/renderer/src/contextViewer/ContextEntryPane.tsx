import type { ContextEntrySummary } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { compactTokens, entryTokenLabel, formatEntryTime } from "./contextViewMath";

/** Right column: entry header, metadata rows, and the paged body. */
export function ContextEntryPane({
  entry,
  body,
  totalChars,
  nextBody,
  entryTruncated,
  bodyState,
  onMore,
  hidden = false,
  onBack,
}: {
  entry?: ContextEntrySummary | undefined;
  body: string;
  totalChars: number;
  nextBody?: number | undefined;
  entryTruncated: boolean;
  bodyState: "idle" | "loading" | "error";
  onMore(): void;
  hidden?: boolean;
  onBack?: (() => void) | undefined;
}) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  if (!entry)
    return (
      <section className="cv-right" hidden={hidden} aria-label={t("contextViewer.a11y.content")}>
        <div className="cv-empty-pane">
          <p>{t("contextViewer.entry.placeholder")}</p>
          <p className="cv-note">{t("contextViewer.entry.placeholderHint")}</p>
        </div>
      </section>
    );
  const group = entry.thinkingGroup;
  return (
    <section className="cv-right" hidden={hidden} aria-label={t("contextViewer.a11y.content")}>
      <header className="cv-entry-bar">
        {onBack ? <button type="button" className="icon-btn small cv-back" aria-label={t("contextViewer.back")} data-tip={t("contextViewer.back")} onClick={onBack}><Icon name="chevron-l" /></button> : null}
        <h3>{entry.label}</h3>
        <div className="cv-chips">
          {group ? (
            <span className="chip purple xs">
              {t("contextViewer.entry.groupChip", { tokens: `${compactTokens(group.tokens)} tokens` })}
            </span>
          ) : (
            <span className="chip gray xs">{entryTokenLabel(entry, zh)}</span>
          )}
          {entry.interrupted ? <span className="chip amber xs">{t("contextViewer.entry.interrupted")}</span> : null}
          {entryTruncated ? <span className="chip amber xs">{t("contextViewer.entry.truncated")}</span> : null}
        </div>
      </header>
      <dl className="cv-meta">
        {entry.path ? (
          <div>
            <dt>{t("contextViewer.entry.path")}</dt>
            <dd>{entry.path}</dd>
          </div>
        ) : null}
        {entry.info ? (
          <div>
            <dt>{t("contextViewer.entry.source")}</dt>
            <dd>{entry.info}</dd>
          </div>
        ) : null}
        {entry.callId ? (
          <div>
            <dt>{t("contextViewer.entry.callId")}</dt>
            <dd>
              <code>{entry.callId}</code>
            </dd>
          </div>
        ) : null}
        {entry.timestamp === undefined ? null : (
          <div>
            <dt>{t("contextViewer.entry.time")}</dt>
            <dd>{formatEntryTime(entry.timestamp, zh ? "zh-CN" : "en-US")}</dd>
          </div>
        )}
      </dl>
      {group ? <p className="cv-note cv-shared">{t("contextViewer.entry.sharedGroup")}</p> : null}
      <pre className="cv-body-scroll" tabIndex={0}>
        {body}
      </pre>
      <footer className="cv-entry-foot">
        <span>
          {t("contextViewer.entry.progress", {
            shown: body.length.toLocaleString(),
            total: totalChars.toLocaleString(),
          })}
        </span>
        {bodyState === "loading" ? <span className="cv-loading">{t("contextViewer.list.loading")}</span> : null}
        {nextBody === undefined ? null : (
          <button type="button" className="btn small outline" disabled={bodyState === "loading"} onClick={onMore}>
            {t("contextViewer.entry.loadMore")}
          </button>
        )}
      </footer>
    </section>
  );
}
