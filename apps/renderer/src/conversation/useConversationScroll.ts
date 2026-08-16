import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";

export const FOLLOW_THRESHOLD_PX = 72;

export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function shouldFollow(distance: number, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distance <= threshold;
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

export function useConversationScroll(args: {
  scrollerRef: RefObject<HTMLElement | null>;
  identityKey: string;
  itemCount: number;
  loadingOlder: boolean;
}): {
  follow: boolean;
  hasNewContent: boolean;
  onScroll: (event: UIEvent<HTMLElement>) => void;
  jumpToLatest: () => void;
  preparePrepend: () => void;
} {
  const { scrollerRef, identityKey, itemCount, loadingOlder } = args;
  const [follow, setFollow] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  const followRef = useRef(true);
  const itemCountRef = useRef(itemCount);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const skipStickRef = useRef(false);

  const stick = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollerRef]);

  const stickAfterLayout = useCallback(() => {
    stick();
    requestAnimationFrame(() => {
      stick();
      requestAnimationFrame(stick);
    });
  }, [stick]);

  const jumpToLatest = useCallback(() => {
    followRef.current = true;
    setFollow(true);
    setHasNewContent(false);
    stickAfterLayout();
  }, [stickAfterLayout]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (skipStickRef.current) return;
      const next = shouldFollow(distanceFromBottom(event.currentTarget));
      followRef.current = next;
      setFollow(next);
      if (next) setHasNewContent(false);
    },
    [],
  );

  const preparePrepend = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    anchorRef.current = captureAnchor(el);
    skipStickRef.current = true;
  }, [scrollerRef]);

  useLayoutEffect(() => {
    followRef.current = true;
    anchorRef.current = null;
    skipStickRef.current = false;
    itemCountRef.current = -1;
    setFollow(true);
    setHasNewContent(false);
    stickAfterLayout();
  }, [identityKey, stickAfterLayout]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (loadingOlder && anchorRef.current) {
      restoreAnchor(el, anchorRef.current);
      skipStickRef.current = false;
      itemCountRef.current = itemCount;
      return;
    }
    if (itemCount === itemCountRef.current) return;
    const grew = itemCount > itemCountRef.current;
    itemCountRef.current = itemCount;
    if (!grew) return;
    if (followRef.current) {
      stickAfterLayout();
      setHasNewContent(false);
    } else {
      setHasNewContent(true);
    }
  }, [itemCount, loadingOlder, scrollerRef, stickAfterLayout]);

  return { follow, hasNewContent, onScroll, jumpToLatest, preparePrepend };
}
