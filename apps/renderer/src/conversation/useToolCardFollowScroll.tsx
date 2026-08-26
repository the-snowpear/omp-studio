import {
  useCallback,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { AT_TAIL_PX, bindTailGestures, distanceFromBottom, shouldFollow } from "./useConversationScroll";

export const TOOL_CARD_FOLLOW_THRESHOLD_PX = 24;

/**
 * Inner scroller for an expanded tool / think card. While `follow` is on, stay
 * pinned to the latest line; a user scroll away from the bottom unpins until
 * they return or follow turns back on.
 *
 * Unpinning is driven by the gesture (wheel / key / touch), not by the resulting
 * scroll event: at streaming speed the next chunk re-pins before a scroll event
 * is delivered, so a scroll-event-only rule reads the pin's own write as "user
 * is at the bottom" and the card snaps back mid-gesture.
 *
 * Collapsed cards report clientHeight 0 — ignore those scroll events so a
 * 0fr expand animation cannot kill the pin.
 */
export function useToolCardFollowScroll(follow: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastTopRef = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;

  const stick = useCallback(() => {
    const el = ref.current;
    if (!el || !followRef.current || !pinnedRef.current || el.clientHeight <= 0) return;
    const jump = (node: HTMLDivElement) => {
      node.scrollTop = node.scrollHeight;
      lastTopRef.current = node.scrollTop;
    };
    jump(el);
    requestAnimationFrame(() => {
      const next = ref.current;
      if (next && followRef.current && pinnedRef.current && next.clientHeight > 0) jump(next);
    });
  }, []);

  useLayoutEffect(() => {
    if (follow) pinnedRef.current = true;
  }, [follow]);

  useLayoutEffect(() => {
    stick();
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      stick();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stick]);

  /* Detach on intent. Bound once per mounted card; the pin state is read live. */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return bindTailGestures(
      el,
      () => pinnedRef.current && el.clientHeight > 0,
      () => { pinnedRef.current = false; },
    );
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.clientHeight <= 0) return;
    const top = el.scrollTop;
    const moved = top - lastTopRef.current;
    lastTopRef.current = top;
    const distance = distanceFromBottom(el);
    if (distance <= AT_TAIL_PX) {
      pinnedRef.current = true;
      return;
    }
    if (moved < 0) {
      pinnedRef.current = false;
      return;
    }
    if (moved > 0 && shouldFollow(distance, TOOL_CARD_FOLLOW_THRESHOLD_PX)) pinnedRef.current = true;
  }, []);

  return { ref, onScroll };
}

export function ToolCardScroll({
  follow,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "onScroll"> & {
  follow: boolean;
  children: ReactNode;
}) {
  const { ref, onScroll } = useToolCardFollowScroll(follow);
  const classes = follow ? (className ? `${className} is-live` : "is-live") : className;
  return (
    <div
      {...rest}
      ref={ref}
      className={classes}
      {...(follow ? { "data-live": "tail" } : {})}
      onScroll={onScroll}
    >
      {children}
    </div>
  );
}
