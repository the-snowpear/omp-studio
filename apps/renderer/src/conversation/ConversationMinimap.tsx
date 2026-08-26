import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Icon } from "../icons";
import { compactMinimapPreview } from "./compactSummary";
import { batchSummary, toolKind, type ThinkView } from "./toolMeta";
import type { AssistantSegment, TimelineRow, ToolView } from "./conversationViewModel";

/** 底部工具按钮区预留高度（与 ver1 syncViewport 的 52px 一致）。 */
const TOOLS_RESERVE_PX = 52;
/** 圆点最小间距（占对话总高的比例）；过近的圆点折叠为代表点。 */
const MIN_MARK_GAP = 0.018;
/** 视口条最小高度（px）。 */
const MIN_VIEWPORT_H = 18;
/** 悬浮预览延迟隐藏（ms），期间可移入弹层。 */
const PREVIEW_HIDE_DELAY_MS = 250;
/** 跳转目标行的高亮时长（ms）。 */
const FLASH_MS = 900;

export type MinimapMarkType =
  | "user"
  | "assistant"
  | "error"
  | "bash"
  | "file"
  | "thinking"
  | "compact"
  | "checkpoint";

export type MinimapMark = {
  readonly itemId: string;
  readonly type: MinimapMarkType;
  readonly label: string;
  readonly preview: string;
  readonly turn: number;
};

const MARK_LABEL: Record<MinimapMarkType, string> = {
  user: "用户消息",
  assistant: "助手回复",
  error: "错误",
  bash: "命令执行",
  file: "文件操作",
  thinking: "思考",
  compact: "历史压缩",
  checkpoint: "检查点",
};

/** 折叠与「仅关键节点」筛选时优先保留的类型。 */
const PRIORITY_TYPES: ReadonlySet<MinimapMarkType> = new Set(["error", "compact", "checkpoint", "user"]);
/** 「仅显示错误与关键节点」保留的类型。 */
const KEY_TYPES: readonly MinimapMarkType[] = ["error", "compact", "checkpoint"];

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

function assistantMarkType(row: Extract<TimelineRow, { type: "assistant" }>): MinimapMarkType {
  if (row.status === "error") return "error";
  let hasBash = false;
  let hasFile = false;
  let hasThinking = false;
  for (const segment of row.segments) {
    if (segment.type === "thinking") hasThinking = true;
    else if (segment.type === "batch") {
      for (const tool of segment.tools) {
        const kind = toolKind(tool);
        if (kind === "bash") hasBash = true;
        else if (kind === "read" || kind === "write" || kind === "edit" || kind === "ast_edit") hasFile = true;
      }
    }
  }
  if (hasBash) return "bash";
  if (hasFile) return "file";
  if (hasThinking) return "thinking";
  return "assistant";
}

function assistantPreview(segments: readonly AssistantSegment[]): string {
  const firstText = segments.find(
    (segment): segment is Extract<AssistantSegment, { type: "text" }> => segment.type === "text" && segment.text.trim().length > 0,
  );
  if (firstText) return firstText.text.trim();
  const thinking: ThinkView[] = [];
  const tools: ToolView[] = [];
  for (const segment of segments) {
    if (segment.type === "thinking") {
      thinking.push({
        key: segment.key,
        text: segment.text,
        ...(segment.truncated === undefined ? {} : { truncated: segment.truncated }),
      });
    } else if (segment.type === "batch") {
      tools.push(...segment.tools);
    }
  }
  if (thinking.length > 0 || tools.length > 0) return batchSummary(thinking, tools).text;
  return "";
}

/** 从时间线行派生 minimap 圆点：一行一点，类型决定着色与标签。 */
export function deriveMinimapMarks(rows: readonly TimelineRow[]): MinimapMark[] {
  const marks: MinimapMark[] = [];
  for (const row of rows) {
    if (row.type === "user") {
      marks.push({
        itemId: row.itemId,
        type: "user",
        label: MARK_LABEL.user,
        preview: row.error ? `发送失败：${row.error}` : row.text.trim(),
        turn: 0,
      });
    } else if (row.type === "assistant") {
      const type = assistantMarkType(row);
      marks.push({ itemId: row.itemId, type, label: MARK_LABEL[type], preview: assistantPreview(row.segments), turn: 0 });
    } else if (row.type === "compaction") {
      marks.push({
        itemId: row.item.itemId,
        type: "compact",
        label: MARK_LABEL.compact,
        preview: compactMinimapPreview(row.item),
        turn: 0,
      });
    } else if (row.type === "compacting") {
      marks.push({
        itemId: "compacting",
        type: "compact",
        label: "压缩中",
        preview: "正在压缩当前上下文",
        turn: 0,
      });
    } else {
      marks.push({
        itemId: row.item.itemId,
        type: "checkpoint",
        label: MARK_LABEL.checkpoint,
        preview: "会话在此处重置，更早的消息仍可通过会话归档查看。",
        turn: 0,
      });
    }
  }
  return marks.map((mark, index) => ({ ...mark, turn: index + 1 }));
}

export type MarkFractions = Readonly<Record<string, number>>;

/**
 * 折叠过近的圆点：以簇首位置为锚，间隔小于 MIN_MARK_GAP 的连续圆点合并为代表点，
 * 代表点优先取错误，其次取关键类型（user/compact/checkpoint），否则取簇首。
 */
export function spaceMinimapMarks(marks: readonly MinimapMark[], fractions: MarkFractions): readonly MinimapMark[] {
  const entries: Array<{ mark: MinimapMark; f: number }> = [];
  for (const mark of marks) {
    const f = fractions[mark.itemId];
    if (f !== undefined) entries.push({ mark, f });
  }
  const placed: MinimapMark[] = [];
  let i = 0;
  while (i < entries.length) {
    const anchor = entries[i]!.f;
    let j = i;
    while (j + 1 < entries.length && entries[j + 1]!.f - anchor < MIN_MARK_GAP) j++;
    let pick = i;
    const errorIdx = entries.findIndex((entry, idx) => idx >= i && idx <= j && entry.mark.type === "error");
    if (errorIdx >= 0) pick = errorIdx;
    else {
      const priorityIdx = entries.findIndex((entry, idx) => idx >= i && idx <= j && PRIORITY_TYPES.has(entry.mark.type));
      if (priorityIdx >= 0) pick = priorityIdx;
    }
    placed.push(entries[pick]!.mark);
    i = j + 1;
  }
  return placed;
}

/** 从当前活跃圆点向后找下一个指定类型的圆点，越过末尾回绕。 */
export function pickNextMark(
  marks: readonly MinimapMark[],
  activeItemId: string | null,
  types: readonly MinimapMarkType[],
): MinimapMark | null {
  if (marks.length === 0) return null;
  const activeIdx = activeItemId === null ? -1 : marks.findIndex((mark) => mark.itemId === activeItemId);
  const start = activeIdx + 1;
  for (let step = 0; step < marks.length; step++) {
    const candidate = marks[(start + step) % marks.length]!;
    if (types.includes(candidate.type)) return candidate;
  }
  return null;
}

function flashRow(node: HTMLElement): void {
  node.classList.remove("mm-flash");
  void node.offsetWidth;
  node.classList.add("mm-flash");
  window.setTimeout(() => node.classList.remove("mm-flash"), FLASH_MS);
}

type ScrollBox = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  getBoundingClientRect(): { top: number };
};

type ScrollTarget = {
  getBoundingClientRect(): { top: number; height: number };
};

/**
 * 只计算对话 scroller 内把 `node` 居中所需的 scrollTop，并夹取到
 * `[0, maxScroll]`。不要用 Element.scrollIntoView：Chromium 会继续滚
 * overflow:hidden 的祖先（.app-body），把 composer 连底栏一起抬上去。
 */
export function scrollOffsetToCenter(scroller: ScrollBox, node: ScrollTarget): number {
  const nodeRect = node.getBoundingClientRect();
  const nodeCenter = nodeRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop + nodeRect.height / 2;
  const target = nodeCenter - scroller.clientHeight / 2;
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return Math.max(0, Math.min(maxScroll, target));
}

function resetAncestorScroll(from: HTMLElement): void {
  let el = from.parentElement;
  while (el) {
    if (el.scrollTop !== 0) el.scrollTop = 0;
    el = el.parentElement;
  }
}

function scrollRowInScroller(scroller: HTMLElement, node: HTMLElement): number {
  resetAncestorScroll(scroller);
  const top = scrollOffsetToCenter(scroller, node);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top, behavior: "smooth" });
  } else {
    scroller.scrollTop = top;
  }
  return top;
}

/**
 * 对话 minimap（参照 ver1 ChatMinimap）：对话行驱动的圆点轨道 + 视口指示条。
 * 滚动同步走命令式 DOM 更新（scroll 事件高频，不进 React state）；
 * 圆点位置按「行中心占对话总高比例」映射到轨道（calc 扣除底部工具预留），
 * 因此与视口条共用同一坐标系，圆点落在视口条内 ⇔ 对应行在可视区。
 */
export function ConversationMinimap({
  rows,
  scrollerRef,
  preview = false,
}: {
  rows: readonly TimelineRow[];
  scrollerRef: RefObject<HTMLElement | null>;
  preview?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const filterWrapRef = useRef<HTMLSpanElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const [fractions, setFractions] = useState<MarkFractions>({});
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [keyOnly, setKeyOnly] = useState(false);

  const marks = useMemo(() => deriveMinimapMarks(rows), [rows]);
  const marksRef = useRef(marks);
  marksRef.current = marks;

  const syncViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!scroller || !viewport || !track) return;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) {
      viewport.style.display = "none";
      return;
    }
    viewport.style.display = "";
    const range = track.clientHeight - TOOLS_RESERVE_PX;
    const viewportH = Math.max(MIN_VIEWPORT_H, (scroller.clientHeight / scroller.scrollHeight) * range);
    const progress = scroller.scrollTop / maxScroll;
    viewport.style.height = `${viewportH}px`;
    viewport.style.top = `${progress * (range - viewportH)}px`;
    syncActiveMark(scroller, track, activeIdRef);
  }, [scrollerRef]);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollHeight = scroller.scrollHeight;
    if (scrollHeight <= 0) return;
    const base = scroller.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    let changed = false;
    for (const mark of marksRef.current) {
      const node = scroller.querySelector<HTMLElement>(`[data-item-id="${cssEscape(mark.itemId)}"]`);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const center = rect.top - base + scroller.scrollTop + rect.height / 2;
      const fraction = Math.min(0.985, Math.max(0.015, center / scrollHeight));
      const rounded = Math.round(fraction * 10000) / 10000;
      next[mark.itemId] = rounded;
      if (fractionsRef.current[mark.itemId] !== rounded) changed = true;
    }
    if (changed) setFractions(next);
  }, [scrollerRef]);

  const fractionsRef = useRef(fractions);
  fractionsRef.current = fractions;

  /* 测量圆点位置：行变化 + 内容高度变化（流式增长、工具展开、窗口缩放）。 */
  useLayoutEffect(() => {
    measure();
    syncViewport();
    if (typeof ResizeObserver !== "function") return;
    const scroller = scrollerRef.current;
    const doc = scroller?.querySelector(".convo-doc") ?? null;
    const observer = new ResizeObserver(() => {
      measure();
      syncViewport();
    });
    if (scroller) observer.observe(scroller);
    if (doc) observer.observe(doc);
    if (trackRef.current) observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [measure, syncViewport, scrollerRef, rows]);

  /* 滚动同步视口条（passive，高频，全部走命令式更新）。 */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", syncViewport, { passive: true });
    const frame = requestAnimationFrame(syncViewport);
    return () => {
      scroller.removeEventListener("scroll", syncViewport);
      cancelAnimationFrame(frame);
    };
  }, [syncViewport, scrollerRef]);

  const placed = useMemo(() => spaceMinimapMarks(marks, fractions), [marks, fractions]);
  const visible = useMemo(
    () => (keyOnly ? placed.filter((mark) => KEY_TYPES.includes(mark.type)) : placed),
    [placed, keyOnly],
  );
  const hoveredMark = hoveredItemId === null ? null : visible.find((mark) => mark.itemId === hoveredItemId) ?? null;

  const jumpTo = useCallback(
    (itemId: string) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const node = scroller.querySelector<HTMLElement>(`[data-item-id="${cssEscape(itemId)}"]`);
      if (!node) return;
      scrollRowInScroller(scroller, node);
      flashRow(node);
    },
    [scrollerRef],
  );

  const jumpToNext = useCallback(
    (types: readonly MinimapMarkType[]) => {
      const target = pickNextMark(visible, activeIdRef.current, types);
      if (target) jumpTo(target.itemId);
    },
    [visible, jumpTo],
  );

  /* 悬浮预览：250ms 延迟隐藏，可移入弹层取消。 */
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => setHoveredItemId(null), PREVIEW_HIDE_DELAY_MS);
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);

  useLayoutEffect(() => {
    if (hoveredItemId === null) return;
    const popup = popupRef.current;
    const root = rootRef.current;
    const markEl = trackRef.current?.querySelector<HTMLElement>(`[data-mark-id="${cssEscape(hoveredItemId)}"]`);
    if (!popup || !root || !markEl) return;
    const wrap = root.getBoundingClientRect();
    const rect = markEl.getBoundingClientRect();
    const top = Math.max(8, Math.min(rect.top - wrap.top - 60, wrap.height - popup.offsetHeight - 40));
    popup.style.top = `${top}px`;
  }, [hoveredItemId]);

  /* 轨道空白处：拖动 = 按比例即时滚动；原处松开 = 平滑滚到点击比例。 */
  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".mm-mark")) return;
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    event.preventDefault();
    track.setPointerCapture?.(event.pointerId);
    const startY = event.clientY;
    let moved = false;
    const maxScroll = () => scroller.scrollHeight - scroller.clientHeight;
    const apply = (clientY: number, smooth: boolean) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      const target = ratio * maxScroll();
      if (smooth) scroller.scrollTo({ top: target, behavior: "smooth" });
      else scroller.scrollTop = target;
      syncViewport();
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientY - startY) > 3) moved = true;
      if (moved) apply(moveEvent.clientY, false);
    };
    const finish = (upEvent: PointerEvent) => {
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", finish);
      track.removeEventListener("pointercancel", finish);
      if (!moved) apply(upEvent.clientY, true);
    };
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", finish);
    track.addEventListener("pointercancel", finish);
  };

  /* 视口条：滑块语义，拖动保持抓取偏移。 */
  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    const viewport = viewportRef.current;
    if (!scroller || !track || !viewport) return;
    event.preventDefault();
    event.stopPropagation();
    viewport.setPointerCapture?.(event.pointerId);
    const grab = event.clientY - viewport.getBoundingClientRect().top;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const range = track.clientHeight - TOOLS_RESERVE_PX;
    const sliderSpan = range - viewport.offsetHeight;
    const onMove = (moveEvent: PointerEvent) => {
      if (sliderSpan <= 0) return;
      const trackTop = track.getBoundingClientRect().top;
      const top = Math.min(Math.max(0, moveEvent.clientY - grab - trackTop), sliderSpan);
      scroller.scrollTop = (top / sliderSpan) * maxScroll;
      syncViewport();
    };
    const finish = () => {
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", finish);
      viewport.removeEventListener("pointercancel", finish);
    };
    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerup", finish);
    viewport.addEventListener("pointercancel", finish);
  };

  /* 筛选菜单：点击外部关闭。 */
  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!filterWrapRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [filterOpen]);

  const hasError = visible.some((mark) => mark.type === "error");
  const hasUser = visible.some((mark) => mark.type === "user");

  return (
    <div className="minimap" id="minimap" ref={rootRef}>
      <div className="minimap-track" id="mmTrack" ref={trackRef} onPointerDown={onTrackPointerDown}>
        <span className="mm-rail" aria-hidden="true" />
        {visible.map((mark) => (
          <button
            key={mark.itemId}
            type="button"
            data-mark-id={mark.itemId}
            className={`mm-mark ${mark.type}`}
            style={
              fractions[mark.itemId] === undefined
                ? undefined
                : { top: `calc(${(fractions[mark.itemId]! * 100).toFixed(2)}% - ${(fractions[mark.itemId]! * TOOLS_RESERVE_PX).toFixed(1)}px)` }
            }
            aria-label={`#${mark.turn} ${mark.label}`}
            onClick={() => jumpTo(mark.itemId)}
            onMouseEnter={() => {
              cancelHide();
              setHoveredItemId(mark.itemId);
            }}
            onMouseLeave={scheduleHide}
            onFocus={() => setHoveredItemId(mark.itemId)}
            onBlur={scheduleHide}
          />
        ))}
      </div>
      <div className="mm-viewport" id="mmViewport" aria-hidden="true" ref={viewportRef} onPointerDown={onViewportPointerDown} />
      {hoveredMark ? (
        <div
          className="mm-preview"
          ref={popupRef}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          onKeyDown={(event) => {
            if (event.key === "Escape") setHoveredItemId(null);
          }}
        >
          <div className="mp-no">
            #{String(hoveredMark.turn).padStart(2, "0")} · {hoveredMark.label}
            {preview ? <span className="mp-demo">演示</span> : null}
          </div>
          {hoveredMark.preview ? <div className="mp-user">{hoveredMark.preview}</div> : <div className="mp-empty">无预览文本</div>}
        </div>
      ) : null}
      <div className="minimap-tools">
        <span ref={filterWrapRef}>
          <button
            type="button"
            className="icon-btn"
            data-tip={keyOnly ? "仅关键" : "筛选"}
            aria-label="筛选事件"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((open) => !open)}
          >
            <Icon name="filter" extra="sm" />
          </button>
          {filterOpen ? (
            <div className="menu mm-menu" role="menu" aria-label="筛选与跳转" onKeyDown={(event) => {
              if (event.key === "Escape") setFilterOpen(false);
            }}>
              <div className="menu-label">筛选与跳转</div>
              <button type="button" className="menu-item" role="menuitem" disabled={!hasError} onClick={() => {
                setFilterOpen(false);
                jumpToNext(["error"]);
              }}>
                <Icon name="alert" extra="sm" />
                跳到下一个错误
              </button>
              <button type="button" className="menu-item" role="menuitem" disabled={!hasUser} onClick={() => {
                setFilterOpen(false);
                jumpToNext(["user"]);
              }}>
                <Icon name="message" extra="sm" />
                跳到下一个用户消息
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                aria-pressed={keyOnly}
                onClick={() => setKeyOnly((only) => !only)}
              >
                <Icon name={keyOnly ? "eye" : "filter" } extra="sm" />
                {keyOnly ? "显示全部节点" : "仅显示错误与关键节点"}
              </button>
            </div>
          ) : null}
        </span>
        <button
          type="button"
          className="icon-btn"
          data-tip="回到最新"
          aria-label="回到最新"
          onClick={() => scrollerRef.current?.scrollTo({ top: 9e6, behavior: "smooth" })}
        >
          <Icon name="arrow-d" extra="sm" />
        </button>
      </div>
    </div>
  );
}

/** 活跃圆点 = 离 scroller 视口中线最近的圆点（命令式 class 切换）。 */
function syncActiveMark(
  scroller: HTMLElement,
  track: HTMLElement,
  activeIdRef: { current: string | null },
): void {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const mid = scroller.clientHeight * 0.5;
  let bestId: string | null = null;
  let bestDistance = Infinity;
  for (const el of Array.from(track.querySelectorAll<HTMLElement>(".mm-mark"))) {
    const rect = el.getBoundingClientRect();
    const center = rect.top + rect.height / 2 - scrollerTop;
    const distance = Math.abs(center - mid);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = el.dataset.markId ?? null;
    }
  }
  for (const el of Array.from(track.querySelectorAll<HTMLElement>(".mm-mark.active"))) {
    if (el.dataset.markId !== bestId) el.classList.remove("active");
  }
  if (bestId !== null) {
    track.querySelector<HTMLElement>(`.mm-mark[data-mark-id="${cssEscape(bestId)}"]`)?.classList.add("active");
  }
  activeIdRef.current = bestId;
}
