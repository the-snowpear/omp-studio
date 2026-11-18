import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MOTION_EASE, MOTION_MS, motionReduced, type MotionCurve, type MotionStep } from "../../motion";

/**
 * The deck's moving parts that CSS cannot draw by itself: graph nodes gliding
 * to new places, numbers rolling to a new total, the replay clock. Every
 * duration and curve is a token from motion.ts; with motion off each of them
 * lands on its final value at once.
 */

const curves = new Map<MotionCurve, (t: number) => number>();

/** Solves a CSS cubic-bezier for progress `t` (Newton steps, then bisection). */
export function easing(curve: MotionCurve): (t: number) => number {
  const hit = curves.get(curve);
  if (hit) return hit;
  const [x1, y1, x2, y2] = MOTION_EASE[curve].replace(/[^\d.,]/g, "").split(",").map(Number) as [number, number, number, number];
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dx = (t: number) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  const solve = (x: number) => {
    let t = x;
    for (let index = 0; index < 6; index += 1) {
      const slope = dx(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= (bx(t) - x) / slope;
    }
    if (t < 0 || t > 1 || Math.abs(bx(t) - x) > 1e-4) {
      let lo = 0, hi = 1;
      t = x;
      for (let index = 0; index < 24; index += 1) { if (bx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    }
    return by(t);
  };
  const fn = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : solve(t);
  curves.set(curve, fn);
  return fn;
}

type Frame = (callback: FrameRequestCallback) => number;
type Cancel = (handle: number) => void;
function frameApi(element: Element | null): { request: Frame; cancel: Cancel } {
  // A body in a native float window paints on its own document's clock.
  const view = element?.ownerDocument.defaultView ?? window;
  return { request: view.requestAnimationFrame.bind(view), cancel: view.cancelAnimationFrame.bind(view) };
}

/** Calls `tick` every frame while `active`; stops when it returns false. */
export function useFrameLoop(active: boolean, anchor: { current: Element | null }, tick: (now: number) => boolean | void) {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!active) return;
    const { request, cancel } = frameApi(anchor.current);
    let handle = 0;
    const step = (now: number) => {
      if (tickRef.current(now) === false) return;
      handle = request(step);
    };
    handle = request(step);
    return () => cancel(handle);
  }, [active, anchor]);
}

export type Point = { readonly x: number; readonly y: number };

/**
 * Glides points to new targets. A point seen for the first time starts at
 * `origin(id)` (a spawned agent leaves its parent), anything else from where it
 * was drawn last. Returns the positions to draw this frame.
 */
export function useTweenedPoints(targets: ReadonlyMap<string, Point>, origin: (id: string) => Point | undefined, anchor: { current: Element | null }, step: MotionStep = "slower", curve: MotionCurve = "nav", structure?: string): ReadonlyMap<string, Point> {
  const shown = useRef(new Map<string, Point>());
  const from = useRef(new Map<string, Point>());
  const started = useRef(0);
  // Only a change of structure glides; resizing the view just redraws in place.
  const lastStructure = useRef<string | undefined>(undefined);
  const [, setFrame] = useState(0);
  const [moving, setMoving] = useState(false);
  const signature = [...targets].map(([id, point]) => `${id}:${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("|");
  const originRef = useRef(origin);
  originRef.current = origin;

  useLayoutEffect(() => {
    const next = new Map<string, Point>();
    let changed = false;
    for (const [id, target] of targets) {
      const current = shown.current.get(id) ?? originRef.current(id) ?? target;
      next.set(id, current);
      if (Math.abs(current.x - target.x) > 0.25 || Math.abs(current.y - target.y) > 0.25) changed = true;
    }
    const resized = structure !== undefined && structure === lastStructure.current && shown.current.size > 0;
    lastStructure.current = structure;
    if (!changed || resized || motionReduced()) {
      shown.current = new Map(targets);
      setMoving(false);
      setFrame(value => value + 1);
      return;
    }
    from.current = next;
    shown.current = next;
    started.current = performance.now();
    setMoving(true);
    // `targets` is read through the signature; a new Map with the same points must not restart the glide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const ease = easing(curve);
  useFrameLoop(moving, anchor, now => {
    const progress = Math.min(1, (now - started.current) / MOTION_MS[step]);
    const k = ease(progress);
    const next = new Map<string, Point>();
    for (const [id, target] of targets) {
      const start = from.current.get(id) ?? target;
      next.set(id, { x: start.x + (target.x - start.x) * k, y: start.y + (target.y - start.y) * k });
    }
    shown.current = next;
    setFrame(value => value + 1);
    if (progress >= 1) { setMoving(false); return false; }
    return true;
  });
  return moving ? shown.current : targets;
}

/**
 * FLIP for a list: items marked `data-flip="<key>"` that moved since the last
 * commit slide from their old place to the new one (region pattern: slow,
 * decelerating). Items that are new are left to their own entrance.
 */
export function useFlip(container: { current: HTMLElement | null }, signature: string) {
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-flip]")];
    const next = new Map<string, DOMRect>();
    for (const item of items) next.set(item.dataset.flip!, item.getBoundingClientRect());
    if (!motionReduced() && last.current.size) {
      for (const item of items) {
        const before = last.current.get(item.dataset.flip!);
        const after = next.get(item.dataset.flip!);
        if (!before || !after) continue;
        const dx = before.left - after.left, dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        item.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: MOTION_MS.slow, easing: MOTION_EASE.ios });
      }
    }
    last.current = next;
  }, [container, signature]);
}

/**
 * A wheel handler that may cancel the default (zoom instead of the page's own
 * Ctrl+wheel zoom). React's wheel listeners are passive, so this attaches a
 * native one; the latest handler is always used.
 */
export function useWheel(target: { current: HTMLElement | null }, handler: (event: WheelEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const listener = (event: WheelEvent) => latest.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [target]);
}

/** A number that rolls to its new value (counts, totals). Motion off or instant: it simply changes. */
export function useRolledNumber(
  value: number,
  anchor: { current: Element | null },
  step: MotionStep = "hero",
  instant = false,
): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const started = useRef(0);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (instant || motionReduced() || !Number.isFinite(value)) {
      if (active) setActive(false);
      if (shown !== value) setShown(value);
      return;
    }
    if (value === shown && !active) return;
    from.current = shown;
    started.current = performance.now();
    setActive(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, instant]);
  const ease = easing("out");
  useFrameLoop(active && !instant, anchor, now => {
    if (motionReduced()) {
      setShown(value);
      setActive(false);
      return false;
    }
    const progress = Math.min(1, (now - started.current) / MOTION_MS[step]);
    setShown(from.current + (value - from.current) * ease(progress));
    if (progress >= 1) { setActive(false); return false; }
    return true;
  });
  return instant ? value : shown;
}
