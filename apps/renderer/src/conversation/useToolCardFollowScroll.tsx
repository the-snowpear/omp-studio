import { useCallback, useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject, type UIEvent } from "react";
import { bindTailGestures, distanceFromBottom } from "./useConversationScroll";
export const TOOL_CARD_FOLLOW_THRESHOLD_PX = 24;
/**
 * Keep a tool card's own scroll box pinned to the newest output.
 *
 * The stick pass must not be keyed on `follow` alone: during a streaming turn
 * `follow` stays `true` for minutes while the output grows, so an effect that
 * only reruns when it flips never scrolls again. Run it on every render, and
 * add a ResizeObserver for growth that arrives without one (late layout from
 * highlighting or images).
 *
 * The observer watches the scroll box and nothing else. A transcript mounts a
 * scroll pane per body region of every card in the viewport; observing *every
 * direct child* as well (a code block's children are its lines) made the
 * browser size thousands of boxes on every frame of a card's height
 * transition. Growth that changes `scrollHeight` without resizing the box
 * always arrives as a render too — the layout effect below covers it.
 */
export function useToolCardFollowScroll(follow: boolean): { ref: RefObject<HTMLDivElement | null>; onScroll: (event: UIEvent<HTMLDivElement>) => void } {
  const ref = useRef<HTMLDivElement>(null); const pinned = useRef(follow);
  const followRef = useRef(follow); followRef.current = follow;
  const previousFollow = useRef(follow);
  const frame = useRef<number | null>(null);
  const stick = useCallback(() => {
    const el = ref.current;
    // A zero-height box has no meaningful tail yet; writing scrollTop there
    // just loses the position once it is laid out.
    if (el === null || !followRef.current || !pinned.current || el.clientHeight <= 0) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  /** At most one deferred write per frame. The same growth reaches this hook as
   *  a render and as a ResizeObserver callback for the box; they must collapse
   *  into a single layout read. */
  const schedule = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") { stick(); return; }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; stick(); });
  }, [stick]);
  useEffect(() => () => { if (frame.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame.current); }, []);
  useEffect(() => { const el = ref.current; return el ? bindTailGestures(el, () => pinned.current, () => { pinned.current = false; }) : undefined; }, []);
  useLayoutEffect(() => {
    // `follow` turning true is an explicit "this card is live again" signal —
    // usually the reader hitting 回到最新 — so it clears an earlier in-card
    // unpin. Only the false→true edge does this; a re-render while `follow`
    // stays true must not clobber a deliberate scroll away from the tail. The
    // edge is handled here rather than in a `[follow]` effect so the reset
    // lands before `stick()` in the same commit, not one paint later.
    if (follow && !previousFollow.current) pinned.current = true;
    previousFollow.current = follow;
    if (!follow) return;
    stick();
    schedule();
  });
  useEffect(() => {
    if (!follow) return;
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => observer.disconnect();
  }, [follow, schedule]);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => { if (distanceFromBottom(event.currentTarget) <= TOOL_CARD_FOLLOW_THRESHOLD_PX) pinned.current = true; }, []);
  return { ref, onScroll };
}
export function ToolCardScroll({ follow, className, children, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, "onScroll"> & { follow: boolean; children: ReactNode }) {
  const scroll = useToolCardFollowScroll(follow);
  return <div {...rest} ref={scroll.ref} className={follow ? `${className ?? ""} is-live`.trim() : className} {...(follow ? { "data-live": "tail" } : {})} onScroll={scroll.onScroll}>{children}</div>;
}
