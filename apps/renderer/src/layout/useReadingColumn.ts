import { useConversationDom } from "../conversationWorkspace/Context";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { afterConversationLayoutChange, beforeConversationLayoutChange, CONVERSATION_LAYOUT_CHANGE } from "../conversation/conversationReflow";
import { TYPOGRAPHY_CHANGE } from "../settings/typography";

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

/** Below these `.convo-wrap` heights (short OS window, open bottom terminal, or
 * tiled/floating conversation window), the composer sheds vertical chrome in two
 * steps (`compact` -> `tight`) while preserving fixed-overlay containing blocks. */
export const SHORT_COLUMN_MAX = 580;
export const TIGHT_COLUMN_MAX = 380;
export const SHORT_COLUMN_HYSTERESIS = 12;

export type ReadingColumnHeightTier = "compact" | "tight" | undefined;

export function readingColumnHeightTier(
  containerHeight: number,
  current?: ReadingColumnHeightTier,
): ReadingColumnHeightTier {
  if (!(containerHeight > 0)) return undefined;
  const tightLimit = current === "tight" ? TIGHT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS : TIGHT_COLUMN_MAX;
  if (containerHeight <= tightLimit) return "tight";
  const compactLimit = current !== undefined ? SHORT_COLUMN_MAX + SHORT_COLUMN_HYSTERESIS : SHORT_COLUMN_MAX;
  if (containerHeight <= compactLimit) return "compact";
  return undefined;
}

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
  const { document, window } = useConversationDom();
  const input = useRef({ preference, welcome });
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // The scroller is stable for the lifetime of this workbench, even while its
    // virtual rows/session body change. Locate it once, not on stream updates.
    const scroller = element.querySelector<HTMLElement>(":scope > .convo-scroll");
    const queues = element.querySelector<HTMLElement>(":scope > .composer-region > .composer-queues");
    let previous: ReadingColumnGeometry | null = null;
    let previousHeight = -1;
    let previousQueueHeight = -1;
    let frame: number | null = null;
    const measure = () => {
      const { preference: current, welcome: isWelcome } = input.current;
      // The floating cards live inside the conversation. Its reading surface
      // can be narrower than the outer container without creating another Part.
      const containerWidth = scroller?.offsetWidth ?? element.clientWidth;
      const scale = Number.parseFloat(getComputedStyle(element).getPropertyValue("--density-scale")) || 1;
      const nativeScrollbar = () => scroller === null ? 0 : Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      let geometry = readingColumnGeometry(containerWidth, current, isWelcome, scale, nativeScrollbar());
      const minimap = geometry.minimap ? "on" : "off";
      const markersChanged = element.dataset.readingMinimap !== minimap;
      const narrow = containerWidth <= NARROW_COLUMN_MAX;
      const narrowChanged = element.hasAttribute("data-reading-narrow") !== narrow;
      const height = element.clientHeight;
      const queueHeight = queues?.offsetHeight ?? 0;
      const currentShort = (element.dataset.readingShort as ReadingColumnHeightTier) || undefined;
      const shortTier = readingColumnHeightTier(height, currentShort);
      const shortChanged = currentShort !== shortTier;
      if (markersChanged || narrowChanged || shortChanged || !sameGeometry(previous, geometry)) {
        beforeConversationLayoutChange();
        try {
          element.dataset.readingColumn = current.mode;
          if (narrowChanged) element.toggleAttribute("data-reading-narrow", narrow);
          if (shortChanged) {
            if (shortTier === undefined) delete element.dataset.readingShort;
            else element.dataset.readingShort = shortTier;
          }
          if (height !== previousHeight) {
            previousHeight = height;
            element.style.setProperty("--reading-height", `${height}px`);
          }
          if (markersChanged) {
            element.dataset.readingMinimap = minimap;
            // Switching to native scrollbars changes the scroller's clientWidth.
            // Read the real gutter after the marker, within this same transaction.
            if (!geometry.minimap) {
              geometry = readingColumnGeometry(containerWidth, current, isWelcome, scale, nativeScrollbar());
            }
          }
          element.style.setProperty("--conversation-width", `${geometry.width}px`);
          element.style.setProperty("--reading-gutter", `${geometry.gutter}px`);
          element.style.setProperty("--reading-rail", `${geometry.rail}px`);
          element.style.setProperty("--reading-scrollbar", `${geometry.scrollbar}px`);
          previous = geometry;
        } finally {
          afterConversationLayoutChange();
        }
      } else {
        if (element.dataset.readingColumn !== current.mode) {
          // Different presets can resolve to the same narrow column. Don't clear
          // virtual row measurements or restore scroll anchors for that no-op.
          element.dataset.readingColumn = current.mode;
        }
        if (height !== previousHeight) {
          previousHeight = height;
          element.style.setProperty("--reading-height", `${height}px`);
        }
      }
      // Extend the scroller beneath the tray while reserving the same space at
      // the transcript tail. Collapsing either queue keeps the latest row clear.
      if (queueHeight !== previousQueueHeight) {
        previousQueueHeight = queueHeight;
        element.style.setProperty("--composer-queues-height", `${queueHeight}px`);
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
    if (queues !== null) observer?.observe(queues);
    const densityObserver = new MutationObserver(schedule);
    densityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    const syncAfterLayout = () => {
      if (document.documentElement.hasAttribute("data-dock-rail-transition")) measure();
    };
    window.addEventListener(CONVERSATION_LAYOUT_CHANGE, syncAfterLayout);
    window.addEventListener(TYPOGRAPHY_CHANGE, schedule);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      densityObserver.disconnect();
      window.removeEventListener(CONVERSATION_LAYOUT_CHANGE, syncAfterLayout);
      window.removeEventListener(TYPOGRAPHY_CHANGE, schedule);
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
