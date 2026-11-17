import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { AppSelect } from "../../AppSelect";
import { Icon } from "../../icons";
import { useI18n } from "../../i18n";
import {
  chooseFetchedModelCandidate,
  pickedCount,
  setAllPicked,
  togglePicked,
  type FetchedModelCandidate,
} from "../fetchedModels";
import { fmtK } from "../modelPresentation";

type FetchFilter = "all" | "new" | "ambiguous" | "picked";

function hasCatalogChoices(item: FetchedModelCandidate): boolean {
  return (item.catalogChoices?.length ?? 0) > 0 || item.adaptation?.status === "ambiguous";
}

export function FetchedModelsPanel({
  providerId,
  editExisting,
  fetchDetail,
  candidates,
  setCandidates,
  onImport,
  onClose,
}: {
  providerId: string;
  editExisting: boolean;
  fetchDetail: { ok: boolean; text: string } | null;
  candidates: ReadonlyArray<FetchedModelCandidate>;
  setCandidates: Dispatch<SetStateAction<FetchedModelCandidate[] | null>>;
  onImport: (picked: ReadonlyArray<FetchedModelCandidate>) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FetchFilter>("all");

  const prefix = providerId.trim() || "provider";
  const totalPicked = pickedCount(candidates);
  const newCount = useMemo(() => candidates.filter((item) => !item.existing).length, [candidates]);
  const existingCount = candidates.length - newCount;
  const choiceCount = useMemo(() => candidates.filter(hasCatalogChoices).length, [candidates]);
  const unresolvedCount = useMemo(
    () => candidates.filter((item) => item.adaptation?.status === "ambiguous").length,
    [candidates],
  );

  const showNewFilter = existingCount > 0 && newCount > 0;
  const effectiveFilter: FetchFilter =
    (filter === "new" && !showNewFilter) || (filter === "ambiguous" && choiceCount === 0)
      ? "all"
      : filter;

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    return candidates.filter((item) => {
      if (effectiveFilter === "new" && item.existing) return false;
      if (effectiveFilter === "ambiguous" && !hasCatalogChoices(item)) return false;
      if (effectiveFilter === "picked" && !item.picked) return false;
      if (!needle) return true;
      const haystack = `${item.name} ${item.id} ${prefix}/${item.id}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [candidates, effectiveFilter, needle, prefix]);

  const visiblePickedCount = useMemo(() => pickedCount(visible), [visible]);
  const isFiltered = effectiveFilter !== "all" || needle.length > 0;

  const setBatchPicked = (picked: boolean) => {
    if (!isFiltered) {
      setCandidates(setAllPicked(candidates, picked));
      return;
    }
    const visibleIds = new Set(visible.map((item) => item.id));
    setCandidates((current) =>
      current
        ? current.map((item) => (visibleIds.has(item.id) ? { ...item, picked } : item))
        : null,
    );
  };

  const failed = fetchDetail?.ok === false;

  return (
    <div className="mc-fetch-panel">
      <div className={`mc-fetch-head ${failed ? "is-fail" : "is-ok"}`} role="status">
        <span className="mc-fetch-status-icon" aria-hidden="true">
          <Icon name={failed ? "alert" : "check"} extra="sm" />
        </span>
        <div className="mc-fetch-head-copy">
          <b>{failed ? t("modelConfig.fetchFailed") : t("modelConfig.selectModelsToAdd")}</b>
          {fetchDetail?.text ? <span className="mono">{fetchDetail.text}</span> : null}
        </div>
        {candidates.length > 0 ? (
          <span className={`mc-fetch-counter${totalPicked > 0 ? " is-active" : ""}`}>
            {t("modelConfig.fetchSelectedSummary", { picked: totalPicked, total: candidates.length })}
          </span>
        ) : null}
      </div>

      {candidates.length > 0 ? (
        <div className="mc-fetch-toolbar" role="toolbar" aria-label={t("modelConfig.selectModelsToAdd")}>
          <div className="mc-fetch-search">
            <Icon name="search" extra="sm" />
            <input
              type="search"
              value={query}
              aria-label={t("modelConfig.fetchFilterSearchPlaceholder")}
              placeholder={t("modelConfig.fetchFilterSearchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="mc-fetch-search-clear"
                aria-label={t("modelConfig.fetchFilterClearSearch")}
                onClick={() => setQuery("")}
              >
                <Icon name="x" extra="sm" />
              </button>
            ) : null}
          </div>

          {candidates.length > 1 ? (
            <div className="seg mc-fetch-filters">
              <button
                type="button"
                className={effectiveFilter === "all" ? "active" : undefined}
                aria-pressed={effectiveFilter === "all"}
                onClick={() => setFilter("all")}
              >
                {t("modelConfig.fetchFilterAll")}
                <span className="mc-filter-count">{candidates.length}</span>
              </button>
              {showNewFilter ? (
                <button
                  type="button"
                  className={effectiveFilter === "new" ? "active" : undefined}
                  aria-pressed={effectiveFilter === "new"}
                  onClick={() => setFilter("new")}
                >
                  {t("modelConfig.fetchFilterNew")}
                  <span className="mc-filter-count">{newCount}</span>
                </button>
              ) : null}
              {choiceCount > 0 ? (
                <button
                  type="button"
                  className={effectiveFilter === "ambiguous" ? "active" : undefined}
                  aria-pressed={effectiveFilter === "ambiguous"}
                  onClick={() => setFilter("ambiguous")}
                >
                  {t("modelConfig.fetchFilterAmbiguous")}
                  <span className={`mc-filter-count${unresolvedCount > 0 ? " is-warn" : ""}`}>
                    {unresolvedCount > 0 ? unresolvedCount : choiceCount}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className={effectiveFilter === "picked" ? "active" : undefined}
                aria-pressed={effectiveFilter === "picked"}
                onClick={() => setFilter("picked")}
              >
                {t("modelConfig.fetchFilterPicked")}
                <span className="mc-filter-count">{totalPicked}</span>
              </button>
            </div>
          ) : null}

          <div className="mc-fetch-batch">
            <button
              type="button"
              className="btn small mc-batch-btn"
              disabled={visible.length === 0 || visiblePickedCount === visible.length}
              onClick={() => setBatchPicked(true)}
            >
              <Icon name="check" extra="sm" />
              {t("modelConfig.selectAll")}
            </button>
            <button
              type="button"
              className="btn small mc-batch-btn"
              disabled={visiblePickedCount === 0}
              onClick={() => setBatchPicked(false)}
            >
              <Icon name="x" extra="sm" />
              {t("modelConfig.deselectAll")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mc-fetch-list">
        {candidates.length === 0 ? (
          <div className="pm-empty">
            <Icon name="box" extra="sm" />
            {t("modelConfig.endpointNoModels")}
          </div>
        ) : visible.length === 0 ? (
          <div className="pm-empty">
            <Icon name="search" extra="sm" />
            {t("modelConfig.fetchNoFilterMatches")}
          </div>
        ) : (
          visible.map((item) => {
            const choices =
              item.catalogChoices ??
              (item.adaptation?.status === "ambiguous" ? item.adaptation.candidates : undefined);
            const isAmbiguous = item.adaptation?.status === "ambiguous";
            const sources = [
              ...new Set(Object.values(item.parameterSources ?? {}).map((origin) => origin.source)),
            ];

            return (
              <div
                className={`mc-fetch-row${item.picked ? " is-picked" : ""}${item.existing ? " is-existing" : ""}${isAmbiguous ? " is-ambiguous" : ""}`}
                key={item.id}
              >
                <label className="mc-fetch-main">
                  <input
                    type="checkbox"
                    className="mc-fetch-checkbox"
                    aria-label={item.name}
                    checked={item.picked}
                    onChange={() => setCandidates(togglePicked(candidates, item.id))}
                  />
                  <span className={`mc-fetch-check${item.picked ? " on" : ""}`} aria-hidden="true">
                    {item.picked ? <Icon name="check" extra="sm" /> : null}
                  </span>
                  <span className="mc-fetch-identity">
                    <span className="mc-fetch-title-line">
                      <span className="pm-name">{item.name}</span>
                      {item.existing ? (
                        <span className="chip gray xs">{t("modelConfig.alreadyExists")}</span>
                      ) : null}
                    </span>
                    <span className="pm-sel ellipsis">{`${prefix}/${item.id}`}</span>
                  </span>
                  <span className="mc-fetch-caps">
                    {item.contextWindow ? (
                      <span className="chip gray xs mc-cap-num">{fmtK(item.contextWindow)} ctx</span>
                    ) : null}
                    {item.maxTokens ? (
                      <span className="chip gray xs mc-cap-num">{fmtK(item.maxTokens)} out</span>
                    ) : null}
                    {item.image ? (
                      <span className="chip blue xs chip-icon" data-tip={t("modelConfig.badgeImage")}>
                        <Icon name="image" extra="sm" />
                      </span>
                    ) : null}
                    {item.reasoning ? (
                      <span
                        className="chip purple xs chip-icon"
                        data-tip={t("modelConfig.badgeReasoning")}
                      >
                        <Icon name="brain" extra="sm" />
                      </span>
                    ) : null}
                    {sources.map((source) => (
                      <span key={source} className={`chip xs mc-source-chip is-${source}`}>
                        {t(`modelAdaptation.source.${source}`)}
                      </span>
                    ))}
                  </span>
                </label>

                {choices && choices.length > 0 ? (
                  <div className={`mc-fetch-adapt ${isAmbiguous ? "is-pending" : "is-resolved"}`}>
                    <div className="mc-fetch-adapt-info">
                      <span className={`chip xs ${isAmbiguous ? "amber" : "purple"}`}>
                        <Icon name={isAmbiguous ? "layers" : "check"} extra="sm" />
                        {isAmbiguous
                          ? t("modelAdaptation.ambiguousBadge")
                          : t("modelAdaptation.matched")}
                      </span>
                      <span className="mc-fetch-adapt-text">
                        {isAmbiguous
                          ? t("modelConfig.fetchAmbiguousHint", { count: choices.length })
                          : t("modelConfig.fetchMatchedHint")}
                      </span>
                    </div>
                    <AppSelect
                      aria-label={`${t("modelAdaptation.chooseModel")} · ${item.id}`}
                      className="mc-fetch-adapt-select"
                      value={item.selectedCatalogKey ?? ""}
                      onChange={(event) => {
                        const selected = choices.find(
                          (candidate) => candidate.key === event.target.value,
                        );
                        setCandidates(
                          (current) =>
                            current?.map((candidate) =>
                              candidate.id === item.id
                                ? chooseFetchedModelCandidate(candidate, selected)
                                : candidate,
                            ) ?? null,
                        );
                      }}
                    >
                      <option value="">{t("modelAdaptation.chooseModel")}</option>
                      {choices.map((candidate) => {
                        const specs = [
                          candidate.values.contextWindow
                            ? `${fmtK(candidate.values.contextWindow)} ctx`
                            : "",
                          candidate.values.maxTokens
                            ? `${fmtK(candidate.values.maxTokens)} out`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <option key={candidate.key} value={candidate.key}>
                            {`${candidate.provider} / ${candidate.id}${specs ? ` (${specs})` : ""}`}
                          </option>
                        );
                      })}
                    </AppSelect>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="mc-fetch-foot">
        <p className="mc-fetch-notice">
          {t("modelConfig.importDraftNotice", {
            action: editExisting ? t("modelConfig.saveChanges") : t("modelConfig.addProvider"),
          })}
        </p>
        <div className="mc-fetch-actions">
          <button type="button" className="btn small outline" onClick={onClose}>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn small primary"
            disabled={totalPicked === 0}
            onClick={() => onImport(candidates.filter((item) => item.picked))}
          >
            <Icon name="plus" extra="sm" />
            {t("modelConfig.importModelsCount", { count: totalPicked })}
          </button>
        </div>
      </div>
    </div>
  );
}
