/**
 * 首次挂载大批行时的分帧铺开。
 *
 * 恢复一页历史是 50 条消息，非流式正文走的是「整篇 markdown 一次解析」：全部塞进同一
 * 次提交，主线程要连续解析 50 段正文加语法高亮，切会话的第一帧因此明显发顿。
 *
 * 这里只在「一次性多出远超一屏的行」时分帧：先渲染尾部若干行（对话区贴底，尾部才是
 * 用户真正看到的部分），随后每帧成倍放开，两三帧内铺满。稳态（流式追加、工具更新、
 * 加载更早消息）不节流——追加几行就直接渲染，节流只会让新内容迟到一帧。
 */

import { useEffect, useRef, useState } from "react";
import type { TimelineRow } from "./conversationViewModel";

/** 首帧渲染的尾部行数：够铺满一屏，又不至于让第一帧变成整页解析。 */
export const FIRST_PAINT_ROWS = 16;
/** 每帧放开的倍数：50 行两帧铺完，长历史也不会拖过三四帧。 */
const GROWTH_FACTOR = 3;
/** 一次多出这么多行以内算稳态追加，立即渲染。 */
const STAGE_THRESHOLD = 4;

/**
 * 返回本帧应该渲染的尾部行。返回值总是 `rows` 本身或它的后缀，调用方按
 * `rows.length - visible.length` 做索引偏移。
 */
export function useProgressiveRows(rows: readonly TimelineRow[]): readonly TimelineRow[] {
  const [budget, setBudget] = useState(FIRST_PAINT_ROWS);
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const staged = rows.length - budget > STAGE_THRESHOLD;
  const visibleCount = staged ? budget : rows.length;

  useEffect(() => {
    if (rows.length === 0) {
      /* transcript 被卸载 / 换会话：回到首帧预算，下一次挂载重新分帧。 */
      if (budgetRef.current !== FIRST_PAINT_ROWS) setBudget(FIRST_PAINT_ROWS);
      return;
    }
    if (rows.length - budgetRef.current <= STAGE_THRESHOLD) {
      /* 已经全部渲染出来了，把预算抬到当前行数，后续追加不再被裁。 */
      setBudget((current) => (current >= rows.length ? current : rows.length));
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      setBudget(rows.length);
      return;
    }
    const frame = requestAnimationFrame(() => {
      setBudget((current) => Math.min(rows.length, Math.max(current * GROWTH_FACTOR, FIRST_PAINT_ROWS)));
    });
    return () => cancelAnimationFrame(frame);
  }, [rows.length, budget]);

  if (visibleCount >= rows.length) return rows;
  return rows.slice(rows.length - visibleCount);
}
