/**
 * 虚拟行行高的跨挂载记忆。
 *
 * `estimateSize` 固定 132px 时，切回一个看过的时间线要重走「估高 → 实测 → 贴底」的
 * 修正链（`settling` 隐身两帧就是为它兜底的）。这里把量过的行高按 rowKey 记在模块级
 * 缓存里，重挂时未测量的行直接拿上次的真实高度当估高：首次布局就接近最终值，修正与
 * 重排随之减少。行高仍以虚拟列表自己的测量为准，这里只影响初值。
 *
 * 上限 8192 条（行键是 itemId，全局唯一性不保证但撞键最多让某行初估偏差，实测立刻
 * 覆盖）；超限整体清空，简单且内存有界。
 */
const MAX_ENTRIES = 8192;

const heights = new Map<string, number>();

export const DEFAULT_ROW_ESTIMATE = 132;

export function rememberRowHeight(key: string, height: number): void {
  if (!(height > 0)) return;
  if (heights.size >= MAX_ENTRIES && !heights.has(key)) heights.clear();
  heights.set(key, height);
}

export function rowHeightEstimate(key: string | undefined): number {
  const remembered = key === undefined ? undefined : heights.get(key);
  return remembered ?? DEFAULT_ROW_ESTIMATE;
}

/** 仅供测试复位模块级缓存。 */
export function resetRowHeightCache(): void {
  heights.clear();
}
