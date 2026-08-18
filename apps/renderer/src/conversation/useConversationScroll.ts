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
  const [follow, setFollow] = useState(pin === "bottom");
  const [hasNewContent, setHasNewContent] = useState(false);
  const followRef = useRef(pin === "bottom");
  const itemCountRef = useRef(itemCount);
  const contentKeyRef = useRef(contentKey);
  const contentKeyLiveRef = useRef(contentKey);
  contentKeyLiveRef.current = contentKey;
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const skipStickRef = useRef(false);

  const stick = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pin === "bottom" && !followRef.current) return;
    skipStickRef.current = true;
    el.scrollTop = pin === "top" ? 0 : el.scrollHeight;
    skipStickRef.current = false;
  }, [pin, scrollerRef]);

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
    const followBottom = pin === "bottom";
    followRef.current = followBottom;
    anchorRef.current = null;
    skipStickRef.current = false;
    itemCountRef.current = -1;
    contentKeyRef.current = contentKeyLiveRef.current;
    setFollow(followBottom);
    setHasNewContent(false);
    stickAfterLayout();
  }, [identityKey, pin, stickAfterLayout]);

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
    if (!grew || pin === "top") return;
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
