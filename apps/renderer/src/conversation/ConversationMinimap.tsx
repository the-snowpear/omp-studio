import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { compactMinimapPreview } from "./compactSummary";
import { MOTION_MS } from "../motion";
import { batchSummary, toolKind, type ThinkView } from "./toolMeta";
import { tailStreaming, timelineStructureToken } from "./conversationViewModel";
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
const FLASH_MS = MOTION_MS.flash;
/** 圆点位置全量重测的最小间隔（ms）；见 `requestMeasure`。 */
export const MEASURE_INTERVAL_MS = 200;
/**
 * 流式期间的重测间隔（ms）。
 *
 * 流式的每一帧都在换尾行圆点、改 scrollHeight，两道跳过条件都失效，于是 200ms 一次的
 * 全量重测（全子树 `querySelectorAll` + 逐节点 rect + `setFractions` 带出的整条轨道重
 * 渲染）正好压在最忙的那段主线程上。圆点位置是导航用的近似量，流式期间落后半秒看不
 * 出来，产出结束后必然还有最后一次收敛。
 */
export const MEASURE_INTERVAL_STREAMING_MS = 700;

function now(): number {
  return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export type MinimapMarkType =
  | "user"
  | "extension"
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
  /** A failed user row is rendered as an error, but remains a user-navigation target. */
  readonly navigationTypes?: readonly MinimapMarkType[];
  /** i18n key instead of literal copy: marks are cached across renders and
   *  locale switches, so the label must be translated at paint time. */
  readonly labelKey: string;
  readonly preview: string;
  /** Fixed UI sentence for previews that are not user content. */
  readonly previewKey?: string;
  /** `preview` is an error message that needs the localized "send failed" prefix. */
  readonly previewError?: boolean;
  readonly turn: number;
};

const MARK_LABEL_KEY: Record<MinimapMarkType, string> = {
  user: "conversation.minimapUser",
  extension: "conversation.minimapExtension",
  assistant: "conversation.minimapAssistant",
  error: "conversation.minimapError",
  bash: "conversation.minimapBash",
  file: "conversation.minimapFile",
  thinking: "conversation.minimapThinking",
  compact: "conversation.minimapCompact",
  checkpoint: "conversation.minimapCheckpoint",
};

/** 折叠与「仅关键节点」筛选时优先保留的类型。 */
const PRIORITY_TYPES: ReadonlySet<MinimapMarkType> = new Set(["error", "compact", "checkpoint", "user"]);
/** 「仅显示错误与关键节点」保留的类型。 */
const KEY_TYPES: readonly MinimapMarkType[] = ["error", "compact", "checkpoint"];

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

function assistantMarkType(rows: readonly Extract<TimelineRow, { type: "assistant" }>[]): MinimapMarkType {
  let hasBash = false;
  let hasFile = false;
  let hasThinking = false;
  for (const row of rows) {
    if (row.status === "error") return "error";
    for (const segment of row.segments) {
      if (segment.type === "thinking") hasThinking = true;
      else if (segment.type === "batch") {
        for (const tool of segment.tools) {
          /* Only a real failure paints the turn red. `aborted` is the user
             pressing stop, and `missing` is what a call left without a result
             becomes when that stop lands mid-tool (`closeTurn` clears
             `openTurnItems`, so `toolViews` degrades to "missing"); flagging
             either turns 跳到下一个错误 into a tour of the user's own
             cancellations. The tool still contributes its kind below. */
          if (tool.status === "failed") return "error";
          const kind = toolKind(tool);
          if (kind === "bash") hasBash = true;
          else if (kind === "read" || kind === "write" || kind === "edit" || kind === "ast_edit") hasFile = true;
        }
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

/**
 * 行 → 圆点缓存。`rowReuse` 让未变化的行保持对象身份，因此每行只在首次出现时
 * 计算一次 preview（`trim()` / `batchSummary` 都会复制整段正文）。流式期间只有
 * 尾行是新对象，其余行直接命中缓存，派生代价从 O(全文字符) 降到 O(行数) 次查找。
 */
const markCache = new WeakMap<TimelineRow, MinimapMark>();

function buildMark(row: TimelineRow, turn: number): MinimapMark {
  if (row.type === "extension") return { itemId: row.itemId, type: "extension", labelKey: MARK_LABEL_KEY.extension, preview: row.text, turn };
  if (row.type === "user") {
    const failed = row.pending === "failed" || row.error !== undefined;
    return {
      itemId: row.itemId,
      type: failed ? "error" : "user",
      ...(failed ? { navigationTypes: ["user", "error"] as const } : {}),
      labelKey: failed ? MARK_LABEL_KEY.error : MARK_LABEL_KEY.user,
      preview: row.error ?? row.text.trim(),
      ...(row.error === undefined ? {} : { previewError: true as const }),
      turn,
    };
  }
  if (row.type === "assistant") {
    const type = assistantMarkType([row]);
    return { itemId: row.itemId, type, labelKey: MARK_LABEL_KEY[type], preview: assistantPreview(row.segments), turn };
  }
  if (row.type === "compaction") {
    return {
      itemId: row.item.itemId,
      type: "compact",
      labelKey: MARK_LABEL_KEY.compact,
      preview: compactMinimapPreview(row.item),
      turn,
    };
  }
  if (row.type === "compacting") {
    return {
      itemId: "compacting",
      type: "compact",
      labelKey: "conversation.minimapCompacting",
      preview: "",
      previewKey: "conversation.minimapCompactingPreview",
      turn,
    };
  }
  return {
    itemId: row.item.itemId,
    type: "checkpoint",
    labelKey: MARK_LABEL_KEY.checkpoint,
    preview: "",
    previewKey: "conversation.minimapCheckpointPreview",
    turn,
  };
}

const assistantRunCache = new WeakMap<
  Extract<TimelineRow, { type: "assistant" }>,
  { readonly members: readonly Extract<TimelineRow, { type: "assistant" }>[]; readonly mark: MinimapMark }
>();

function markForAssistantRun(
  members: readonly Extract<TimelineRow, { type: "assistant" }>[],
  turn: number,
): MinimapMark {
  if (members.length === 1) return markForRow(members[0]!, turn);
  const first = members[0]!;
  const cached = assistantRunCache.get(first);
  if (
    cached !== undefined
    && cached.mark.turn === turn
    && cached.members.length === members.length
    && cached.members.every((member, index) => member === members[index])
  ) {
    return cached.mark;
  }
  const type = assistantMarkType(members);
  const segments = members.flatMap((row) => row.segments);
  const mark: MinimapMark = {
    itemId: first.itemId,
    type,
    labelKey: MARK_LABEL_KEY[type],
    preview: assistantPreview(segments),
    turn,
  };
  assistantRunCache.set(first, { members, mark });
  return mark;
}

function markForRow(row: TimelineRow, turn: number): MinimapMark {
  const cached = markCache.get(row);
  if (cached !== undefined) {
    if (cached.turn === turn) return cached;
    /* 前插一页后所有 turn 都会平移；改写缓存，避免此后每帧都复制一次。 */
    const shifted = { ...cached, turn };
    markCache.set(row, shifted);
    return shifted;
  }
  const mark = buildMark(row, turn);
  markCache.set(row, mark);
  return mark;
}

/** 与 transcript DOM 对齐：连续 assistant 行由 AssistantRunView 合成一个导航点。 */
export function deriveMinimapMarks(rows: readonly TimelineRow[]): MinimapMark[] {
  const marks: MinimapMark[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    const turn = marks.length + 1;
    if (row.type !== "assistant") {
      marks.push(markForRow(row, turn));
      index += 1;
      continue;
    }
    const members: Array<Extract<TimelineRow, { type: "assistant" }>> = [];
    while (index < rows.length && rows[index]!.type === "assistant") {
      members.push(rows[index] as Extract<TimelineRow, { type: "assistant" }>);
      index += 1;
    }
    marks.push(markForAssistantRun(members, turn));
  }
  return marks;
}

/** 全部圆点都沿用旧对象时返回旧数组，让下游 useMemo 一起短路。 */
function reuseMarks(previous: readonly MinimapMark[], next: readonly MinimapMark[]): readonly MinimapMark[] {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return next;
  }
  return previous;
}

/** 圆点位置变化小于这个比例就不重渲染轨道（约等于 500px 轨道上的 1px）。 */
const FRACTION_EPSILON = 0.002;

function fractionsShifted(previous: MarkFractions, next: MarkFractions): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return true;
  for (const key of nextKeys) {
    const before = previous[key];
    if (before === undefined) return true;
    if (Math.abs(before - next[key]!) > FRACTION_EPSILON) return true;
  }
  return false;
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
    /* Scan only the cluster. `entries.findIndex` restarts at 0 every time, so
       on a full 2,000-mark window the two lookups together walk tens of
       thousands of entries per call. */
    let chosen = -1;
    for (let k = i; k <= j; k++) { if (entries[k]!.mark.type === "error") { chosen = k; break; } }
    if (chosen < 0) { for (let k = i; k <= j; k++) { if (PRIORITY_TYPES.has(entries[k]!.mark.type)) { chosen = k; break; } } }
    if (chosen >= 0) pick = chosen;
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
    if (
      types.includes(candidate.type)
      || candidate.navigationTypes?.some((type) => types.includes(type)) === true
    ) return candidate;
  }
  return null;
}

/** 跳转后等目标行被虚拟列表挂载的最长时间。平滑滚动通常几百毫秒内到点到行。 */
const JUMP_FLASH_TIMEOUT_MS = 1_500;

/**
 * 等 `itemId` 对应的行出现在 scroller 里，出现后高亮。
 *
 * 返回取消函数；组件里的 ref 同时只保留一个（新跳转覆盖旧等待）。没有
 * MutationObserver 的环境退化为一次 rAF 复查。
 */
function watchForMountedRow(scroller: HTMLElement, itemId: string, flash: (node: HTMLElement) => void): () => void {
  const selector = `[data-item-id="${cssEscape(itemId)}"]`;
  const flashIfMounted = (): boolean => {
    const node = scroller.querySelector<HTMLElement>(selector);
    if (node === null) return false;
    flash(node);
    return true;
  };
  if (flashIfMounted()) return () => undefined;
  let observer: MutationObserver | null = null;
  let timer: number | null = null;
  let frame = 0;
  const stop = () => {
    observer?.disconnect();
    observer = null;
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
  };
  timer = window.setTimeout(stop, JUMP_FLASH_TIMEOUT_MS);
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(() => {
      if (flashIfMounted()) stop();
    });
    observer.observe(scroller, { childList: true, subtree: true });
  } else if (typeof requestAnimationFrame === "function") {
    /* 一行代码路径：无 MutationObserver 时退化为下一帧复查一次。 */
    frame = requestAnimationFrame(() => { if (flashIfMounted()) stop(); });
  }
  return stop;
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
  busy,
  onNavigateStart,
  onJumpToLatest,
}: {
  rows: readonly TimelineRow[];
  scrollerRef: RefObject<HTMLElement | null>;
  preview?: boolean;
  /** 主线程正忙（默认按尾行是否在流式产出判定）：降低重测频率。 */
  busy?: boolean;
  /** Any minimap navigation detaches transcript tail-follow before scrolling. */
  onNavigateStart?: () => void;
  /** Re-enter the transcript's canonical tail-follow path. */
  onJumpToLatest?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const filterWrapRef = useRef<HTMLSpanElement | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  /** 跳转后等待目标行挂载的取消函数（虚拟列表只挂载窗口内的行）。 */
  const jumpWatchRef = useRef<(() => void) | null>(null);
  /** 拖动进行中：滚动事件里的强制重测被降级（见 onScroll），拖动结束补一次。 */
  const draggingRef = useRef(false);

  const { t } = useI18n();
  const { marks: previewMarks } = usePreviewMode();
  const [fractions, setFractions] = useState<MarkFractions>({});
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [keyOnly, setKeyOnly] = useState(false);
  /**
   * Roving tabindex：整条轨道只占一个 Tab 停靠点。
   *
   * 圆点都是 <button>，长会话里可达几十个；逐个停靠会让键盘用户按下 Tab 后
   * 被卡在轨道里。轨道内用 ↑/↓（或 Home/End）在圆点间移动，Tab 直接离开轨道。
   * `-1` 表示还没进过轨道，此时第一个圆点承担停靠点。
   */
  const [focusIndex, setFocusIndex] = useState(-1);

  const prevMarksRef = useRef<readonly MinimapMark[]>([]);
  /**
   * 依赖结构令牌而不是 `rows` 身份。
   *
   * 流式期间 store 每帧都要把持久化前缀和活跃尾部拼成一个新数组（`rows` 身份必然变），
   * 而圆点只由行的类型/导航元数据决定，纯文本增量改不动任何一个 mark。挂在 `rows` 上
   * 等于每个发布帧都对全量 rows 走一遍 `deriveMinimapMarks` 并分配一个满长度数组，
   * 长会话下就是每秒几十万次操作压在主线程上。`ConvoTranscript` 的几个 memo 早就
   * 是这么做的。
   *
   * `hasError` / `hasUser` 顺便在同一次遍历里算出来，省掉两次全量 `some`。
   */
  const structureToken = timelineStructureToken(rows);
  const derived = useMemo(() => {
    const next = reuseMarks(prevMarksRef.current, deriveMinimapMarks(rows));
    let hasError = false;
    let hasUser = false;
    for (const mark of next) {
      if (mark.type === "error") hasError = true;
      if (mark.type === "user" || mark.navigationTypes?.includes("user") === true) hasUser = true;
      if (hasError && hasUser) break;
    }
    return { marks: next, hasError, hasUser };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 结构令牌代表 rows 的内容版本
  }, [structureToken]);
  const marks = derived.marks;
  prevMarksRef.current = marks;
  /* Refs mirror committed state, never a render that may be thrown away: React
     19 can abandon a render, and an imperative `measureNow`/`syncActiveMark`
     reading `marksRef` would then measure a dot set that never reached the DOM
     (stale anchors, an active id with no element). Same for `busy`. */
  const marksRef = useRef(marks);
  const fractionsRef = useRef(fractions);
  /** 回调要保持同一身份（RO / scroll 监听都按它建），所以忙碌标记走 ref 而不是闭包。 */
  const busyRef = useRef(false);
  useLayoutEffect(() => {
    marksRef.current = marks;
    fractionsRef.current = fractions;
    busyRef.current = busy ?? tailStreaming(rows);
  });

  /**
   * 视口指示条：两次读 + 两次写。写之前先比对缓存值，相同则跳过——每个 setAttribute
   * / style 写入都是一轮样式失效，流式跟随期间 60Hz 全量写会让每帧凭空多出 2-3 轮
   * RecalcStyle（实测峰值 310 次/秒的主因之一）。
   *
   * 缓存量按数值保存（不是格式化后的字符串）：只有真的要写时才拼 `px` / 整数字符串，
   * 命中缓存时不再为每个指标分配字符串。
   */
  const viewportWriteRef = useRef({ max: -1, now: -1, hidden: false, height: -1, top: -1 });
  const syncViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!scroller || !viewport || !track) return;
    const cache = viewportWriteRef.current;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const range = Math.max(0, track.clientHeight - TOOLS_RESERVE_PX);
    const maxValue = Math.round(maxScroll);
    if (cache.max !== maxValue) {
      cache.max = maxValue;
      viewport.setAttribute("aria-valuemax", String(maxValue));
    }
    const nowValue = Math.round(Math.min(maxScroll, Math.max(0, scroller.scrollTop)));
    if (cache.now !== nowValue) {
      cache.now = nowValue;
      viewport.setAttribute("aria-valuenow", String(nowValue));
    }
    const hidden = maxScroll <= 0;
    if (cache.hidden !== hidden) {
      cache.hidden = hidden;
      viewport.style.display = hidden ? "none" : "";
    }
    if (hidden) return;
    /* 量化到 0.5px：浮点量每帧都会变，逐位比较等于「每次都写」，反而丢掉缓存的意义。 */
    const quantize = (value: number): number => Math.round(value * 2) / 2;
    const viewportH = quantize(range > 0
      ? Math.min(range, Math.max(MIN_VIEWPORT_H, (scroller.clientHeight / scroller.scrollHeight) * range))
      : MIN_VIEWPORT_H);
    const progress = Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
    const top = quantize(range > viewportH ? progress * (range - viewportH) : 0);
    if (cache.height !== viewportH) {
      cache.height = viewportH;
      viewport.style.height = `${viewportH}px`;
    }
    if (cache.top !== top) {
      cache.top = top;
      viewport.style.top = `${top}px`;
    }
  }, [scrollerRef]);

  /**
   * 圆点位置。原实现对每个圆点做一次 `scroller.querySelector`（每次全子树遍历，
   * 总体 O(行数²)）再读一次 rect；这里改为一次 querySelectorAll + 单批 rect 读，
   * 并在「圆点集合未变且 scrollHeight 未变」时整体跳过：流式的多数 chunk 不改变
   * 文档高度，此时完全不碰布局。
   *
   * 插值锚点持久化：虚拟列表只挂载窗口内的行，窗口外的圆点要在锚点之间插值。
   * 若锚点只取「当前挂载」的行，窗口随滚动移动时锚点集跟着变，同一个圆点的插值
   * 结果每次重测都不同——表现为滚动期间圆点上下漂移，且每次重测都触发整条轨道
   * 重渲染（滚动中周期性卡一下）。这里把实测过的行中心（绝对像素偏移）累积在
   * 缓存里，插值永远在「最近两个已实测锚点」之间进行：窗口怎么移，已定分数不
   * 变，重复重测被 `fractionsShifted` 整体短路。圆点集合增删（新行、翻页）或
   * 文档高度变化（流式增长、卡片展开）时缓存失效，回到逐窗重建。
   */
  const measuredRef = useRef<{ readonly marks: readonly MinimapMark[]; readonly scrollHeight: number } | null>(null);
  const anchorCacheRef = useRef<{ centers: Map<string, number>; marksKey: string; scrollHeight: number }>({
    centers: new Map(),
    marksKey: "",
    scrollHeight: -1,
  });
  const lastMeasureAtRef = useRef(Number.NEGATIVE_INFINITY);
  const measureTimerRef = useRef<number | null>(null);
  const forceMeasureRef = useRef(false);
  /** 返回 true 表示完成了测量但没有触发 fractions state；调用方应就地同步活跃点。
   *  返回 false 时要么跳过，要么新的 fractions 会在下面的 effect 中同步活跃点。 */
  const measureNow = useCallback((force = false): boolean => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    const scrollHeight = scroller.scrollHeight;
    if (scrollHeight <= 0) return false;
    const current = marksRef.current;
    const measured = measuredRef.current;
    if (!force && measured !== null && measured.marks === current && measured.scrollHeight === scrollHeight) return false;
    measuredRef.current = { marks: current, scrollHeight };
    lastMeasureAtRef.current = now();
    if (current.length === 0) {
      if (Object.keys(fractionsRef.current).length > 0) {
        setFractions({});
        return false;
      }
      return true;
    }
    /* 锚点缓存的失效键。
       只取「长度 + 首 + 尾」会漏掉中间插入/替换：compaction 完成把尾部的
       compacting 行换成 compaction 行、翻页把中间一段换掉，长度与首尾都可能不变，
       而缓存里的绝对像素中心已经对错了行。取中位 id 让这类变化也命中；真正的
       像素变化（卡片展开、字号、宽度）已由 scrollHeight 容差覆盖。 */
    const middle = current[current.length >> 1]!.itemId;
    const marksKey = `${current.length}:${current[0]!.itemId}:${middle}:${current[current.length - 1]!.itemId}`;
    const anchorCache = anchorCacheRef.current;
    if (anchorCache.marksKey !== marksKey || Math.abs(anchorCache.scrollHeight - scrollHeight) > 2) {
      anchorCache.centers.clear();
      anchorCache.marksKey = marksKey;
    }
    anchorCache.scrollHeight = scrollHeight;
    const wanted = new Set<string>();
    for (const mark of current) wanted.add(mark.itemId);
    const base = scroller.getBoundingClientRect().top;
    const scrollTop = scroller.scrollTop;
    /* Virtualized transcripts only mount a small viewport window, so most marks
       have no DOM node to measure. Measure the mounted ones into the persistent
       anchor cache, then interpolate the rest between cached measurements — one
       coordinate system, and the sequence stays monotonic. Seeding unmounted
       marks with `index / count` instead mixes row-index space into pixel space:
       dots jump as the mounted window moves, and `spaceMinimapMarks` (which
       walks forward assuming ascending order) starts clustering the wrong
       neighbours. */
    for (const node of scroller.querySelectorAll<HTMLElement>("[data-item-id]")) {
      const key = node.dataset.itemId;
      /* 第一个匹配节点胜出，与原来的 querySelector 语义一致。 */
      if (key === undefined || !wanted.has(key) || anchorCache.centers.has(key)) continue;
      const rect = node.getBoundingClientRect();
      const center = rect.top - base + scrollTop + rect.height / 2;
      anchorCache.centers.set(key, center);
    }
    const anchors: Array<{ index: number; fraction: number }> = [];
    for (let index = 0; index < current.length; index += 1) {
      const center = anchorCache.centers.get(current[index]!.itemId);
      if (center !== undefined) anchors.push({ index, fraction: center / scrollHeight });
    }
    const next: Record<string, number> = {};
    const clamp = (value: number): number => Math.round(Math.min(0.985, Math.max(0.015, value)) * 10000) / 10000;
    if (anchors.length === 0) {
      const denominator = Math.max(1, current.length - 1);
      for (let index = 0; index < current.length; index += 1) next[current[index]!.itemId] = clamp(index / denominator);
    } else {
      let cursor = 0;
      for (let index = 0; index < current.length; index += 1) {
        while (cursor + 1 < anchors.length && anchors[cursor + 1]!.index <= index) cursor += 1;
        const low = anchors[cursor]!;
        const high = anchors[cursor + 1];
        let fraction: number;
        if (index === low.index) fraction = low.fraction;
        else if (index < low.index) fraction = low.fraction * (index + 1) / (low.index + 1);
        else if (high !== undefined) fraction = low.fraction + (high.fraction - low.fraction) * ((index - low.index) / (high.index - low.index));
        else fraction = low.fraction + (1 - low.fraction) * ((index - low.index) / Math.max(1, current.length - low.index));
        next[current[index]!.itemId] = clamp(fraction);
      }
    }
    if (!fractionsShifted(fractionsRef.current, next)) return true;
    setFractions(next);
    return false;
  }, [scrollerRef]);

  /**
   * 活跃圆点由内容视口中线决定；只使用 scroll metrics，不逐点读正文 rect。
   *
   * 命中同一个圆点时直接返回（O(1)）：滚动事件每帧都调它，流式贴底时绝大多数
   * 节拍活跃点不变，整条轨道无需遍历。`activeElRef` 记住当前高亮的元素，DOM 被
   * React 重渲染换掉（筛选、圆点集合变化）时 `isConnected` 失效，走完整路径。
   */
  const activeElRef = useRef<HTMLElement | null>(null);
  const syncActiveMark = useCallback(() => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    const next = activeMarkId(marksRef.current, fractionsRef.current, {
      trackHeight: track.clientHeight,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      scrollerHeight: scroller.clientHeight,
    });
    const currentEl = activeElRef.current;
    if (next === activeIdRef.current && currentEl?.isConnected === true && currentEl.classList.contains("active")) return;
    activeElRef.current = applyActiveMark(track, next);
    activeIdRef.current = next;
  }, [scrollerRef]);

  const measureAndSyncActive = useCallback((force = false): boolean => {
    const syncNow = measureNow(force);
    if (syncNow) syncActiveMark();
    return syncNow;
  }, [measureNow, syncActiveMark]);

  /**
   * 全量重测的节流闸门。`measureNow` 的跳过条件是「圆点集合与 scrollHeight 都没
   * 变」，而工具卡展开/收起的每一帧都在改 scrollHeight，流式的每一帧都在换尾行
   * 圆点——两者都会让闸门失效，于是每帧都要做一次全子树 `querySelectorAll` + 逐
   * 节点 rect + 最多 2000 个圆点的 `setFractions`（再带出一次 minimap 全量重渲染
   * 与 `spaceMinimapMarks`）。圆点位置是导航用的近似量，落后一帧看不出来，所以限
   * 频到 `MEASURE_INTERVAL_MS`（流式期间进一步放宽到
   * `MEASURE_INTERVAL_STREAMING_MS`）：第一次变化立刻测，随后的变化合并成一次尾随
   * 重测，动画/流式结束后必然还有最后一次收敛。
   *
   * 返回值表示「这次调用是否真的测了」，让调用方据此决定要不要顺带跑活跃点判定。
   */
  const requestMeasure = useCallback((force = false): boolean => {
    if (force) forceMeasureRef.current = true;
    const interval = busyRef.current ? MEASURE_INTERVAL_STREAMING_MS : MEASURE_INTERVAL_MS;
    const elapsed = now() - lastMeasureAtRef.current;
    if (elapsed >= interval) {
      const forced = forceMeasureRef.current;
      forceMeasureRef.current = false;
      return measureAndSyncActive(forced);
    }
    if (measureTimerRef.current !== null) return false;
    measureTimerRef.current = window.setTimeout(() => {
      measureTimerRef.current = null;
      const forced = forceMeasureRef.current;
      forceMeasureRef.current = false;
      measureAndSyncActive(forced);
    }, interval - elapsed);
    return false;
  }, [measureAndSyncActive]);
  useEffect(
    () => () => {
      if (measureTimerRef.current !== null) window.clearTimeout(measureTimerRef.current);
    },
    [],
  );

  /** 内容变化只更新视口条并申请受闸门控制的测量/活跃点同步。 */
  const syncAll = useCallback(() => {
    requestMeasure();
    syncViewport();
  }, [requestMeasure, syncViewport]);

  const frameRef = useRef<number | null>(null);
  const scheduleSync = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") {
      syncAll();
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncAll();
    });
  }, [syncAll]);

  useEffect(
    () => () => {
      if (frameRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  /* 行变化：同步测一次（`requestMeasure` 自带「未变则跳过」与限频两道闸门）。 */
  useLayoutEffect(() => {
    syncAll();
  }, [rows, syncAll]);

  /* 内容高度变化（流式增长、工具展开、窗口缩放）：RO 只建一次，回调按帧合并。 */
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const scroller = scrollerRef.current;
    const doc = scroller?.querySelector(".convo-doc") ?? scroller?.firstElementChild ?? null;
    const observer = new ResizeObserver(() => {
      scheduleSync();
    });
    if (scroller) observer.observe(scroller);
    if (doc) observer.observe(doc);
    if (trackRef.current) observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [scheduleSync, scrollerRef]);

  /* 虚拟列表在滚动时会换挂载窗口：同步视口/活跃点，并节流重建位置锚点。
     拖动期间把强制重测降级为普通档：拖动的每一帧都在改 scrollTop，force 会旁路
     measureNow 的「未变则跳过」闸门，等于每过一个间隔就做一次全子树
     querySelectorAll + 逐行 rect + setFractions 重渲染，正压在流式最忙的主线程上；
     拖动结束后（pointerup）再补一次强制重测收敛圆点。 */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    /* 流式跟随期间滚动事件≈每帧一条（贴底跟随每帧写 scrollTop）。视口条/活跃点的
       DOM 更新降到 ~10Hz：60Hz 的滑块位移肉眼无感，但每帧的写入都会在 React 提交
       之后又触发一轮样式重算（每帧多轮 RecalcStyle 的主因之一）；非流式时保持逐事件
       即时同步。尾随定时器保证最后一次滚动位置总会落地。 */
    const STREAM_SYNC_INTERVAL_MS = 100;
    let lastSyncAt = 0;
    let trailing: number | null = null;
    const run = () => {
      lastSyncAt = Date.now();
      syncViewport();
      syncActiveMark();
      requestMeasure(!draggingRef.current);
    };
    const onScroll = () => {
      if (!busyRef.current) {
        run();
        return;
      }
      const elapsed = Date.now() - lastSyncAt;
      if (elapsed >= STREAM_SYNC_INTERVAL_MS) {
        if (trailing !== null) { window.clearTimeout(trailing); trailing = null; }
        run();
        return;
      }
      if (trailing !== null) return;
      trailing = window.setTimeout(() => {
        trailing = null;
        run();
      }, STREAM_SYNC_INTERVAL_MS - elapsed);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(onScroll) : null;
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (trailing !== null) window.clearTimeout(trailing);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [requestMeasure, syncActiveMark, syncViewport, scrollerRef]);

  const filtered = useMemo(
    () => (keyOnly ? marks.filter((mark) => KEY_TYPES.includes(mark.type)) : marks),
    [marks, keyOnly],
  );
  const visible = useMemo(() => spaceMinimapMarks(filtered, fractions), [filtered, fractions]);
  const hoveredMark = hoveredItemId === null ? null : visible.find((mark) => mark.itemId === hoveredItemId) ?? null;

  /**
   * 圆点集合变化后重新落一次活跃点。
   *
   * `.active` / `aria-current` 是命令式写在 DOM 上的，而圆点由 React 渲染。普通
   * 重渲染不会碰它们（className 字符串没变，React 不写 DOM），但被筛掉的圆点会
   * 连同元素一起卸载、切回来时是全新节点——活跃点恰好被筛掉的那一次，高亮就
   * 随元素一起没了。`visible` 的每次变化都覆盖这个场景。
   *
   * 不挂在「每次提交」上：那会在流式期间每帧多出几次布局读，而这几类重渲染
   * 本身不会抹掉命令式写入的 class。
   */
  useLayoutEffect(() => {
    syncActiveMark();
  }, [visible, syncActiveMark]);

  const jumpTo = useCallback(
    (itemId: string) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      onNavigateStart?.();
      const node = scroller.querySelector<HTMLElement>(`[data-item-id="${cssEscape(itemId)}"]`);
      if (node) {
        scrollRowInScroller(scroller, node);
        flashRow(node);
        return;
      }
      const fraction = fractionsRef.current[itemId];
      if (fraction === undefined) return;
      /* `fraction` is the row's centre over the full content height, so convert
         through `scrollHeight` and then centre it — treating it as a fraction of
         the scrollable range instead overshoots by up to a viewport. */
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const top = Math.max(0, Math.min(maxScroll, fraction * scroller.scrollHeight - scroller.clientHeight / 2));
      scroller.scrollTo({ behavior: "smooth", top });
      /* 虚拟列表只挂载窗口内的行：目标行要等平滑滚动把它带进窗口才出现。
         这里用 MutationObserver 等它出现，而不是每帧 rAF 轮询 querySelector
         （1 秒 × 60 帧的全子树查询，恰好压在跳转引发的布局最忙的时段）。
         超时兜底用 setTimeout，挂载后立刻断开。 */
      jumpWatchRef.current?.();
      jumpWatchRef.current = watchForMountedRow(scroller, itemId, flashRow);
    },
    [onNavigateStart, scrollerRef],
  );

  useEffect(
    () => () => {
      jumpWatchRef.current?.();
      jumpWatchRef.current = null;
    },
    [],
  );

  const jumpToNext = useCallback(
    (types: readonly MinimapMarkType[]) => {
      const target = pickNextMark(marks, activeIdRef.current, types);
      if (target) jumpTo(target.itemId);
    },
    [marks, jumpTo],
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

  /**
   * 键盘路径必须和鼠标路径一样先撤销待隐藏定时器。
   *
   * `onBlur` 会排一个 250ms 的隐藏；焦点从一个圆点直接移到下一个时，前一个圆点
   * 的定时器仍在跑，会在新圆点的预览出现后把它关掉。鼠标没事只是因为
   * `onMouseEnter` 调了 `cancelHide()`。
   */
  const showPreview = useCallback((itemId: string) => {
    cancelHide();
    setHoveredItemId(itemId);
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);

  /* 圆点稳定回调。`MinimapDot` 是 memo 组件，内联箭头函数会让每个点每个节拍
     都重新渲染；这些回调只依赖 ref 与稳定引用，不需要 `visible`/`fractions`。 */
  const onMarkClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    jumpTo(event.currentTarget.dataset.markId ?? "");
  }, [jumpTo]);
  const onMarkEnter = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const itemId = event.currentTarget.dataset.markId;
    if (itemId !== undefined) showPreview(itemId);
  }, [showPreview]);
  const onMarkFocus = useCallback((event: ReactFocusEvent<HTMLButtonElement>) => {
    const itemId = event.currentTarget.dataset.markId;
    if (itemId === undefined) return;
    showPreview(itemId);
    /* 记下停靠点：离开轨道再回来时焦点回到同一个圆点，而不是始终第一个。 */
    const track = trackRef.current;
    const index = track === null ? -1 : Array.from(track.querySelectorAll<HTMLElement>(".mm-mark")).indexOf(event.currentTarget);
    if (index >= 0) setFocusIndex(index);
  }, [showPreview]);
  const onMarkEscape = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setHoveredItemId(null);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    /* 在轨道内移动焦点；与菜单同一套方向键语义。 */
    const track = trackRef.current;
    if (track === null) return;
    const dots = Array.from(track.querySelectorAll<HTMLElement>(".mm-mark"));
    if (dots.length === 0) return;
    const index = dots.indexOf(event.currentTarget);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? dots.length - 1
      : event.key === "ArrowDown" ? Math.min(dots.length - 1, index + 1)
      : Math.max(0, index - 1);
    event.preventDefault();
    dots[nextIndex]?.focus();
  }, []);

  /* 菜单：两个按钮都必须把焦点还给触发按钮。选完菜单项时菜单卸载，焦点若留在
     被移除的节点上会掉到 <body>，下一次 Tab 从页面顶部重新开始。Escape 与选择
     走同一条路径。 */
  const closeMenu = useCallback(() => {
    setFilterOpen(false);
    filterButtonRef.current?.focus();
  }, []);

  /** 菜单键盘导航：↑/↓ 在可用项之间移动，Escape 关闭并还焦点。 */
  const onMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
    if (items.length === 0) return;
    event.preventDefault();
    const active = document.activeElement;
    const index = items.findIndex((item) => item === active);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length
      : index <= 0 ? items.length - 1 : index - 1;
    items[nextIndex]?.focus();
  }, [closeMenu]);

  /* 打开菜单时把焦点送进第一个**可用**项：`aria-haspopup="menu"` 之后菜单必须以键盘
     可用，而首项在没有错误时是禁用的——focus() 落在 disabled 按钮上是空操作，
     焦点会留在触发按钮、方向键却已不再作用于按钮，等于键盘用户进不了菜单。 */
  useEffect(() => {
    if (!filterOpen) return;
    const first = filterWrapRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
    first?.focus();
  }, [filterOpen]);

  /**
   * 滚轮转发给对话。
   *
   * `.minimap` 是覆盖在 `.convo-scroll` 之上的定位兄弟（z-index 10），滚轮打在
   * 36px 轨道上时事件目标是 minimap，而 `.app-body` / `.app-shell` 都是
   * `overflow: clip`，祖先谁都不会滚——光标停在左侧导航条上就丢失滚动。
   * 这里把同一段 delta 交给 scroller；`scrollTop` 的写入会像真实滚动一样触发
   * scroll 事件，视口条 / 活跃点 / 贴底脱离都走既有路径。
   *
   * 必须用原生监听器（`passive: false`）：React 的 `onWheel` 在根容器上是
   * passive 注册的，`preventDefault()` 不生效。Ctrl/⌘ + 滚轮（缩放）与
   * 横向 delta 放行。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.deltaY === 0) return;
      const scroller = scrollerRef.current;
      if (scroller === null) return;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (maxScroll <= 0) return;
      event.preventDefault();
      /* `deltaMode` 1 = lines, 2 = pages。缩放到 CSS px，避免行模式在长会话里只挪几像素。 */
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop = Math.min(maxScroll, Math.max(0, scroller.scrollTop + event.deltaY * unit));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [scrollerRef]);

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

  /* 轨道空白处：拖动 = 按比例即时滚动；原处松开 = 平滑滚到点击比例。
     pointermove 以输入设备频率到达（高回报鼠标远高于帧率），此前每个事件都做
     「读 rect → 写 scrollTop → syncViewport 读回」，写在读后，流式期间布局每帧
     都是脏的，等于把一帧的全量布局按事件次数重复付费。现在合并到 rAF、每帧至多
     一次，且把全部读放在写之前；视口条与活跃点交给滚动事件路径每帧同步一次。 */
  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".mm-mark")) return;
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    event.preventDefault();
    onNavigateStart?.();
    track.setPointerCapture?.(event.pointerId);
    const startY = event.clientY;
    let moved = false;
    let pendingY = startY;
    let frame: number | null = null;
    draggingRef.current = true;
    const apply = (clientY: number, smooth: boolean) => {
      const rect = track.getBoundingClientRect();
      const range = Math.max(1, track.clientHeight - TOOLS_RESERVE_PX);
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / range));
      const target = ratio * maxScroll;
      if (smooth) scroller.scrollTo({ top: target, behavior: "smooth" });
      else scroller.scrollTop = target;
    };
    const flush = () => {
      frame = null;
      if (moved) apply(pendingY, false);
    };
    const schedule = () => {
      if (frame !== null) return;
      if (typeof requestAnimationFrame !== "function") {
        flush();
        return;
      }
      frame = requestAnimationFrame(flush);
    };
    const settle = () => {
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", finish);
      track.removeEventListener("pointercancel", cancel);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      frame = null;
      draggingRef.current = false;
      syncViewport();
      syncActiveMark();
      requestMeasure(true);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientY - startY) > 3) moved = true;
      if (!moved) return;
      pendingY = moveEvent.clientY;
      schedule();
    };
    const finish = (upEvent: PointerEvent) => {
      if (!moved) apply(upEvent.clientY, true);
      settle();
    };
    const cancel = () => {
      if (moved && frame !== null) flush();
      settle();
    };
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", finish);
    track.addEventListener("pointercancel", cancel);
  };

  /* 视口条：滑块语义，拖动保持抓取偏移；同样按帧合并、读前置。
     滑块位置在拖动期间直接由拖动几何写出（不读回 scroller），scroll 事件里的
     syncViewport 每帧会用真实 metrics 再对齐一次。 */
  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    const viewport = viewportRef.current;
    if (!scroller || !track || !viewport) return;
    event.preventDefault();
    event.stopPropagation();
    onNavigateStart?.();
    viewport.setPointerCapture?.(event.pointerId);
    const grab = event.clientY - viewport.getBoundingClientRect().top;
    let pendingY = event.clientY;
    let frame: number | null = null;
    draggingRef.current = true;
    const flush = () => {
      frame = null;
      const trackTop = track.getBoundingClientRect().top;
      const sliderSpan = track.clientHeight - TOOLS_RESERVE_PX - viewport.offsetHeight;
      if (sliderSpan <= 0) return;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const top = Math.min(Math.max(0, pendingY - grab - trackTop), sliderSpan);
      scroller.scrollTop = (top / sliderSpan) * maxScroll;
      viewport.style.top = `${top}px`;
    };
    const schedule = () => {
      if (frame !== null) return;
      if (typeof requestAnimationFrame !== "function") {
        flush();
        return;
      }
      frame = requestAnimationFrame(flush);
    };
    const settle = () => {
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", settle);
      viewport.removeEventListener("pointercancel", settle);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      frame = null;
      draggingRef.current = false;
      syncViewport();
      syncActiveMark();
      requestMeasure(true);
    };
    const onMove = (moveEvent: PointerEvent) => {
      pendingY = moveEvent.clientY;
      schedule();
    };
    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerup", settle);
    viewport.addEventListener("pointercancel", settle);
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

  const onViewportKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    let top: number | null = null;
    if (event.key === "ArrowUp") top = scroller.scrollTop - 40;
    else if (event.key === "ArrowDown") top = scroller.scrollTop + 40;
    else if (event.key === "PageUp") top = scroller.scrollTop - scroller.clientHeight * 0.9;
    else if (event.key === "PageDown") top = scroller.scrollTop + scroller.clientHeight * 0.9;
    else if (event.key === "Home") top = 0;
    else if (event.key === "End") top = maxScroll;
    if (top === null) return;
    event.preventDefault();
    event.stopPropagation();
    onNavigateStart?.();
    scroller.scrollTop = Math.min(maxScroll, Math.max(0, top));
    syncViewport();
    syncActiveMark();
  };

  const hasError = derived.hasError;
  const hasUser = derived.hasUser;

  return (
    <div className="minimap" id="minimap" ref={rootRef}>
      <div className="minimap-track" id="mmTrack" ref={trackRef} onPointerDown={onTrackPointerDown}>
        <span className="mm-rail" aria-hidden="true" />
        {visible.map((mark, index) => {
          const fraction = fractions[mark.itemId];
          return (
            <MinimapDot
              key={mark.itemId}
              itemId={mark.itemId}
              type={mark.type}
              label={t("conversation.minimapMarkLabel", { turn: mark.turn, label: t(mark.labelKey) })}
              {...(fraction === undefined
                ? {}
                : { top: `calc(${(fraction * 100).toFixed(2)}% - ${(fraction * TOOLS_RESERVE_PX).toFixed(1)}px)` })}
              onClick={onMarkClick}
              onEnter={onMarkEnter}
              onFocus={onMarkFocus}
              onLeave={scheduleHide}
              onEscape={onMarkEscape}
              /* `focusIndex` 指向旧集合时（筛选后变短）回落到第一项，
                 否则整条轨道会没有任何 Tab 停靠点。 */
              tabbable={index === (focusIndex >= 0 && focusIndex < visible.length ? focusIndex : 0)}
            />
          );
        })}
        {keyOnly && visible.length === 0 && marks.length > 0 ? (
          /* 筛选后一个圆点都不剩时给出原因：否则轨道是空的，用户只会以为坏了。 */
          <span className="mm-empty-filter">{t("conversation.minimapNoKeyMarks")}</span>
        ) : null}
      </div>
      <div
        className="mm-viewport"
        id="mmViewport"
        ref={viewportRef}
        role="scrollbar"
        tabIndex={0}
        aria-label={t("conversation.minimapScrollPosition")}
        aria-controls="convoScroll"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={0}
        aria-valuenow={0}
        onPointerDown={onViewportPointerDown}
        onKeyDown={onViewportKeyDown}
      />
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
            #{String(hoveredMark.turn).padStart(2, "0")} · {t(hoveredMark.labelKey)}
            {preview && previewMarks ? <span className="mp-demo">{t("conversation.minimapDemo")}</span> : null}
          </div>
          {hoveredMark.previewKey !== undefined ? (
            <div className="mp-user">{t(hoveredMark.previewKey)}</div>
          ) : hoveredMark.previewError === true ? (
            <div className="mp-user">{t("conversation.minimapSendFailed", { error: hoveredMark.preview })}</div>
          ) : hoveredMark.preview ? (
            <div className="mp-user">{hoveredMark.preview}</div>
          ) : (
            <div className="mp-empty">{t("conversation.minimapEmptyPreview")}</div>
          )}
        </div>
      ) : null}
      <div className="minimap-tools">
        <span ref={filterWrapRef}>
          <button
            ref={filterButtonRef}
            type="button"
            className="icon-btn"
            data-tip={keyOnly ? t("conversation.minimapKeyOnly") : t("conversation.minimapFilter")}
            aria-label={t("conversation.minimapFilterEvents")}
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilterOpen(false);
            }}
          >
            <Icon name="filter" extra="sm" />
          </button>
          {filterOpen ? (
            <div className="menu mm-menu" role="menu" aria-label={t("conversation.minimapMenuLabel")} onKeyDown={onMenuKeyDown}>
              <div className="menu-label">{t("conversation.minimapMenuLabel")}</div>
              <button type="button" className="menu-item" role="menuitem" disabled={!hasError} onClick={() => {
                closeMenu();
                jumpToNext(["error"]);
              }}>
                <Icon name="alert" extra="sm" />
                {t("conversation.minimapJumpNextError")}
              </button>
              <button type="button" className="menu-item" role="menuitem" disabled={!hasUser} onClick={() => {
                closeMenu();
                jumpToNext(["user"]);
              }}>
                <Icon name="message" extra="sm" />
                {t("conversation.minimapJumpNextUser")}
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={keyOnly}
                onClick={() => setKeyOnly((only) => !only)}
              >
                <Icon name={keyOnly ? "eye" : "filter" } extra="sm" />
                {keyOnly ? t("conversation.minimapShowAll") : t("conversation.minimapShowKeyOnly")}
              </button>
            </div>
          ) : null}
        </span>
        <button
          type="button"
          className="icon-btn"
          data-tip={t("conversation.scrollToBottom")}
          aria-label={t("conversation.scrollToBottom")}
          onClick={() => {
            if (onJumpToLatest) onJumpToLatest();
            else scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <Icon name="arrow-d" extra="sm" />
        </button>
      </div>
    </div>
  );
}

type MinimapDotProps = {
  readonly itemId: string;
  readonly type: MinimapMarkType;
  readonly label: string;
  readonly top?: string;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onEnter: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onFocus: (event: ReactFocusEvent<HTMLButtonElement>) => void;
  readonly onLeave: () => void;
  readonly onEscape: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly tabbable: boolean;
};

/**
 * 单个圆点。memo 让悬停/筛选等父级状态变化跳过整条轨道：
 * 长会话里 `visible` 最多几十个点，每个点一次 `t()` + style 对象分配，
 * 每个滚动节拍都重做一遍并不必要——位置只在 `top` 变化时才需要新渲染。
 *
 * `aria-current` 故意不写进 JSX：活跃点由 `applyActiveMark` 命令式维护
 * （class + 属性成对），React 再渲染一次不会把它改回去，两者不会打架。
 */
const MinimapDot = memo(function MinimapDot({
  itemId,
  type,
  label,
  top,
  onClick,
  onEnter,
  onFocus,
  onLeave,
  onEscape,
  tabbable,
}: MinimapDotProps) {
  return (
    <button
      type="button"
      data-mark-id={itemId}
      className={`mm-mark ${type}`}
      style={top === undefined ? undefined : { top }}
      aria-label={label}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onFocus}
      onBlur={onLeave}
      onKeyDown={onEscape}
      tabIndex={tabbable ? 0 : -1}
    />
  );
});

type TrackGeometry = {
  readonly trackHeight: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly scrollerHeight: number;
};

/**
 * 活跃圆点 = 离内容视口中线最近的圆点。圆点 top 由 CSS
 * `calc(f*100% - f*TOOLS_RESERVE_PX)` 给出，即 `f * (trackHeight - TOOLS_RESERVE_PX)`，
 * 内容视口中线也先换算成内容 fraction，再映射到同一轨道坐标系。
 */
export function activeMarkId(
  marks: readonly MinimapMark[],
  fractions: MarkFractions,
  geometry: TrackGeometry,
): string | null {
  if (geometry.scrollHeight <= 0) return null;
  const range = Math.max(0, geometry.trackHeight - TOOLS_RESERVE_PX);
  const centerFraction = Math.min(
    1,
    Math.max(0, (geometry.scrollTop + geometry.scrollerHeight * 0.5) / geometry.scrollHeight),
  );
  const target = centerFraction * range;
  let bestId: string | null = null;
  let bestDistance = Infinity;
  for (const mark of marks) {
    const fraction = fractions[mark.itemId];
    if (fraction === undefined) continue;
    const distance = Math.abs(fraction * range - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = mark.itemId;
    }
  }
  return bestId;
}

/** Applies the active class/attribute pair and returns the newly active element. */
function applyActiveMark(track: HTMLElement, activeId: string | null): HTMLElement | null {
  let activeEl: HTMLElement | null = null;
  for (const el of track.querySelectorAll<HTMLElement>(".mm-mark")) {
    const active = el.dataset.markId === activeId;
    el.classList.toggle("active", active);
    if (active) {
      el.setAttribute("aria-current", "true");
      activeEl = el;
    } else {
      el.removeAttribute("aria-current");
    }
  }
  return activeEl;
}
