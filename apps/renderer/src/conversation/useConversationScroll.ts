import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import { recallSessionConversation } from "./sessionConversationCache";

/** How close to the tail counts as "back at the tail" when the user returns. */
export const FOLLOW_THRESHOLD_PX = 72;
/** Distances this small *are* the tail (exact landing, or a browser clamp after content shrank). */
export const AT_TAIL_PX = 1;

export type ScrollDirection = "up" | "down";

export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function shouldFollow(distance: number, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distance <= threshold;
}

/** Keys that scroll the conversation when the scroller itself has focus. */
export function keyScrollDirection(key: string): ScrollDirection | null {
  if (key === "ArrowUp" || key === "PageUp" || key === "Home") return "up";
  if (key === "ArrowDown" || key === "PageDown" || key === "End" || key === " ") return "down";
  return null;
}

export type ScrollBoxLike = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** `overscroll-behavior-y: contain | none` — the wheel never chains outward. */
  readonly containsOverscroll: boolean;
};

/**
 * Does a nested scroller (expanded tool / think card, xd:// list…) swallow this
 * wheel instead of the conversation? Mirrors the browser's own chaining rules,
 * so reading a think card does not detach the transcript from the tail.
 */
export function innerAbsorbsScroll(chain: readonly ScrollBoxLike[], direction: ScrollDirection): boolean {
  for (const box of chain) {
    if (box.scrollHeight - box.clientHeight <= 1) continue;
    if (box.containsOverscroll) return true;
    const room = direction === "up" ? box.scrollTop : box.scrollHeight - box.clientHeight - box.scrollTop;
    if (room > 1) return true;
  }
  return false;
}

/** Scroll containers between the wheel target and the conversation scroller, innermost first. */
function scrollBoxChain(target: EventTarget | null, scroller: HTMLElement): ScrollBoxLike[] {
  const chain: ScrollBoxLike[] = [];
  let node = target instanceof HTMLElement ? target : null;
  while (node !== null && node !== scroller && scroller.contains(node)) {
    /* clientHeight 0 = collapsed card mid-animation: not something the user can scroll. */
    if (node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 1 && typeof getComputedStyle === "function") {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        const overscrollY = style.overscrollBehaviorY || style.overscrollBehavior;
        chain.push({
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          containsOverscroll: overscrollY === "contain" || overscrollY === "none",
        });
      }
    }
    node = node.parentElement;
  }
  return chain;
}

function isTextEntry(node: HTMLElement): boolean {
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

/**
 * Detach-on-intent: a wheel notch / arrow key / touch drag that moves content
 * *up* parks the view immediately, before the resulting scroll event and before
 * the next stream chunk can re-pin. Without this the pin fights the gesture
 * (stream tick pins to the tail → the user's 40px is erased → they never leave
 * the tail no matter how much they scroll).
 *
 * A gesture that a nested scroller (expanded tool / think card) consumes is not
 * an intent to leave the tail: the transcript never moved.
 *
 * `pinned` gates the work — while already detached these handlers cost nothing,
 * and nothing here ever re-pins (that is the scroll event's job).
 */
export function bindTailGestures(el: HTMLElement, pinned: () => boolean, unpin: () => void): () => void {
  const canLeaveTail = () => pinned() && el.scrollTop > 1;
  const absorbed = (target: EventTarget | null) => innerAbsorbsScroll(scrollBoxChain(target, el), "up");

  const onWheel = (event: WheelEvent) => {
    if (event.deltaY >= 0 || !canLeaveTail() || absorbed(event.target)) return;
    unpin();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (keyScrollDirection(event.key) !== "up" || !canLeaveTail()) return;
    const target = event.target;
    if (target instanceof HTMLElement && target !== el && isTextEntry(target)) return;
    if (absorbed(event.target)) return;
    unpin();
  };
  let touchY: number | null = null;
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    const moved = touchY === null ? 0 : y - touchY;
    touchY = y;
    /* Finger travels down → content travels up. */
    if (moved <= 0 || !canLeaveTail() || absorbed(event.target)) return;
    unpin();
  };

  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
  };
}

export type ScrollAnchor = {
  readonly itemId: string;
  readonly offset: number;
};

export function captureAnchor(scroller: HTMLElement): ScrollAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  const nodes = scroller.querySelectorAll<HTMLElement>("[data-item-id]");
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom >= top) {
      return { itemId: node.dataset.itemId ?? "", offset: rect.top - top };
    }
  }
  return null;
}

/** First row in document order — changes exactly when a page is prepended. */
export function firstItemId(scroller: HTMLElement): string | null {
  return scroller.querySelector<HTMLElement>("[data-item-id]")?.dataset.itemId ?? null;
}

export function restoreAnchor(scroller: HTMLElement, anchor: ScrollAnchor): void {
  const node = scroller.querySelector<HTMLElement>(`[data-item-id="${cssEscape(anchor.itemId)}"]`);
  if (!node) return;
  const top = scroller.getBoundingClientRect().top;
  const delta = node.getBoundingClientRect().top - top - anchor.offset;
  scroller.scrollTop += delta;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

export function conversationFollowKey(state: {
  readonly liveTools: { readonly [toolCallId: string]: { readonly output?: string } };
  readonly liveMessages: { readonly [messageId: string]: { readonly blocks: readonly { readonly text: string }[] } };
}): string {
  const tools = Object.values(state.liveTools)
    .map((tool) => String(tool.output?.length ?? 0))
    .join(",");
  const messages = Object.values(state.liveMessages)
    .map((message) => String(message.blocks.reduce((sum, block) => sum + block.text.length, 0)))
    .join(",");
  return `${tools}|${messages}`;
}

export function useConversationScroll(args: {
  scrollerRef: RefObject<HTMLElement | null>;
  identityKey: string;
  itemCount: number;
  loadingOlder: boolean;
  /** Welcome / new-chat surface stays at the top; transcripts stick to the bottom. */
  pin?: "top" | "bottom";
  /**
   * Grows when live text / tool stdout changes without adding a row.
   * Same follow rules as itemCount: stick when pinned to bottom.
   */
  contentKey?: string;
}): {
  follow: boolean;
  hasNewContent: boolean;
  onScroll: (event: UIEvent<HTMLElement>) => void;
  jumpToLatest: () => void;
  preparePrepend: () => void;
} {
  const { scrollerRef, identityKey, itemCount, loadingOlder, pin = "bottom", contentKey = "" } = args;
  const initialAtBottom = useRef(
    pin === "bottom" && (recallSessionConversation(identityKey)?.viewport?.atBottom ?? true),
  ).current;
  const [follow, setFollow] = useState(initialAtBottom);
  const [hasNewContent, setHasNewContent] = useState(false);
  const followRef = useRef(initialAtBottom);
  const itemCountRef = useRef(itemCount);
  const contentKeyRef = useRef(contentKey);
  const contentKeyLiveRef = useRef(contentKey);
  contentKeyLiveRef.current = contentKey;
  const prependPendingRef = useRef(false);
  /** Last scrollTop we know about, so a scroll event can be read as a direction. */
  const lastTopRef = useRef(0);

  const setPin = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
    if (next) setHasNewContent(false);
  }, []);

  const stick = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pin === "bottom" && !followRef.current) return;
    el.scrollTop = pin === "top" ? 0 : el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, [pin, scrollerRef]);

  /** Virtuoso/ResizeObserver own late measurements; one synchronous tail write is enough. */
  const stickAfterLayout = useCallback(() => {
    stick();
  }, [stick]);

  const jumpToLatest = useCallback(() => {
    setPin(true);
    stickAfterLayout();
  }, [setPin, stickAfterLayout]);

  /**
   * Fallback / re-attach path. The gesture listeners already unpin on intent, so
   * this only has to stay out of the way: never re-pin while the view is moving
   * up, and only re-pin once the user brings it back to the tail.
   * Programmatic writes (stick / restoreAnchor) record their own scrollTop, so
   * they read as "no movement" here and leave the pin state alone.
   */
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const el = event.currentTarget;
      const top = el.scrollTop;
      const moved = top - lastTopRef.current;
      lastTopRef.current = top;
      if (pin === "top") return;
      const distance = distanceFromBottom(el);
      if (distance <= AT_TAIL_PX) {
        /* At the tail, whatever brought us here: follow. A gesture that left the
           tail already unpinned and lands further than AT_TAIL_PX away. */
        if (!followRef.current) setPin(true);
        return;
      }
      if (moved < 0) {
        if (followRef.current) setPin(false);
        return;
      }
      if (moved > 0 && !followRef.current && shouldFollow(distance)) setPin(true);
    },
    [pin, setPin],
  );

  const preparePrepend = useCallback(() => {
    prependPendingRef.current = true;
    if (followRef.current) setPin(false);
  }, [setPin]);

  useLayoutEffect(() => {
    const followBottom = pin === "bottom" && (recallSessionConversation(identityKey)?.viewport?.atBottom ?? true);
    prependPendingRef.current = false;
    itemCountRef.current = -1;
    contentKeyRef.current = contentKeyLiveRef.current;
    lastTopRef.current = scrollerRef.current?.scrollTop ?? 0;
    setPin(followBottom);
    setHasNewContent(false);
    if (followBottom || pin === "top") stickAfterLayout();
  }, [identityKey, pin, scrollerRef, setPin, stickAfterLayout]);

  /* Unpin the instant a gesture asks to go up — before the scroll event lands,
     and before the next stream chunk can pin it back. */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pin === "top") return;
    return bindTailGestures(el, () => followRef.current, () => setPin(false));
  }, [identityKey, pin, scrollerRef, setPin]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const previous = itemCountRef.current;
    const grew = itemCount > previous;
    itemCountRef.current = itemCount;
    const prepending = prependPendingRef.current && (loadingOlder || grew);
    if (!loadingOlder) prependPendingRef.current = false;
    if (!grew || pin === "top") return;
    if (prepending) return;
    if (followRef.current) {
      stickAfterLayout();
      setHasNewContent(false);
    } else {
      setHasNewContent(true);
    }
  }, [itemCount, loadingOlder, pin, scrollerRef, stickAfterLayout]);

  useLayoutEffect(() => {
    if (pin === "top") {
      contentKeyRef.current = contentKey;
      return;
    }
    if (contentKey === contentKeyRef.current) return;
    contentKeyRef.current = contentKey;
    if (followRef.current) {
      stickAfterLayout();
      setHasNewContent(false);
    } else {
      setHasNewContent(true);
    }
  }, [contentKey, pin, stickAfterLayout]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pin === "top" || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      stick();
    });
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [identityKey, pin, scrollerRef, stick]);

  return { follow, hasNewContent, onScroll, jumpToLatest, preparePrepend };
}
