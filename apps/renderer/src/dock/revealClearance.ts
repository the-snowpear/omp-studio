import { useLayoutEffect, type RefObject } from "react";

/** Content boxes of the conversation tools rail that can sit over the corner. */
const AREAS = ".dock-rail-expanded > .dock-card-region, .dock-rail-compact > .dock-rail-icons, .dock-rail-compact > .dock-rail-overlay";
const GAP = 8;

/**
 * Moves the bottom-panel toggle out of the conversation tools' way. While the
 * rail's cards reach the toggle's resting corner, the toggle slides to the left
 * of that card area (and back when the cards no longer cover it).
 *
 * Geometry is written straight to the toggle's style instead of React state:
 * dragging the bottom panel changes the host height every frame, and re-rendering
 * the workbench shell for that would be wasteful.
 */
export function useBottomToggleClearance(host: RefObject<HTMLElement | null>, toggle: RefObject<HTMLElement | null>, active = true, container?: HTMLElement) {
  useLayoutEffect(() => {
    const anchor = container ?? host.current;
    const button = toggle.current;
    if (!active || !anchor || !button) return;
    let frame = 0;
    let areas = new Set<Element>();
    const measure = () => {
      frame = 0;
      const hostRect = anchor.getBoundingClientRect();
      const width = button.offsetWidth, height = button.offsetHeight;
      if (!width || !height || !hostRect.width) return;
      // offsetLeft/offsetTop ignore transforms, so they stay the resting corner
      // even after the button has been shifted.
      const left = hostRect.left + button.offsetLeft, top = hostRect.top + button.offsetTop;
      const right = left + width;
      let shift = 0;
      for (const area of areas) {
        const rect = area.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (rect.bottom <= top - GAP || rect.left >= right) continue;
        shift = Math.max(shift, right - rect.left + GAP);
      }
      shift = Math.max(0, Math.min(shift, right - hostRect.left - width - GAP));
      const value = shift ? `${Math.round(shift)}px` : "";
      if (button.style.getPropertyValue("--bp-reveal-shift") !== value) button.style.setProperty("--bp-reveal-shift", value);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    const rebind = () => {
      const next = new Set<Element>(anchor.querySelectorAll(AREAS));
      const changed = next.size !== areas.size || [...next].some(area => !areas.has(area));
      for (const area of areas) if (!next.has(area)) observer.unobserve(area);
      for (const area of next) if (!areas.has(area)) observer.observe(area);
      areas = next;
      return changed;
    };
    rebind();
    const mutations = new MutationObserver(() => { if (rebind()) schedule(); });
    mutations.observe(anchor, { childList: true, subtree: true });
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); button.style.removeProperty("--bp-reveal-shift"); };
  }, [host, toggle, active, container]);
}
