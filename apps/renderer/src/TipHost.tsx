import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Matches `--tip-delay`: wait before showing so a sweep across buttons does not flash. */
export const TIP_DELAY_MS = 500;

const GAP = 6;
const PAD = 8;

/**
 * Electron `titleBarOverlay` reserves part of the title bar for OS controls:
 * the caption buttons top-right on Windows, the traffic lights top-left on
 * macOS. The OS paints them above the DOM, so a bubble placed there would be
 * covered. The reserved sides are read from `.app-titlebar`: its height and its
 * left/right padding, which resolve `env(titlebar-area-x/width)`. In a plain
 * browser both fall back to 10px, so no zone exists and no bubble flips.
 */
function captionZones(): { height: number; left: number; right: number } {
  const titlebar = document.querySelector<HTMLElement>(".app-titlebar");
  if (titlebar) {
    const style = getComputedStyle(titlebar);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return { height: titlebar.offsetHeight, left: Number.isFinite(left) ? left : 0, right: Number.isFinite(right) ? right : 140 };
  }
  return { height: 36, left: 0, right: 140 };
}

function readTip(el: Element): string {
  return el.getAttribute("data-tip")?.trim() ?? "";
}

function tipFromPoint(x: number, y: number): { el: Element; text: string } | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  if (hit.closest(".omp-tip-bubble")) return null;
  const el = hit.closest("[data-tip]");
  if (!el) return null;
  const text = readTip(el);
  if (text.length === 0) return null;
  return { el, text };
}

/**
 * App-wide hover/focus tip. Reads `[data-tip]` and paints a portal bubble so
 * overflow:hidden ancestors cannot clip it. Do not use native `title`.
 */
export function TipHost() {
  const [tip, setTip] = useState<{ el: Element; text: string } | null>(null);
  const [box, setBox] = useState({ top: 0, left: 0 });
  const [ready, setReady] = useState(false);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const pendingRef = useRef<Element | null>(null);
  const shownRef = useRef<Element | null>(null);
  const timerRef = useRef(0);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
      pendingRef.current = null;
      shownRef.current = null;
      setTip(null);
      setReady(false);
    };

    const arm = (el: Element, text: string) => {
      if (shownRef.current === el) {
        setTip((current) => (
          current && current.el === el && current.text === text ? current : { el, text }
        ));
        return;
      }
      if (pendingRef.current === el) return;
      window.clearTimeout(timerRef.current);
      pendingRef.current = el;
      timerRef.current = window.setTimeout(() => {
        const next = readTip(el);
        if (next.length === 0) {
          hide();
          return;
        }
        shownRef.current = el;
        pendingRef.current = null;
        setReady(false);
        setTip({ el, text: next });
      }, TIP_DELAY_MS);
    };

    const fromPoint = (x: number, y: number) => {
      const found = tipFromPoint(x, y);
      if (!found) hide();
      else arm(found.el, found.text);
    };

    const onMove = (event: PointerEvent) => {
      fromPoint(event.clientX, event.clientY);
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest("[data-tip]");
      const text = el ? readTip(el) : "";
      if (el && text.length > 0 && target.matches(":focus-visible")) arm(el, text);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", onKeyDown);
    document.documentElement.addEventListener("pointerleave", hide);

    return () => {
      window.clearTimeout(timerRef.current);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", onKeyDown);
      document.documentElement.removeEventListener("pointerleave", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !bubbleRef.current) return;
    const bubble = bubbleRef.current.getBoundingClientRect();
    const anchor = tip.el.getBoundingClientRect();
    const above = anchor.top - GAP - bubble.height;
    let top = above >= PAD ? above : anchor.bottom + GAP;
    let left = anchor.left + anchor.width / 2 - bubble.width / 2;
    left = Math.max(PAD, Math.min(left, window.innerWidth - bubble.width - PAD));
    // OS window controls always paint over the DOM, so a bubble overlapping
    // their zone (e.g. rightmost topbar buttons on Windows, leftmost on macOS)
    // would be covered — flip it below the anchor instead. Only a real
    // titleBarOverlay inset counts; the env() browser fallback (10px) does not.
    const zone = captionZones();
    const overRight = zone.right > 40 && left + bubble.width > window.innerWidth - zone.right;
    const overLeft = zone.left > 40 && left < zone.left;
    if (top < zone.height && (overRight || overLeft)) {
      top = anchor.bottom + GAP;
    }
    setBox({ top, left });
    setReady(true);
  }, [tip]);

  if (tip === null) return null;
  return createPortal(
    <span
      ref={bubbleRef}
      className="omp-tip-bubble"
      role="tooltip"
      style={{ top: box.top, left: box.left, visibility: ready ? "visible" : "hidden" }}
    >
      {tip.text}
    </span>,
    document.body,
  );
}
