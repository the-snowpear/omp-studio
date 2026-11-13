import { useEffect, useRef } from "react";

/**
 * Pointer spotlight (vivid only). One node for the window: it is laid over the
 * card or row under the pointer and the light follows the pointer inside it.
 * The target's own styles are never touched.
 *
 * Cost control: the listener exists only while `enabled`; the target's rect is
 * read once when the pointer enters it (and again after a scroll), so a move
 * only writes two custom properties on this one node. Nothing in the
 * conversation stream is lit, so streaming never pays for it.
 */
export const LUX_SPOT_TARGETS = [
  "[data-lit]",
  ".card", ".cap-item", ".hub-card", ".proj-card", ".tk-card", ".diag-card", ".perm-card",
  ".pv-card", ".yml-card", ".sk-card", ".env-card", ".session-card", ".dock-launcher-card",
  ".thread-row",
].join(", ");

const EXCLUDED = ".convo-scroll, .lux-off";

interface Lit {
  readonly element: Element;
  left: number;
  top: number;
}

export function LuxSpotlight({ enabled }: { enabled: boolean }) {
  const spot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = spot.current;
    if (!enabled || node === null) return;
    const root = globalThis.document.documentElement;
    let lit: Lit | null = null;
    let frame = 0;
    let pointer: { x: number; y: number; target: EventTarget | null } | null = null;

    const hide = () => {
      lit = null;
      node.removeAttribute("data-on");
    };
    const place = (element: Element): Lit => {
      const rect = element.getBoundingClientRect();
      node.style.width = `${Math.round(rect.width)}px`;
      node.style.height = `${Math.round(rect.height)}px`;
      node.style.translate = `${Math.round(rect.left)}px ${Math.round(rect.top)}px`;
      node.style.borderRadius = getComputedStyle(element).borderRadius;
      return { element, left: rect.left, top: rect.top };
    };
    const paint = () => {
      frame = 0;
      const current = pointer;
      if (current === null) return;
      if ((root.getAttribute("data-perf-tier") ?? "").split(/\s+/u).includes("L2")) return hide();
      const target = current.target instanceof Element ? current.target.closest(LUX_SPOT_TARGETS) : null;
      if (target === null || target.closest(EXCLUDED) !== null) return hide();
      if (lit === null || lit.element !== target) lit = place(target);
      node.style.setProperty("--mx", `${Math.round(current.x - lit.left)}px`);
      node.style.setProperty("--my", `${Math.round(current.y - lit.top)}px`);
      node.setAttribute("data-on", "");
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY, target: event.target };
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const onLeave = () => {
      pointer = null;
      hide();
    };
    // Anything scrolling moves the target under a fixed spot: re-measure on the next move.
    const onScroll = () => hide();

    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("scroll", onScroll, { capture: true });
      hide();
    };
  }, [enabled]);
  return <div className="lux-spot" ref={spot} aria-hidden="true" />;
}
