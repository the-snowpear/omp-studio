/** Compact-bar copy for a persisted compaction item. Never dump the archive body. */
import { isZh } from "../i18n";

const SNAPCOMPACT_RESUME = /You are resuming a prior conversation/i;
const SNAPCOMPACT_SCOPES = /¶(?:user|think|ai|call):/;
const SNAPCOMPACT_HISTORY = /\nHISTORY\n={3,}/;

export const COMPACT_LABEL_MAX_CHARS = 80;

export function isSnapcompactArchive(text: string): boolean {
  return SNAPCOMPACT_RESUME.test(text) || SNAPCOMPACT_SCOPES.test(text) || SNAPCOMPACT_HISTORY.test(text);
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

export function compactRuleLabel(item: { readonly shortSummary?: string; readonly summary: string }, zh = isZh()): string {
  const short = item.shortSummary?.trim() ?? "";
  if (short.length > 0 && !isSnapcompactArchive(short)) {
    const firstShort = firstLine(short);
    if (firstShort.length > 0 && firstShort.length <= COMPACT_LABEL_MAX_CHARS) return firstShort;
    return zh ? "已压缩" : "Compacted";
  }
  if (isSnapcompactArchive(item.summary)) return zh ? "历史已归档" : "History archived";
  const first = firstLine(item.summary);
  if (first.length > 0 && first.length <= COMPACT_LABEL_MAX_CHARS) return first;
  return zh ? "已压缩" : "Compacted";
}

export function compactSummaryFoldable(item: { readonly shortSummary?: string; readonly summary: string }, zh = isZh()): boolean {
  const summary = item.summary.trim();
  const short = item.shortSummary?.trim() ?? "";
  if (summary.length === 0 && short.length === 0) return false;
  if (isSnapcompactArchive(summary) || (short.length > 0 && isSnapcompactArchive(short))) return true;
  if (summary.includes("\n") || short.includes("\n")) return true;
  const label = compactRuleLabel(item, zh);
  if (summary.length > 0 && summary !== label) return true;
  if (short.length > 0 && short !== label) return true;
  return false;
}

export function compactMinimapPreview(item: { readonly shortSummary?: string; readonly summary: string }, zh = isZh()): string {
  return compactRuleLabel(item, zh);
}
