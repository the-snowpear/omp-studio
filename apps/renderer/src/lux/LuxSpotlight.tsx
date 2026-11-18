import { useEffect, useRef } from "react";

/**
 * Pointer spotlight (vivid only). One node for the window: it is laid over the
 * card or row under the pointer and the light follows the pointer inside it.
 * The target's own styles are never touched.
 *
 * Cost control: the listener exists only while `enabled`; geometry is read at
 * most once per pointer frame, before any writes, so the light follows layout
 * changes too. Nothing in the conversation stream is lit.
 */
export const LUX_SPOT_TARGETS = [
  "[data-lit]",
  ".card", ".cap-item", ".hub-card", ".proj-card", ".tk-card", ".diag-card", ".perm-card",
  ".pv-card", ".yml-card", ".sk-card", ".env-card", ".session-card", ".dock-launcher-card",
  ".thread-row",
].join(", ");

const EXCLUDED = ".convo-scroll, .lux-off";

export function LuxSpotlight({ enabled }: { enabled: boolean }) {
  const spot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = spot.current;
    if (!enabled || node === null) return;
    const root = globalThis.document.documentElement;
    let frame = 0;
    let pointer: { x: number; y: number; target: EventTarget | null } | null = null;
    let radiusCache = new WeakMap<Element, string>();
    let lastW = -1, lastH = -1, lastX = Number.NaN, lastY = Number.NaN, lastRadius = "";
    let lastMx = Number.NaN, lastMy = Number.NaN;
    let isShown = false;

    const hide = () => {
      if (!isShown && !node.hasAttribute("data-on")) return;
      isShown = false;
      node.removeAttribute("data-on");
    };
    const place = (element: Element): DOMRect => {
      const rect = element.getBoundingClientRect();
      let radius = radiusCache.get(element);
      if (radius === undefined) {
        radius = getComputedStyle(element).borderRadius;
        radiusCache.set(element, radius);
      }
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const x = Math.round(rect.left);
      const y = Math.round(rect.top);
      if (w !== lastW) { lastW = w; node.style.width = `${w}px`; }
      if (h !== lastH) { lastH = h; node.style.height = `${h}px`; }
      if (x !== lastX || y !== lastY) { lastX = x; lastY = y; node.style.translate = `${x}px ${y}px`; }
      if (radius !== lastRadius) { lastRadius = radius; node.style.borderRadius = radius; }
      return rect;
    };
    const paint = () => {
      frame = 0;
      const current = pointer;
      if (current === null) return;
      if ((root.getAttribute("data-perf-tier") ?? "").split(/\s+/u).includes("L2")) return hide();
      const target = current.target instanceof Element ? current.target.closest(LUX_SPOT_TARGETS) : null;
      if (target === null || target.closest(EXCLUDED) !== null) return hide();
      const rect = place(target);
      const mx = Math.round(current.x - rect.left);
      const my = Math.round(current.y - rect.top);
      if (mx !== lastMx) { lastMx = mx; node.style.setProperty("--mx", `${mx}px`); }
      if (my !== lastMy) { lastMy = my; node.style.setProperty("--my", `${my}px`); }
      if (!isShown) { isShown = true; node.setAttribute("data-on", ""); }
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if ((event.buttons ?? 0) !== 0) {
        if (pointer !== null || isShown) { pointer = null; hide(); }
        return;
      }
      pointer = { x: event.clientX, y: event.clientY, target: event.target };
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const onLeave = () => {
      pointer = null;
      hide();
    };
    const onResize = () => {
      radiusCache = new WeakMap<Element, string>();
      onLeave();
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    // A fixed light must leave its old position when the layout moves.
    window.addEventListener("resize", onResize);
    document.addEventListener("scroll", onLeave, { capture: true, passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("scroll", onLeave, { capture: true });
      hide();
    };
  }, [enabled]);
  return <div className="lux-spot" ref={spot} aria-hidden="true" />;
}
