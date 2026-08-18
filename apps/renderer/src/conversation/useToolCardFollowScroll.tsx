import {
  useCallback,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { distanceFromBottom, shouldFollow } from "./useConversationScroll";

export const TOOL_CARD_FOLLOW_THRESHOLD_PX = 24;

/**
 * Inner scroller for an expanded tool / think card. While `follow` is on, stay
 * pinned to the latest line; a user scroll away from the bottom unpins until
 * they return or follow turns back on.
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
  const skipRef = useRef(false);
  const followRef = useRef(follow);
  followRef.current = follow;

  const stick = useCallback(() => {
    const el = ref.current;
    if (!el || !followRef.current || !pinnedRef.current || el.clientHeight <= 0) return;
    const jump = (node: HTMLDivElement) => {
      skipRef.current = true;
      node.scrollTop = node.scrollHeight;
      skipRef.current = false;
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

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (skipRef.current) return;
    const el = event.currentTarget;
    if (el.clientHeight <= 0) return;
    pinnedRef.current = shouldFollow(distanceFromBottom(el), TOOL_CARD_FOLLOW_THRESHOLD_PX);
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
