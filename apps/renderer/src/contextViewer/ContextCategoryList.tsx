import { useMemo } from "react";
import type { ContextCategoryId, ContextViewIndex } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { allocateUsage, CATEGORY_TINT, compactTokens, formatShare } from "./contextViewMath";

interface Row {
  key: string;
  label: string;
  tokens: number;
  color: string;
  categoryId: ContextCategoryId;
  childKey?: string;
  selectable: boolean;
  child?: boolean;
  note?: string;
}

/**
 * Legend doubling as the category picker: every row carries a label, a count and a share,
 * never colour alone. Buffer and free space live in the overview facts, not here.
 */
export function ContextCategoryList({
  index,
  category,
  childKey,
  onSelect,
}: {
  index: ContextViewIndex;
  category: ContextCategoryId;
  childKey?: string | undefined;
  onSelect(category: ContextCategoryId, childKey?: string): void;
}) {
  const { t } = useI18n();
  const allocation = useMemo(() => allocateUsage(index.categories, index.usedTokens), [index]);
  const rows = useMemo(() => {
    const built: Row[] = [];
    for (const item of index.categories) {
      built.push({
        key: item.id,
        label: t(`contextViewer.categories.${item.id}`),
        tokens: allocation?.get(item.id) ?? item.tokens,
        color: CATEGORY_TINT[item.id],
        categoryId: item.id,
        // Skills has weight but no body; it stays clickable so the list can explain that.
        selectable: item.entries > 0 || item.openable === false,
        ...(item.openable === false ? { note: t("contextViewer.categories.weightOnly") } : {}),
      });
      for (const child of item.children ?? []) {
        // Groups only unfold under their selected parent, so the legend keeps a stable height.
        if (!child.key || item.id !== category) continue;
        built.push({
          key: child.key,
          label: child.label,
          tokens: allocation?.get(child.key) ?? child.tokens,
          color: "var(--text-faint)",
          categoryId: item.id,
          childKey: child.key,
          selectable: child.entries > 0,
          child: true,
        });
      }
    }
    return built;
  }, [index, allocation, t, category]);

  return (
    <ul className="cv-cats" aria-label={t("contextViewer.a11y.categories")}>
      {rows.map(row => {
        const active = row.categoryId === category && row.childKey === childKey;
        // Keep the parent outlined while one of its groups is the actual selection.
        const parentActive = !active && !row.childKey && row.categoryId === category && childKey !== undefined;
        return (
          <li key={row.key} data-child={row.child ? "" : undefined}>
            <button
              type="button"
              className="cv-cat"
              data-active={active ? "" : undefined}
              data-parent={parentActive ? "" : undefined}
              aria-pressed={active}
              title={row.note}
              disabled={!row.selectable}
              onClick={() => onSelect(row.categoryId, row.childKey)}
            >
              <i className="cv-dot" style={{ background: row.color }} aria-hidden="true" />
              <span className="cv-cat-label">{row.label}</span>
              <b className="cv-cat-tokens">{compactTokens(row.tokens)}</b>
              <span className="cv-cat-share">{formatShare(row.tokens, index.contextWindow)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
