import { useLayoutEffect, useRef, type RefObject } from "react";
import { afterConversationLayoutChange, beforeConversationLayoutChange } from "../conversation/conversationReflow";

export type ReadingColumnPreference = {
  readonly mode: "standard" | "wide" | "full" | "custom";
  readonly customWidth: number;
};

type ReadingColumnGeometry = {
  readonly width: number;
  readonly gutter: number;
  readonly rail: number;
  readonly scrollbar: number;
  readonly minimap: boolean;
};

/** Below this column width the composer bar, queues and deck stack to one column.
 * Mirrors `max-width: 480px`; set as an attribute rather than a container query
 * because container-type would make .convo-wrap a containing block for the
 * fixed-position overlays (composer menu backdrops, image lightbox) inside it. */
export const NARROW_COLUMN_MAX = 480;

/** All widths are CSS pixels. The scrollbar is already absent from the document's
 * containing block, but must also be reserved by its composer sibling. */
export function readingColumnGeometry(
  containerWidth: number,
  preference: ReadingColumnPreference,
  welcome: boolean,
  densityScale = 1,
  nativeScrollbar = 0,
): ReadingColumnGeometry {
  const gutter = (containerWidth >= 720 ? 32 : containerWidth >= 480 ? 16 : 12) * densityScale;
  const minimap = containerWidth >= 720 && !welcome;
  const rail = minimap ? 44 : 0;
  const scrollbar = minimap ? 0 : Math.max(0, nativeScrollbar);
  const available = Math.max(0, containerWidth - gutter * 2 - rail - scrollbar);
  const cap = preference.mode === "standard" ? 768
    : preference.mode === "wide" ? 1024
    : preference.mode === "custom" ? preference.customWidth
    : available;
  return { width: Math.min(cap, available), gutter, rail, scrollbar, minimap };
}

function sameGeometry(a: ReadingColumnGeometry | null, b: ReadingColumnGeometry): boolean {
  return a !== null && a.width === b.width && a.gutter === b.gutter
    && a.rail === b.rail && a.scrollbar === b.scrollbar;
}

/** Owns only attributes/custom properties of the main .convo-wrap. No React
 * state, transcript observers or per-token DOM walks participate in measuring. */
export function useReadingColumn(
  ref: RefObject<HTMLDivElement | null>,
  preference: { mode: "standard" | "wide" | "full" | "custom"; customWidth: number },
  welcome: boolean,
): void {
  const input = useRef({ preference, welcome });
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // The scroller is stable for the lifetime of this workbench, even while its
    // virtual rows/session body change. Locate it once, not on stream updates.
    const scroller = element.querySelector<HTMLElement>(":scope > .convo-scroll");
    let previous: ReadingColumnGeometry | null = null;
    let previousHeight = -1;
    let frame: number | null = null;
    const measure = () => {
      const { preference: current, welcome: isWelcome } = input.current;
      const containerWidth = element.clientWidth;
      const scale = Number.parseFloat(getComputedStyle(element).getPropertyValue("--density-scale")) || 1;
      const nativeScrollbar = () => scroller === null ? 0 : Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      let geometry = readingColumnGeometry(containerWidth, current, isWelcome, scale, nativeScrollbar());
      const minimap = geometry.minimap ? "on" : "off";
      const markersChanged = element.dataset.readingMinimap !== minimap;
      const narrow = containerWidth <= NARROW_COLUMN_MAX;
      const narrowChanged = element.hasAttribute("data-reading-narrow") !== narrow;
      if (markersChanged || narrowChanged || !sameGeometry(previous, geometry)) {
        beforeConversationLayoutChange();
        try {
          element.dataset.readingColumn = current.mode;
          if (narrowChanged) element.toggleAttribute("data-reading-narrow", narrow);
          if (markersChanged) {
            element.dataset.readingMinimap = minimap;
            // Switching to native scrollbars changes the scroller's clientWidth.
            // Read the real gutter after the marker, within this same transaction.
            geometry = readingColumnGeometry(containerWidth, current, isWelcome, scale, nativeScrollbar());
          }
          element.style.setProperty("--conversation-width", `${geometry.width}px`);
          element.style.setProperty("--reading-gutter", `${geometry.gutter}px`);
          element.style.setProperty("--reading-rail", `${geometry.rail}px`);
          element.style.setProperty("--reading-scrollbar", `${geometry.scrollbar}px`);
          previous = geometry;
        } finally {
          afterConversationLayoutChange();
        }
      } else if (element.dataset.readingColumn !== current.mode) {
        // Different presets can resolve to the same narrow column. Don't clear
        // virtual row measurements or restore scroll anchors for that no-op.
        element.dataset.readingColumn = current.mode;
      }
      const height = element.clientHeight;
      if (height !== previousHeight) {
        previousHeight = height;
        element.style.setProperty("--reading-height", `${height}px`);
      }
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; measure(); });
    };
    measureRef.current = measure;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(element);
    // A native scrollbar/height change need not resize the outer workbench.
    if (scroller !== null) observer?.observe(scroller);
    const densityObserver = new MutationObserver(schedule);
    densityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density", "style"] });
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      densityObserver.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      measureRef.current = null;
    };
  }, [ref]);

  useLayoutEffect(() => {
    input.current = { preference, welcome };
    measureRef.current?.();
  }, [preference.mode, preference.customWidth, welcome, ref]);
}
