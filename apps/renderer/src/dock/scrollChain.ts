/**
 * Wheel handoff between a dock panel body and the card column around its slot.
 *
 * Every panel body lives in a fixed host layer at the end of the document (see
 * `hosts.ts`), so the browser can never chain its scroll into the
 * `.dock-card-list` that visually wraps the slot: the two are not on the same
 * DOM ancestor chain. `overscroll-behavior` cannot help either.
 *
 * For a single wheel event this module answers one question: can the body (and
 * anything inside it) still scroll natively in this direction? If yes, nothing
 * is intercepted - native scrolling owns the event. If no, the leftover delta
 * belongs to the nearest enclosing scroller of the slot, and exactly once: the
 * caller prevents the default and applies the computed position itself, so a
 * delta is never consumed twice or amplified.
 *
 * The geometry decisions are pure functions over plain scroll boxes so they can
 * be tested without layout; the small DOM helpers only read/write pixels.
 */

/** The scroll metrics `planScroll` needs, without touching the DOM. */
export type ScrollBox = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

/** A scroll box plus the element it came from, so a plan can be applied. */
export type ScrollContainer = ScrollBox & { element: HTMLElement };

/** The parts of a `WheelEvent` that the plan depends on. */
export type WheelLike = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
};

export type ScrollPlan<T extends ScrollBox = ScrollContainer> = {
  /** True when the caller must prevent the default and apply `top`/`left`. */
  handled: boolean;
  /** Container to move, and the position to move it to. */
  target: T | null;
  top: number;
  left: number;
};

/** Wheel `deltaMode` values, named locally so the math reads as intent. */
export const PIXEL = 0;
export const LINE = 1;
export const PAGE = 2;
/** Chromium/Firefox report DOM_DELTA_LINE for classic wheels; one line is 16px. */
export const LINE_HEIGHT = 16;
/** Scroll positions are fractional on hidpi screens, so an exact edge is unusable. */
const EDGE = 1;
const SCROLLABLE = /(auto|scroll|overlay)/;

const maximum = (box: ScrollBox, axis: "x" | "y") =>
  Math.max(0, axis === "y" ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth);

/** Whether `box` still has room to move `delta` pixels along `axis`. */
export function canScroll(box: ScrollBox, axis: "x" | "y", delta: number): boolean {
  if (!delta) return false;
  const room = maximum(box, axis);
  if (room <= EDGE) return false;
  const position = axis === "y" ? box.scrollTop : box.scrollLeft;
  return delta > 0 ? position < room - EDGE : position > EDGE;
}

/**
 * Pixel delta for one wheel event. Line and page modes are scaled by the line
 * height and by the scroll container's own page size, never by a magic factor.
 */
export function wheelDelta(event: WheelLike, page: { width: number; height: number }, line = LINE_HEIGHT): { x: number; y: number } {
  const scaleX = event.deltaMode === LINE ? line : event.deltaMode === PAGE ? page.width : 1;
  const scaleY = event.deltaMode === LINE ? line : event.deltaMode === PAGE ? page.height : 1;
  return { x: event.deltaX * scaleX, y: event.deltaY * scaleY };
}

const NO_PLAN: ScrollPlan<never> = { handled: false, target: null, top: 0, left: 0 };

/**
 * `inside` is the native scroll chain of the event target, nearest first and
 * including the panel host element. `outside` is the enclosing chain of the
 * slot, nearest first. Both are read fresh per event; nothing is cached, so a
 * moved or remounted host can never leave a stale mapping behind.
 */
export function planScroll<T extends ScrollBox>(
  event: WheelLike,
  inside: readonly T[],
  outside: readonly T[],
  viewport: { width: number; height: number } = { width: 0, height: 0 },
): ScrollPlan<T> {
  // Zoom gestures and events another component already consumed are not ours.
  if (event.defaultPrevented || event.ctrlKey || event.metaKey) return NO_PLAN;
  const page = { width: inside[0]?.clientWidth || viewport.width, height: inside[0]?.clientHeight || viewport.height };
  const { x, y } = wheelDelta(event, page);
  // A gesture dominated by the horizontal axis belongs to horizontal scrollers
  // (tab strips, code, tables); replaying it vertically would hijack it.
  if (Math.abs(x) > Math.abs(y)) return NO_PLAN;
  if (!y) return NO_PLAN;
  // Native scrolling still has room inside the body: hands off, no duplicate.
  for (const box of inside) if (canScroll(box, "y", y)) return NO_PLAN;
  // The body is at its edge for this direction; continue outward, one scroller.
  for (const box of outside) {
    if (!canScroll(box, "y", y)) continue;
    const top = Math.min(maximum(box, "y"), Math.max(0, box.scrollTop + y));
    return { handled: top !== box.scrollTop, target: top === box.scrollTop ? null : box, top, left: box.scrollLeft };
  }
  return NO_PLAN;
}

/** Scroll containers around `from` (nearest first), including `stopAfter` when given. */
export function scrollChain(from: Element | null, stopAfter?: Element | null): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node: Element | null = from; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (isScrollContainer(node)) chain.push(node);
    if (node === stopAfter) break;
  }
  return chain;
}

/** A visible overflow that actually overflows; `hidden` clips and cannot wheel. */
export function isScrollContainer(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const scrollY = SCROLLABLE.test(style.overflowY);
  const scrollX = SCROLLABLE.test(style.overflowX);
  if (!scrollY && !scrollX) return false;
  return (scrollY && element.scrollHeight - element.clientHeight > EDGE) || (scrollX && element.scrollWidth - element.clientWidth > EDGE);
}

export function readBox(element: HTMLElement): ScrollContainer {
  return {
    element,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  };
}

export const readChain = (elements: readonly HTMLElement[]): ScrollContainer[] => elements.map(readBox);
