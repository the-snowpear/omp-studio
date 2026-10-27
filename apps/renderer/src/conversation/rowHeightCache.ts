/** Cross-mount estimates, partitioned by actual body width, typography and
 * conversation/panel identity. Measurements remain authoritative. All contexts
 * share one bounded LRU, so a resize never clears an entire measured prefix. */
export const MAX_ROW_HEIGHT_ENTRIES = 8192;
export const ROW_WIDTH_BUCKET_PX = 32;
export const DEFAULT_ROW_ESTIMATE = 132;
export type RowHeightContext = {
  readonly width: number;
  readonly typography: string;
  readonly panel: string;
};

const heights = new Map<string, number>();
function cacheKey(key: string, context?: RowHeightContext): string {
  return JSON.stringify([context?.panel ?? "", context?.typography ?? "", context === undefined ? 0 : Math.round(context.width / ROW_WIDTH_BUCKET_PX), key]);
}
export function rememberRowHeight(key: string, height: number, context?: RowHeightContext): void {
  if (!(height > 0) || !Number.isFinite(height)) return;
  const entry = cacheKey(key, context);
  heights.delete(entry);
  heights.set(entry, height);
  if (heights.size > MAX_ROW_HEIGHT_ENTRIES) heights.delete(heights.keys().next().value!);
}
export function rowHeightEstimate(key: string | undefined, context?: RowHeightContext): number {
  if (key === undefined) return DEFAULT_ROW_ESTIMATE;
  const entry = cacheKey(key, context);
  const remembered = heights.get(entry);
  if (remembered === undefined) return DEFAULT_ROW_ESTIMATE;
  heights.delete(entry);
  heights.set(entry, remembered);
  return remembered;
}
/** Explicit typography invalidation or test reset. Width changes do not call it. */
export function resetRowHeightCache(): void {
  heights.clear();
}
