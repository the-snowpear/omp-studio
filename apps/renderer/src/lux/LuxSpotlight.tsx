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

    const hide = () => {
      node.removeAttribute("data-on");
    };
    const place = (element: Element): DOMRect => {
      const rect = element.getBoundingClientRect();
      const radius = getComputedStyle(element).borderRadius;
      node.style.width = `${Math.round(rect.width)}px`;
      node.style.height = `${Math.round(rect.height)}px`;
      node.style.translate = `${Math.round(rect.left)}px ${Math.round(rect.top)}px`;
      node.style.borderRadius = radius;
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
      node.style.setProperty("--mx", `${Math.round(current.x - rect.left)}px`);
      node.style.setProperty("--my", `${Math.round(current.y - rect.top)}px`);
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
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    // A fixed light must leave its old position when the layout moves.
    window.addEventListener("resize", onLeave);
    document.addEventListener("scroll", onLeave, { capture: true, passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("resize", onLeave);
      document.removeEventListener("scroll", onLeave, { capture: true });
      hide();
    };
  }, [enabled]);
  return <div className="lux-spot" ref={spot} aria-hidden="true" />;
}
