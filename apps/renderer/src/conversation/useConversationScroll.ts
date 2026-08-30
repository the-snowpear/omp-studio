import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";

export const FOLLOW_THRESHOLD_PX = 72;
export const AT_TAIL_PX = 1;
export type ScrollDirection = "up" | "down";
export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number { return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight); }
export function shouldFollow(distance: number, threshold = FOLLOW_THRESHOLD_PX): boolean { return distance <= threshold; }
export function keyScrollDirection(key: string): ScrollDirection | null {
  if (["ArrowUp", "PageUp", "Home"].includes(key)) return "up";
  if (["ArrowDown", "PageDown", "End", " "].includes(key)) return "down";
  return null;
}
export type ScrollBoxLike = { readonly scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number; readonly containsOverscroll: boolean };
export function innerAbsorbsScroll(chain: readonly ScrollBoxLike[], direction: ScrollDirection): boolean {
  return chain.some((box) => {
    if (box.scrollHeight - box.clientHeight <= 1) return false;
    if (box.containsOverscroll) return true;
    return direction === "up" ? box.scrollTop > 1 : box.scrollHeight - box.clientHeight - box.scrollTop > 1;
  });
}
function nestedScrollChain(target: EventTarget | null, root: HTMLElement): ScrollBoxLike[] {
  const boxes: ScrollBoxLike[] = [];
  let node = target instanceof HTMLElement ? target : null;
  while (node !== null && node !== root) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY)) boxes.push({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, containsOverscroll: /^(contain|none)$/.test(style.overscrollBehaviorY) });
    node = node.parentElement;
  }
  return boxes;
}
export function bindTailGestures(el: HTMLElement, pinned: () => boolean, unpin: () => void): () => void {
  const wheel = (event: WheelEvent) => { if (pinned() && event.deltaY < 0 && !innerAbsorbsScroll(nestedScrollChain(event.target, el), "up")) unpin(); };
  const key = (event: KeyboardEvent) => { if (pinned() && keyScrollDirection(event.key) === "up") unpin(); };
  let touchY: number | null = null;
  const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
  const touchMove = (event: TouchEvent) => { const y = event.touches[0]?.clientY; if (pinned() && touchY !== null && y !== undefined && y > touchY + 2) unpin(); if (y !== undefined) touchY = y; };
  el.addEventListener("wheel", wheel, { passive: true }); el.addEventListener("keydown", key); el.addEventListener("touchstart", touchStart, { passive: true }); el.addEventListener("touchmove", touchMove, { passive: true });
  return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("keydown", key); el.removeEventListener("touchstart", touchStart); el.removeEventListener("touchmove", touchMove); };
}
export type ScrollAnchor = { readonly itemId: string; readonly offset: number; readonly scrollTop: number; readonly scrollHeight: number };
export function captureAnchor(scroller: HTMLElement): ScrollAnchor | null {
  const metrics = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
  const top = scroller.getBoundingClientRect().top;
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-item-id]")) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom >= top) return { itemId: node.dataset.itemId ?? "", offset: rect.top - top, ...metrics };
  }
  // Still worth an anchor: the metrics alone let `restoreAnchor` compensate.
  return { itemId: "", offset: 0, ...metrics };
}
export function firstItemId(scroller: HTMLElement): string | null { return scroller.querySelector<HTMLElement>("[data-item-id]")?.dataset.itemId ?? null; }
/**
 * Restore the reading position after older pages are prepended.
 *
 * Under virtualization the anchored row is frequently no longer mounted by the
 * time this runs, so the DOM lookup cannot be the only strategy — returning
 * early there silently drops the reader wherever the browser left them. Fall
 * back to compensating by however much the scrollable content grew above.
 */
export function restoreAnchor(scroller: HTMLElement, anchor: ScrollAnchor): void {
  const node = anchor.itemId.length === 0
    ? undefined
    : Array.from(scroller.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => item.dataset.itemId === anchor.itemId);
  if (node !== undefined) {
    const delta = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
    return;
  }
  const grew = scroller.scrollHeight - anchor.scrollHeight;
  if (grew > 0.5) scroller.scrollTop = anchor.scrollTop + grew;
}
export function conversationFollowKey(state: { readonly liveTools: Record<string, { readonly output?: string }>; readonly liveMessages: Record<string, { readonly blocks: readonly { readonly text: string }[] }> }): string {
  let tools = 0, toolChars = 0, blocks = 0, chars = 0;
  for (const tool of Object.values(state.liveTools)) { tools++; toolChars += tool.output?.length ?? 0; }
  for (const message of Object.values(state.liveMessages)) for (const block of message.blocks) { blocks++; chars += block.text.length; }
  return `${tools}:${toolChars}|${blocks}:${chars}`;
}
export function useConversationScroll({ scrollerRef, identityKey, itemCount, loadingOlder, pin = "bottom", contentKey = "" }: {
  scrollerRef: RefObject<HTMLElement | null>; identityKey: string; itemCount: number; loadingOlder: boolean; pin?: "top" | "bottom"; contentKey?: string;
}) {
  const pinned = useRef(pin === "bottom");
  /** scroller 几何缓存：scroll 事件里读 scrollHeight/clientHeight 是强制同步布局
   *  （事件通常紧跟贴底写 scrollTop 之后），流式期间每帧一次。缓存由 stickToTail
   *  （doc RO 触发，本就要读）刷新；onScroll 只读 scrollTop（不触发布局）。 */
  const metricsRef = useRef<{ scrollHeight: number; clientHeight: number }>({ scrollHeight: 0, clientHeight: 0 });
  const anchor = useRef<ScrollAnchor | null>(null);
  const previousFirst = useRef<string | null>(null);
  const [follow, setFollow] = useState(pin === "bottom");
  const [hasNewContent, setHasNewContent] = useState(false);
  /**
   * The transcript's single tail writer.
   *
   * Nothing else may assign `scroller.scrollTop` to follow the tail. One
   * ResizeObserver watches the final `.convo-doc` box after the virtualizer has
   * committed its measured height, so a content commit and the subsequent
   * virtualizer measurement cannot each schedule their own writer.
   */
  const stickToTail = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
    metricsRef.current = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, [scrollerRef]);
  const resizeFollow = useRef(false);
  /* 脱离即亮「回到最新」：读者主动离开尾部（手势/锚定/加载更早），不管之后有没有
     新内容到达，按钮都要出现——它此刻的功能是「回去的入口」，不只是「新内容提示」。
     （按钮已外发为宿主 slot，固定在输入框右上角；此处状态与 sticky 时代一致。） */
  const setPinned = useCallback((value: boolean) => { pinned.current = value; setFollow(value); if (value) setHasNewContent(false); else if (pin === "bottom") setHasNewContent(true); }, [pin]);
  const detachFromLatest = useCallback(() => setPinned(false), [setPinned]);
  const jumpToLatest = useCallback(() => { const el = scrollerRef.current; if (el === null) return; setPinned(true); el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [scrollerRef, setPinned]);
  const preparePrepend = useCallback(() => { const el = scrollerRef.current; if (el === null) return; anchor.current = captureAnchor(el); previousFirst.current = firstItemId(el); setPinned(false); }, [scrollerRef, setPinned]);
  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const el = event.currentTarget;
    if (metricsRef.current.clientHeight > 0) {
      // 缓存命中：距离计算不读布局属性。缓存偏旧只会让该帧判不出"在底部"，
      // 不会误钉（onScroll 只负责钉住，脱离由手势负责），下一帧缓存即刷新。
      const distance = Math.max(0, metricsRef.current.scrollHeight - el.scrollTop - metricsRef.current.clientHeight);
      if (distance <= AT_TAIL_PX || (!pinned.current && shouldFollow(distance))) setPinned(true);
      return;
    }
    const distance = distanceFromBottom(el);
    if (distance <= AT_TAIL_PX || (!pinned.current && shouldFollow(distance))) setPinned(true);
  }, [setPinned]);
  useEffect(() => { const el = scrollerRef.current; return el ? bindTailGestures(el, () => pinned.current, () => setPinned(false)) : undefined; }, [identityKey, scrollerRef, setPinned]);
  /* Identity reset must run before the initial ResizeObserver stick. A reader
     may have left the previous session halfway up; the new session still opens
     at its own tail before it becomes visible. */
  useLayoutEffect(() => { pinned.current = pin === "bottom"; setFollow(pin === "bottom"); setHasNewContent(false); anchor.current = null; }, [identityKey, pin]);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const doc = el?.querySelector<HTMLElement>(".convo-doc") ?? null;
    if (el === null) return;
    // Establish the initial position in the same pre-paint layout pass. Later
    // content/virtualizer growth is owned exclusively by the observer.
    // Top-pinned surfaces (welcome) open at 0 — nothing else ever writes this
    // position, so a switch away from a bottom-pinned transcript lands the
    // welcome at its top instead of wherever the transcript was scrolled.
    if (pin === "top") el.scrollTop = 0;
    if (doc === null || typeof ResizeObserver !== "function") {
      resizeFollow.current = false;
      return;
    }
    resizeFollow.current = true;
    const observer = new ResizeObserver(stickToTail);
    observer.observe(doc);
    observer.observe(el);
    stickToTail();
    return () => {
      resizeFollow.current = false;
      observer.disconnect();
    };
  }, [identityKey, pin, scrollerRef, stickToTail]);
  useLayoutEffect(() => {
    const el = scrollerRef.current; if (el === null) return;
    const pending = anchor.current;
    // Virtualized lists may keep the same first mounted row across a prepend,
    // so a grown scroll height counts as "the page landed" too.
    if (pending !== null && !loadingOlder && (firstItemId(el) !== previousFirst.current || el.scrollHeight > pending.scrollHeight + 0.5)) {
      restoreAnchor(el, pending); anchor.current = null; return;
    }
    if (pin === "bottom" && pinned.current) {
      // jsdom/older embedded engines without ResizeObserver retain the direct
      // fallback; Chromium uses the single final-size observer above.
      if (!resizeFollow.current) stickToTail();
      return;
    }
    // Prepending older pages is not new content: flagging it pops "back to
    // latest" while the reader is deliberately moving away from the tail.
    if (pin === "bottom" && !loadingOlder && anchor.current === null) setHasNewContent(true);
  }, [contentKey, itemCount, loadingOlder, pin, scrollerRef, stickToTail]);
  return { follow, hasNewContent, onScroll, jumpToLatest, preparePrepend, detachFromLatest };
}
