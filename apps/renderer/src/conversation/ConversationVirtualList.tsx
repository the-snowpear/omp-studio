import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem } from "@tanstack/react-virtual";
import { memo, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { rememberRowHeight, rowHeightEstimate, type RowHeightContext } from "./rowHeightCache";
import { TYPOGRAPHY_BEFORE_CHANGE, TYPOGRAPHY_CHANGE } from "../settings/typography";
import { conversationIsFollowing, conversationScrollIdentity, isConversationReflowing, observeConversationReflow, type ConversationReflowObserver } from "./conversationReflow";

export const MAX_MOUNTED_CONVERSATION_ROWS = 120;
export const CONVERSATION_OVERSCAN = 6;
const UNMEASURED_TAIL_ROWS = 20;

/** The transcript is anchored at the bottom, so when the virtualizer hands back
 *  more rows than we are willing to mount, the ones worth keeping are the last
 *  ones — those are what the reader is looking at. Slicing the head instead
 *  leaves the bottom of the viewport blank. */
export function capVirtualItems(items: readonly VirtualItem[], max = MAX_MOUNTED_CONVERSATION_ROWS): readonly VirtualItem[] {
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

/** Keep a continuous normal-flow window: adding an isolated pinned row would
 * omit the gap between it and the viewport from the DOM's geometry. */
export function conversationRange(range: Range, anchorIndex = -1): number[] {
  const indexes = defaultRangeExtractor(range);
  let start = indexes[0] ?? 0;
  let end = indexes.at(-1) ?? -1;
  if (anchorIndex >= 0 && anchorIndex < range.count) {
    if (anchorIndex < start) start = Math.max(0, anchorIndex - range.overscan);
    if (anchorIndex > end) end = Math.min(range.count - 1, anchorIndex + range.overscan);
    if (end - start + 1 > MAX_MOUNTED_CONVERSATION_ROWS) {
      start = Math.max(start, Math.min(anchorIndex - range.overscan, end - MAX_MOUNTED_CONVERSATION_ROWS + 1));
      end = Math.min(end, start + MAX_MOUNTED_CONVERSATION_ROWS - 1);
    }
  } else start = Math.max(start, end - MAX_MOUNTED_CONVERSATION_ROWS + 1);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => start + offset);
}

export const ConversationVirtualList = memo(function ConversationVirtualList({
  scrollerRef,
  itemKeys,
  renderItem,
}: {
  scrollerRef?: RefObject<HTMLElement | null>;
  itemKeys: readonly string[];
  renderItem: (index: number) => ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const enabled = scrollerRef !== undefined;
  const keysRef = useRef(itemKeys);
  keysRef.current = itemKeys;
  const mountedRows = useRef(new Map<string, HTMLElement>());
  const heightContext = useRef<RowHeightContext>({ width: 0, typography: "", panel: "" });
  const contextInitialized = useRef(false);
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const reflow = useRef<ConversationReflowObserver | null>(null);
  const anchorIndex = anchorKey === null ? -1 : itemKeys.indexOf(anchorKey);
  const rangeExtractor = useCallback((range: Range) => conversationRange(range, anchorIndex), [anchorIndex]);
  /** Offset from the scroller's scroll origin to the top of the list. Measured
   *  against the scroller itself rather than via `offsetTop`, whose reference is
   *  whichever ancestor happens to be positioned. */
  const measureMargin = useCallback(() => {
    const host = hostRef.current; const scroller = scrollerRef?.current;
    if (host === null || scroller === null || scroller === undefined) return;
    const next = host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((current) => Math.abs(current - next) < 0.5 ? current : next);
  }, [scrollerRef]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: itemKeys.length,
    getScrollElement: () => scrollerRef?.current ?? null,
    getItemKey: (index) => itemKeys[index]!,
    // 行高记忆（rowHeightCache）：重挂时未测量的行拿上次量到的真实高度当估高，
    // 首次布局就接近最终值，压掉「估高 → 实测 → 贴底」的修正链。
    estimateSize: (index: number) => rowHeightEstimate(keysRef.current[index], heightContext.current),
    rangeExtractor,
    measureElement: (element, entry) => {
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
      const key = element.dataset.rowKey;
      if (key !== undefined) rememberRowHeight(key, height, heightContext.current);
      return height;
    },
    overscan: CONVERSATION_OVERSCAN,
    enabled,
    // The first render can happen before ResizeObserver has reported the
    // scroller (and jsdom never reports one). Seed a viewport so the list does
    // not flash empty; real measurements replace it immediately.
    initialRect: { width: 0, height: 800 },
    scrollMargin,
    // 行高测量按 rAF 延后一帧（库默认行为）在这里是安全的：可见行走普通流，行的位置
    // 与容器高度都由浏览器的布局给出，测量只影响未挂载区域的 padding（见下方 render），
    // 而 padding 的两端在同一次提交里等量增减、净变化为零。
    useAnimationFrameWithResizeObserver: true,
  });
  // TanStack's measurement compensation must not race either the unique tail
  // writer or our detached-reader block anchor during a reflow transaction.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    const scroller = scrollerRef?.current;
    return scroller != null && !conversationIsFollowing(scroller) && !isConversationReflowing(scroller)
      && item.end <= scroller.scrollTop && virtualizer.scrollDirection !== "backward";
  };
  /** Record on mount and on TanStack's existing row observer; do not create a
   * second per-row observer. Keep a bounded mounted-node registry for reflows. */
  const measureRow = useCallback((el: HTMLElement | null) => {
    if (el !== null && el.isConnected) {
      const index = Number(el.dataset.index);
      const key = el.dataset.rowKey;
      if (key !== undefined && keysRef.current[index] === key) {
        mountedRows.current.set(key, el);
        const height = el.getBoundingClientRect().height;
        if (height > 0) {
          rememberRowHeight(key, height, heightContext.current);
          virtualizer.resizeItem(index, height);
        }
      }
    } else {
      for (const [key, node] of mountedRows.current) if (!node.isConnected) mountedRows.current.delete(key);
    }
    virtualizer.measureElement(el);
  }, [virtualizer]);
  useLayoutEffect(() => {
    const host = hostRef.current; const scroller = scrollerRef?.current;
    if (!enabled || host === null || scroller == null) return;
    const observer = observeConversationReflow({
      scroller, host, beforeEvent: TYPOGRAPHY_BEFORE_CHANGE, changeEvent: TYPOGRAPHY_CHANGE,
      measureMargin, pinRow: setAnchorKey,
      measure: (width) => {
        const style = getComputedStyle(host);
        const root = getComputedStyle(document.documentElement);
        heightContext.current = {
          width,
          panel: `${scroller.className}:${conversationScrollIdentity(scroller)}`,
          typography: [style.fontFamily, style.fontSize, style.lineHeight,
            root.getPropertyValue("--font-output"), root.getPropertyValue("--font-output-code"),
            root.getPropertyValue("--output-font-scale"), root.getPropertyValue("--ui-font-scale")].join("|"),
        };
        // The first render precedes hostRef, so seed cross-mount estimates once
        // its real context is known. Never repeat this reset during reflow.
        if (!contextInitialized.current && width > 0) {
          contextInitialized.current = true;
          if (conversationIsFollowing(scroller) && !isConversationReflowing(scroller)) virtualizer.measure();
        }
        // Retain offscreen measurements even in a new width bucket. Resetting
        // the prefix can move the range thousands of rows away from the anchor.
        // Only the mounted bounded window is remeasured at its actual width.
        for (const [key, row] of mountedRows.current) {
          if (!row.isConnected) mountedRows.current.delete(key);
          else measureRow(row);
        }
      },
    });
    reflow.current = observer;
    return () => { reflow.current = null; observer.dispose(); };
  }, [enabled, scrollerRef, virtualizer, measureMargin, measureRow]);
  // Padding and the pinned range can commit after the synchronous change event.
  // Restore again before paint, but only while the same transaction is active.
  useLayoutEffect(() => {
    for (const [key, row] of mountedRows.current) if (!row.isConnected) mountedRows.current.delete(key);
    reflow.current?.afterCommit();
  });
  // `scrollMargin` 取决于列表上方每个兄弟（banner、notice、「加载更早」按钮）的高度。
  // 原实现无依赖、每次渲染都重测（两次 rect + 一次 scrollTop = 三次强制同步布局读）：
  // 流式期间每帧渲染 → 每秒上百次布局读 → RecalcStyle/Layout 风暴（实测 ~200 次/秒），
  // 既把主线程压死在原生布局上（点击迟滞、minimap 卡顿），又让原生分配高水位持续上涨
  // （长审查会话吃到 GB 级内存）。下方 ResizeObserver 已观察 host / scroller / parent，
  // 任何上方兄弟高度变化都会触发回调重测 margin；此处只需挂载时定初值、并在行集
  // 变化（结构重挂）时补一次。
  useLayoutEffect(() => { if (enabled) measureMargin(); }, [enabled, measureMargin, itemKeys.length]);
  const visible = capVirtualItems(virtualizer.getVirtualItems());
  if (!enabled) return <>{itemKeys.map((key, index) => <div key={key}>{renderItem(index)}</div>)}</>;
  // A newly opened/animated panel can be mounted before it has a non-zero
  // viewport. Render only a small tail until measurement arrives; never mount
  // the full long transcript as a fallback. `hostRef` stays attached here so
  // the margin effect can still measure and observe.
  if (visible.length === 0 && itemKeys.length > 0) {
    const start = Math.max(0, itemKeys.length - UNMEASURED_TAIL_ROWS);
    return <div ref={hostRef} className="convo-virtual-list">{itemKeys.slice(start).map((key, offset) => <div key={key} ref={measureRow} data-index={start + offset} data-row-key={key} className="convo-virtual-row">{renderItem(start + offset)}</div>)}</div>;
  }
  /**
   * 挂载的行走**普通流**，未挂载的头尾由容器 padding 占位——不是绝对定位 + 容器高度。
   *
   * 这是「贴底时展开中段工具卡，下方内容先往下再归位」的根治。绝对定位下：行内长高的那
   * 一帧，容器高度还是 virtualizer 上一次提交的旧值（行 RO → rAF → React 异步提交，晚
   * 2~3 帧），scrollHeight 不变，唯一的贴底写手无从补偿；而同一行内展开点下方的内容是
   * 流内的、当帧就被推下去。真 Chromium 实测（`npm run perf:streaming` 的
   * expand-below-card-hold-position-px）：绝对定位 35.8px、走流 0.5px。
   *
   * 走流以后：长高当帧就把下方内容连同整篇文档一起推下去 → `.convo-doc` 的 ResizeObserver
   * 在同一帧的绘制前窗口触发 `stickToTail` → scrollTop 补上同样的量，净位移为零。虚拟化的
   * 职责退回到「挂多少行」和两端 padding：
   *   - `paddingTop`    = 首个已挂载行的 start（`capVirtualItems` 砍掉的头也算在里面）
   *   - `paddingBottom` = 总高 − 末个已挂载行的 end
   * 行长高时这两个值都不变（start 在它之前，end 与总高等量增长），所以 virtualizer 迟到的
   * 提交在几何上是空操作，不会二次补偿。行盒必须自成 BFC（CSS 里的 `display: flow-root`），
   * 否则 `.ev` 的 margin 会穿出行盒，实测高度与它在流里真正占的位置就差一段。
   */
  // 空列表（例如 Agent Hub 里还没有任何行的预览面）没有已挂载行可推算，两端 padding 归零。
  const first = visible[0];
  const last = visible[visible.length - 1];
  const paddingTop = first === undefined ? 0 : Math.max(0, first.start - virtualizer.options.scrollMargin);
  const paddingBottom = last === undefined ? 0 : Math.max(0, virtualizer.getTotalSize() - last.end);
  return (
    <div ref={hostRef} className="convo-virtual-list" style={{ paddingBottom, paddingTop, position: "relative" }}>
      {visible.map((item) => (
        <div
          key={item.key}
          ref={measureRow}
          data-index={item.index}
          data-row-key={String(item.key)}
          className="convo-virtual-row"
        >
          {renderItem(item.index)}
        </div>
      ))}
    </div>
  );
});
