import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { memo, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { rememberRowHeight, rowHeightEstimate } from "./rowHeightCache";

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
  /** Offset from the scroller's scroll origin to the top of the list. Measured
   *  against the scroller itself rather than via `offsetTop`, whose reference is
   *  whichever ancestor happens to be positioned. */
  const measureMargin = useCallback(() => {
    const host = hostRef.current; const scroller = scrollerRef?.current;
    if (host === null || scroller === null || scroller === undefined) return;
    const next = host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((current) => Math.abs(current - next) < 0.5 ? current : next);
  }, [scrollerRef]);
  const virtualizer = useVirtualizer({
    count: itemKeys.length,
    getScrollElement: () => scrollerRef?.current ?? null,
    getItemKey: (index) => itemKeys[index]!,
    // 行高记忆（rowHeightCache）：重挂时未测量的行拿上次量到的真实高度当估高，
    // 首次布局就接近最终值，压掉「估高 → 实测 → 贴底」的修正链。
    estimateSize: (index: number) => rowHeightEstimate(keysRef.current[index]),
    overscan: CONVERSATION_OVERSCAN,
    enabled,
    // The first render can happen before ResizeObserver has reported the
    // scroller (and jsdom never reports one). Seed a viewport so the list does
    // not flash empty; real measurements replace it immediately.
    initialRect: { width: 0, height: 800 },
    scrollMargin,
    useAnimationFrameWithResizeObserver: true,
  });
  /**
   * Row mount 是记录行高的唯一时机：不挂第二个 ResizeObserver（悬挂观察在长滚动
   * 会话里积累 detached 节点的风险不值得），展开/收起导致的高度漂移留给下次挂载
   * 修正——估算只影响初值，测量永远是权威。
   *
   * 同一提交里还把真实高度同步喂回 virtualizer（`resizeItem`）：新行不再经历
   * 「按估高挂载 → 下一帧实测修正」的两段式。发送消息瞬间连续出现的新行（乐观
   * 用户行、落盘正式行、assistant 流式行）若各自先估后测，贴底跟随会呈现出
   * 「上下跳两三下」；挂载帧即真实高度后，跟随只剩一次平滑位移。ref 回调处于
   * React 提交阶段，此处触发的 virtualizer 更新会在本帧 paint 前落地。
   */
  const measureRow = useCallback((el: HTMLElement | null) => {
    if (el !== null && el.isConnected) {
      const index = Number(el.dataset.index);
      const key = keysRef.current[index];
      if (key !== undefined) {
        const height = el.getBoundingClientRect().height;
        if (height > 0) {
          rememberRowHeight(key, height);
          virtualizer.resizeItem(index, height);
        }
      }
    }
    virtualizer.measureElement(el);
  }, [virtualizer]);
  // `scrollMargin` 取决于列表上方每个兄弟（banner、notice、「加载更早」按钮）的高度。
  // 原实现无依赖、每次渲染都重测（两次 rect + 一次 scrollTop = 三次强制同步布局读）：
  // 流式期间每帧渲染 → 每秒上百次布局读 → RecalcStyle/Layout 风暴（实测 ~200 次/秒），
  // 既把主线程压死在原生布局上（点击迟滞、minimap 卡顿），又让原生分配高水位持续上涨
  // （长审查会话吃到 GB 级内存）。下方 ResizeObserver 已观察 host / scroller / parent，
  // 任何上方兄弟高度变化都会触发回调重测 margin；此处只需挂载时定初值、并在行集
  // 变化（结构重挂）时补一次。
  useLayoutEffect(() => { if (enabled) measureMargin(); }, [enabled, measureMargin, itemKeys.length]);
  useLayoutEffect(() => {
    const host = hostRef.current; const scroller = scrollerRef?.current;
    if (!enabled || host === null || scroller === null || scroller === undefined) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureMargin);
    observer.observe(scroller); observer.observe(host);
    const parent = host.parentElement; if (parent !== null) observer.observe(parent);
    return () => observer.disconnect();
  }, [enabled, measureMargin, scrollerRef]);
  const visible = capVirtualItems(virtualizer.getVirtualItems());
  if (!enabled) return <>{itemKeys.map((key, index) => <div key={key}>{renderItem(index)}</div>)}</>;
  // A newly opened/animated panel can be mounted before it has a non-zero
  // viewport. Render only a small tail until measurement arrives; never mount
  // the full long transcript as a fallback. `hostRef` stays attached here so
  // the margin effect can still measure and observe.
  if (visible.length === 0 && itemKeys.length > 0) {
    const start = Math.max(0, itemKeys.length - UNMEASURED_TAIL_ROWS);
    return <div ref={hostRef} className="convo-virtual-list">{itemKeys.slice(start).map((key, offset) => <div key={key}>{renderItem(start + offset)}</div>)}</div>;
  }
  return (
    <div ref={hostRef} className="convo-virtual-list" style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {visible.map((item) => (
        <div
          key={item.key}
          ref={measureRow}
          data-index={item.index}
          className="convo-virtual-row"
          style={{ left: 0, position: "absolute", top: 0, transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`, width: "100%" }}
        >
          {renderItem(item.index)}
        </div>
      ))}
    </div>
  );
});
