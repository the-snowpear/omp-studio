/**
 * 快照之间的时间线行复用。
 *
 * 每次 client state 变更都会把整条时间线的行对象重建一遍：内容一模一样的历史消息
 * 也换成新引用，`ConversationItemView` 的 `memo` 于是永远命中不了，流式期间每一帧
 * 都要把所有已定稿消息连同 markdown 重渲染一次。这里在新旧快照之间做一次结构比较，
 * 内容没变的行沿用旧对象；整条时间线都没变时连数组本身一起沿用，让上层按 `rows`
 * identity 做的 `useMemo` 也能一起短路。
 *
 * 比较远比重渲染便宜：持久化正文、工具参数与结果在两次快照里是同一个引用，深比较
 * 基本在第一层引用相等就短路，只有正在流式的那条消息真的需要比一遍字符串。
 */

import type { TimelineRow } from "./conversationViewModel";

function timelineRowKey(row: TimelineRow): string {
  if (row.type === "compacting") return "compacting";
  if (row.type === "compaction" || row.type === "resetBoundary") return row.item.itemId;
  return row.itemId;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!sameValue(a[index], b[index])) return false;
  }
  return true;
}

function sameRecord(a: object, b: object): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const left = a as { readonly [key: string]: unknown };
  const right = b as { readonly [key: string]: unknown };
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/**
 * 结构相等：数组与普通对象逐层比较，其它宿主对象（Blob、Date、类实例）只认引用
 * 相等——它们的可枚举自有属性可能为空，结构比较会把不同的值判成相同。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (arrayA) return sameArray(a as readonly unknown[], b as readonly unknown[]);
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  return sameRecord(a, b);
}

export function reuseTimelineRows(
  previous: readonly TimelineRow[],
  next: readonly TimelineRow[],
): readonly TimelineRow[] {
  if (previous === next) return next;
  if (previous.length === 0 || next.length === 0) return next;
  const byKey = new Map<string, TimelineRow>();
  for (const row of previous) byKey.set(timelineRowKey(row), row);
  const rows: TimelineRow[] = [];
  let identical = previous.length === next.length;
  for (let index = 0; index < next.length; index += 1) {
    const row = next[index]!;
    const old = byKey.get(timelineRowKey(row));
    if (old !== undefined && sameValue(old, row)) {
      rows.push(old);
      if (previous[index] !== old) identical = false;
      continue;
    }
    rows.push(row);
    identical = false;
  }
  return identical ? previous : rows;
}
