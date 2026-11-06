import type {
  ContextCategoryId,
  ContextCategorySummary,
  ContextEntrySummary,
  ContextThinkingGroupSummary,
  ContextViewIndex,
} from "@omp-studio/studio-protocol";

/** Category tint for dots and meter segments; never used for text. */
export const CATEGORY_TINT: Record<ContextCategoryId, string> = {
  "system-prompt": "var(--tint-indigo)",
  skills: "var(--tint-teal)",
  "built-in-tools": "var(--tint-orange)",
  "custom-tools": "var(--tint-violet)",
  "user-messages": "var(--tint-blue)",
  "assistant-messages": "var(--tint-cyan)",
  "assistant-thinking": "var(--tint-pink)",
  "tool-calls": "var(--tint-rose)",
  "tool-output": "var(--tint-lime)",
};
export const FREE_TINT = "var(--surface-active)";
export const BUFFER_TINT = "var(--border-strong)";

export interface MeterSegment {
  key: string;
  tokens: number;
  /** Fraction of the context window. */
  share: number;
  color: string;
  striped?: boolean;
}

export interface EntryGroup {
  key: string;
  group?: ContextThinkingGroupSummary;
  entries: ContextEntrySummary[];
}

/** 1.2M / 12.3k / 987 — the same abbreviation the context card uses. */
export function compactTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return value.toLocaleString();
}

/** Share of the window as a percentage string; never colour-only, always rendered next to the count. */
export function formatShare(tokens: number, window: number): string {
  if (!Number.isFinite(tokens) || !(window > 0)) return "—";
  const percent = (tokens / window) * 100;
  return percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** Largest-remainder split of `total` by `weights`, so the parts always add back to the total. */
export function allocateTokens(weights: readonly number[], total: number): number[] | undefined {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) return undefined;
  const shares = weights.map((weight, index) => {
    const exact = (total * weight) / sum;
    return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = total - shares.reduce((value, share) => value + share.tokens, 0);
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < ranked.length && remaining > 0; index++, remaining--) ranked[index]!.tokens++;
  return shares.map(share => share.tokens);
}

/** Attribute reported usage to categories (and to tool-output groups) by weight. */
export function allocateUsage(
  categories: readonly ContextCategorySummary[],
  used: number,
): Map<string, number> | undefined {
  const allocation = new Map<string, number>();
  const allocate = (siblings: readonly ContextCategorySummary[], total: number): boolean => {
    const shares = allocateTokens(
      siblings.map(category => category.tokens),
      total,
    );
    if (!shares) return false;
    for (const [index, category] of siblings.entries()) {
      allocation.set(category.key ?? category.id, shares[index]!);
      if (category.children?.length) allocate(category.children, shares[index]!);
    }
    return true;
  };
  return allocate(categories, used) ? allocation : undefined;
}

/** Segments of the occupancy meter: used categories, then the auto-compact buffer, then free space. */
export function meterSegments(
  index: ContextViewIndex,
  allocation: ReadonlyMap<string, number> | undefined,
): MeterSegment[] {
  const window = index.contextWindow;
  if (!(window > 0)) return [];
  const segments: MeterSegment[] = [];
  for (const category of index.categories) {
    const tokens = allocation?.get(category.key ?? category.id) ?? category.tokens;
    if (tokens > 0) segments.push({ key: category.id, tokens, share: tokens / window, color: CATEGORY_TINT[category.id] });
  }
  if (index.bufferTokens > 0)
    segments.push({
      key: "buffer",
      tokens: index.bufferTokens,
      share: index.bufferTokens / window,
      color: BUFFER_TINT,
      striped: true,
    });
  if (index.freeTokens > 0)
    segments.push({ key: "free", tokens: index.freeTokens, share: index.freeTokens / window, color: FREE_TINT });
  return segments;
}

/** Token label of an entry. Group members share their group's weight, so they never show `0 tokens`. */
export function entryTokenLabel(entry: ContextEntrySummary, zh: boolean): string {
  if (entry.thinkingGroup) return "—";
  if (entry.interrupted) return zh ? "N/A · 已中断" : "N/A · Interrupted";
  return `${entry.tokens.toLocaleString()} ${entry.tokens === 1 ? "token" : "tokens"}`;
}

/** Consecutive entries of one thinking group share a heading; a page break simply repeats it. */
export function groupEntries(entries: readonly ContextEntrySummary[]): EntryGroup[] {
  const groups: EntryGroup[] = [];
  for (const entry of entries) {
    const group = entry.thinkingGroup;
    const last = groups.at(-1);
    if (group && last?.group?.id === group.id) last.entries.push(entry);
    else groups.push({ key: group?.id ?? entry.id, ...(group ? { group } : {}), entries: [entry] });
  }
  return groups;
}

/** Snapshot time chip: the viewer never re-reads, so the capture time is the only clock that matters. */
export function formatCapturedAt(iso: string, locale: string, hour12?: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(hour12 === undefined ? {} : { hour12 }),
  });
}

/** Entry timestamp, same shape as the snapshot chip. */
export function formatEntryTime(timestamp: number, locale: string, hour12?: boolean): string {
  return formatCapturedAt(new Date(timestamp).toISOString(), locale, hour12);
}
