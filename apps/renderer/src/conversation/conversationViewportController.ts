export type ConversationRowMeasurement = {
  readonly itemId: string;
  readonly offset: number;
  readonly size: number;
};

export type ConversationViewportController = {
  setItems(itemIds: readonly string[]): void;
  recordMeasurements(measurements: readonly ConversationRowMeasurement[], totalHeight: number): void;
  fractions(): Readonly<Record<string, number>>;
  nearestItemId(fraction: number): string | null;
  subscribe(listener: () => void): () => void;
};

const MIN_FRACTION = 0.015;
const MAX_FRACTION = 0.985;

function clampFraction(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

/** Return the nearest sorted value without scanning the entire collection. */
export function nearestSortedIndex(values: readonly number[], target: number): number {
  if (values.length === 0) return -1;
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! < target) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return 0;
  const before = low - 1;
  return Math.abs(values[before]! - target) <= Math.abs(values[low]! - target) ? before : low;
}

/**
 * Keyed row measurement cache shared by the transcript/minimap hot path.
 * Measurements survive virtual-row unmounts. Unknown rows are placed by stable
 * interpolation between their nearest measured neighbours, avoiding the
 * mounted/unmounted position flip that otherwise makes minimap marks flash.
 */
export function createConversationViewportController(): ConversationViewportController {
  let itemIds: readonly string[] = [];
  const measurementsById = new Map<string, ConversationRowMeasurement>();
  let measuredTotalHeight = 0;
  let positions: number[] = [];
  let positionById: Readonly<Record<string, number>> = {};
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const rebuild = () => {
    if (itemIds.length === 0) {
      positions = [];
      positionById = {};
      return;
    }

    const anchors: Array<{ index: number; fraction: number }> = [{ index: -0.5, fraction: 0 }];
    let lastFraction = 0;
    for (let index = 0; index < itemIds.length; index += 1) {
      const measured = measurementsById.get(itemIds[index]!);
      if (measured === undefined || measuredTotalHeight <= 0) continue;
      const fraction = clampFraction((measured.offset + measured.size / 2) / measuredTotalHeight);
      if (fraction <= lastFraction) continue;
      anchors.push({ index, fraction });
      lastFraction = fraction;
    }
    anchors.push({ index: itemIds.length - 0.5, fraction: 1 });

    const nextPositions = new Array<number>(itemIds.length);
    let anchorIndex = 0;
    for (let index = 0; index < itemIds.length; index += 1) {
      while (anchorIndex + 1 < anchors.length && anchors[anchorIndex + 1]!.index < index) anchorIndex += 1;
      const before = anchors[anchorIndex]!;
      const after = anchors[Math.min(anchorIndex + 1, anchors.length - 1)]!;
      const span = after.index - before.index;
      const progress = span <= 0 ? 0 : (index - before.index) / span;
      nextPositions[index] = clampFraction(before.fraction + (after.fraction - before.fraction) * progress);
    }

    const nextById: Record<string, number> = {};
    for (let index = 0; index < itemIds.length; index += 1) nextById[itemIds[index]!] = nextPositions[index]!;
    positions = nextPositions;
    positionById = nextById;
  };

  return {
    setItems(nextItemIds) {
      if (itemIds.length === nextItemIds.length && itemIds.every((itemId, index) => itemId === nextItemIds[index])) return;
      const previousIndexById = new Map(itemIds.map((itemId, index) => [itemId, index]));
      const nextIndexById = new Map(nextItemIds.map((itemId, index) => [itemId, index]));
      // Offsets are list-relative. A prepend/removal/reorder changes the
      // coordinate of every retained row after that edit, so keeping those
      // measurements makes marks stay in their pre-prepend positions until
      // the user happens to visit and remeasure them again. Appends and tail
      // removals keep existing indices (and therefore offsets) valid.
      for (const itemId of measurementsById.keys()) {
        const previousIndex = previousIndexById.get(itemId);
        const nextIndex = nextIndexById.get(itemId);
        if (nextIndex === undefined || (previousIndex !== undefined && previousIndex !== nextIndex)) {
          measurementsById.delete(itemId);
        }
      }
      itemIds = [...nextItemIds];
      rebuild();
      notify();
    },

    recordMeasurements(measurements, totalHeight) {
      if (!(totalHeight > 0)) return;
      let changed = measuredTotalHeight !== totalHeight;
      measuredTotalHeight = totalHeight;
      for (const measurement of measurements) {
        const previous = measurementsById.get(measurement.itemId);
        if (previous?.offset === measurement.offset && previous.size === measurement.size) continue;
        measurementsById.set(measurement.itemId, measurement);
        changed = true;
      }
      if (!changed) return;
      rebuild();
      notify();
    },

    fractions() {
      return positionById;
    },

    nearestItemId(fraction) {
      const index = nearestSortedIndex(positions, fraction);
      return index < 0 ? null : itemIds[index] ?? null;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type AnimationFrameGate = {
  request(): void;
  cancel(): void;
};

/** Coalesces an arbitrary event burst into at most one callback per frame. */
export function createAnimationFrameGate(
  callback: () => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): AnimationFrameGate {
  let frame: number | null = null;
  return {
    request() {
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        callback();
      });
    },
    cancel() {
      if (frame === null) return;
      cancelFrame(frame);
      frame = null;
    },
  };
}
