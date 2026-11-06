import { Fragment, type RefObject } from "react";
import type { ContextCategoryId, ContextEntrySummary } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { compactTokens, entryTokenLabel, groupEntries } from "./contextViewMath";

/** Search, entry cards with inline previews, and the next page button. */
export function ContextEntryList({
  category,
  entries,
  total,
  childKey,
  selectedId,
  listState,
  search,
  onSearch,
  onSelect,
  onMore,
  nextOffset,
  searchRef,
}: {
  category: ContextCategoryId;
  entries: ContextEntrySummary[];
  total: number;
  childKey?: string | undefined;
  selectedId?: string | undefined;
  listState: "idle" | "loading" | "error";
  search: string;
  onSearch(value: string): void;
  onSelect(entry: ContextEntrySummary): void;
  onMore(): void;
  nextOffset?: number | undefined;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const groups = groupEntries(entries);
  const empty = !entries.length && listState !== "loading" && listState !== "error";
  return (
    <div className="cv-left-body">
      <div className="cv-search">
        <input
          ref={searchRef}
          type="search"
          className="cv-search-input"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder={t("contextViewer.list.searchPlaceholder")}
          aria-label={t("contextViewer.a11y.filter")}
          disabled={listState === "loading" && !entries.length}
        />
        <span className="cv-count">{t("contextViewer.list.count", { shown: entries.length, total })}</span>
      </div>
      {childKey && search.trim() ? <p className="cv-scope">{t("contextViewer.list.scopeAll")}</p> : null}
      <div className="cv-entries" tabIndex={0} aria-label={t("contextViewer.a11y.entries")}>
        {groups.map(group => (
          <Fragment key={`${group.key}-${group.entries[0]!.id}`}>
            {group.group ? (
              <div className="cv-group">
                <b>{group.group.label}</b>
                <span>
                  {group.group.tokens > 0 ? `${compactTokens(group.group.tokens)} tokens` : "—"}
                  {group.group.interrupted ? ` · ${t("contextViewer.entry.interrupted")}` : ""}
                </span>
              </div>
            ) : null}
            {group.entries.map(entry => {
              const meta = [entry.info, entry.path].filter(Boolean).join(" · ");
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="cv-entry"
                  data-active={entry.id === selectedId ? "" : undefined}
                  data-child={group.group ? "" : undefined}
                  aria-pressed={entry.id === selectedId}
                  onClick={() => onSelect(entry)}
                >
                  <span className="cv-entry-head">
                    <strong>{entry.label}</strong>
                    <span className="cv-entry-tokens">{entryTokenLabel(entry, zh)}</span>
                  </span>
                  {meta ? <span className="cv-entry-meta">{meta}</span> : null}
                  {entry.preview ? <span className="cv-entry-preview">{entry.preview}</span> : null}
                </button>
              );
            })}
          </Fragment>
        ))}
        {empty ? (
          <p className="cv-empty">
            {category === "skills" ? t("contextViewer.list.emptySkills") : t("contextViewer.list.empty")}
          </p>
        ) : null}
        {listState === "loading" ? <p className="cv-loading">{t("contextViewer.list.loading")}</p> : null}
      </div>
      {nextOffset === undefined ? null : (
        <button type="button" className="btn small outline cv-more" disabled={listState === "loading"} onClick={onMore}>
          {t("contextViewer.list.more")}
        </button>
      )}
    </div>
  );
}
