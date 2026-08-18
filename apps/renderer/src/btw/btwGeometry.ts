/**
 * Pure geometry for the BTW floating window.
 *
 * Everything here is viewport math with no DOM access so the drag / resize /
 * dock decisions stay testable. The window is `position: fixed`, so all
 * coordinates are viewport-relative CSS pixels.
 */

export interface BtwRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BtwViewport {
  readonly width: number;
  readonly height: number;
}

export interface BtwPoint {
  readonly x: number;
  readonly y: number;
}

export const BTW_MIN_WIDTH = 320;
export const BTW_MIN_HEIGHT = 220;

/** Title-bar height that must stay reachable when the window is pushed off-screen. */
export const BTW_TITLEBAR_HEIGHT = 38;

/** How much of the window must remain inside the viewport horizontally. */
const KEEP_VISIBLE_X = 96;

/** Right-edge band that triggers docking while the side panel is collapsed. */
export const BTW_EDGE_DOCK_BAND = 48;

export const BTW_CAPSULE_WIDTH = 188;
export const BTW_CAPSULE_HEIGHT = 48;

/** Movement below this distance is a click, not a drag. */
export const BTW_DRAG_THRESHOLD = 6;

export type BtwDropTarget = "dock" | "float";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function roundRect(rect: BtwRect): BtwRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Keep a window usable inside `viewport`: never smaller than the minimum, never
 * larger than the viewport, and always positioned so the title bar stays
 * grabbable. A window may hang off the left/right edge, but at least
 * `KEEP_VISIBLE_X` of it remains clickable so it can be dragged back.
 */
export function clampRect(rect: BtwRect, viewport: BtwViewport): BtwRect {
  const width = clamp(rect.width, BTW_MIN_WIDTH, Math.max(BTW_MIN_WIDTH, viewport.width));
  const height = clamp(rect.height, BTW_MIN_HEIGHT, Math.max(BTW_MIN_HEIGHT, viewport.height));
  const minX = Math.min(0, viewport.width - width);
  const maxX = Math.max(minX, viewport.width - Math.min(width, KEEP_VISIBLE_X));
  const maxY = Math.max(0, viewport.height - BTW_TITLEBAR_HEIGHT);
  return roundRect({
    x: clamp(rect.x, minX, maxX),
    y: clamp(rect.y, 0, maxY),
    width,
    height,
  });
}

/** Keep the capsule fully inside the viewport; it is small enough to always fit. */
export function clampCapsule(point: BtwPoint, viewport: BtwViewport): BtwPoint {
  return {
    x: Math.round(clamp(point.x, 0, Math.max(0, viewport.width - BTW_CAPSULE_WIDTH))),
    y: Math.round(clamp(point.y, 0, Math.max(0, viewport.height - BTW_CAPSULE_HEIGHT))),
  };
}

export type BtwResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Apply a pointer delta to one of the eight resize handles.
 *
 * North/west handles move the origin as well as the size, so the minimum size
 * is enforced by capping the delta instead of the resulting box — otherwise a
 * fast drag past the minimum would keep sliding the far edge.
 */
export function resizeRect(
  rect: BtwRect,
  edge: BtwResizeEdge,
  delta: BtwPoint,
  viewport: BtwViewport,
): BtwRect {
  let { x, y, width, height } = rect;
  if (edge.includes("e")) {
    width = Math.max(BTW_MIN_WIDTH, width + delta.x);
  }
  if (edge.includes("w")) {
    const shift = Math.min(delta.x, width - BTW_MIN_WIDTH);
    x += shift;
    width -= shift;
  }
  if (edge.includes("s")) {
    height = Math.max(BTW_MIN_HEIGHT, height + delta.y);
  }
  if (edge.includes("n")) {
    const shift = Math.min(delta.y, height - BTW_MIN_HEIGHT);
    y += shift;
    height -= shift;
  }
  return clampRect({ x, y, width, height }, viewport);
}

export interface BtwDropInput {
  readonly pointer: BtwPoint;
  readonly sideOpen: boolean;
  /** Bounding box of the side panel's tab strip; absent when it is not mounted. */
  readonly sideHeadRect?: BtwRect;
  readonly viewportWidth: number;
}

/**
 * Where a drag that ends at `pointer` should land.
 *
 * Two dock affordances, matching the two states of the right panel: with the
 * panel collapsed the panel itself is not a target, so the window's own right
 * edge stands in for it; with the panel open the tab strip is the target, which
 * matches where the docked BTW tab will actually appear.
 */
export function resolveDropTarget(input: BtwDropInput): BtwDropTarget {
  if (input.sideOpen) {
    const head = input.sideHeadRect;
    if (head !== undefined && containsPoint(head, input.pointer)) return "dock";
    return "float";
  }
  return input.pointer.x >= input.viewportWidth - BTW_EDGE_DOCK_BAND ? "dock" : "float";
}

export function containsPoint(rect: BtwRect, point: BtwPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 360;
/** Leaves room for the composer so the first placement never covers the input. */
const DEFAULT_BOTTOM_GAP = 172;
const DEFAULT_RIGHT_GAP = 32;

/** First-open placement: lower-right of the conversation area, clear of the composer. */
export function defaultRect(viewport: BtwViewport): BtwRect {
  const width = Math.min(DEFAULT_WIDTH, Math.max(BTW_MIN_WIDTH, viewport.width - 2 * DEFAULT_RIGHT_GAP));
  const height = Math.min(DEFAULT_HEIGHT, Math.max(BTW_MIN_HEIGHT, viewport.height - DEFAULT_BOTTOM_GAP));
  return clampRect(
    {
      x: viewport.width - width - DEFAULT_RIGHT_GAP,
      y: Math.max(0, viewport.height - height - DEFAULT_BOTTOM_GAP),
      width,
      height,
    },
    viewport,
  );
}

/** First-open capsule placement: bottom-right, roughly where the window was. */
export function defaultCapsulePos(viewport: BtwViewport): BtwPoint {
  return clampCapsule(
    {
      x: viewport.width - BTW_CAPSULE_WIDTH - DEFAULT_RIGHT_GAP,
      y: viewport.height - BTW_CAPSULE_HEIGHT - DEFAULT_BOTTOM_GAP,
    },
    viewport,
  );
}

/** True when the pointer travelled far enough to count as a drag. */
export function exceedsDragThreshold(from: BtwPoint, to: BtwPoint): boolean {
  return Math.abs(to.x - from.x) >= BTW_DRAG_THRESHOLD || Math.abs(to.y - from.y) >= BTW_DRAG_THRESHOLD;
}

/**
 * Place a window that was just undocked so its title bar sits under the
 * pointer. The pointer grabbed a tab button, so anchoring the box's top-left
 * to it would drop the window's own grip out from under the cursor.
 */
export function rectAtPointer(pointer: BtwPoint, rect: BtwRect, viewport: BtwViewport): BtwRect {
  return clampRect(
    {
      x: pointer.x - rect.width / 2,
      y: pointer.y - BTW_TITLEBAR_HEIGHT / 2,
      width: rect.width,
      height: rect.height,
    },
    viewport,
  );
}
