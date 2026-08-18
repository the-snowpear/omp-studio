import { describe, expect, it } from "vitest";
import {
  BTW_CAPSULE_HEIGHT,
  BTW_CAPSULE_WIDTH,
  BTW_EDGE_DOCK_BAND,
  BTW_MIN_HEIGHT,
  BTW_MIN_WIDTH,
  BTW_TITLEBAR_HEIGHT,
  clampCapsule,
  clampRect,
  defaultCapsulePos,
  defaultRect,
  exceedsDragThreshold,
  rectAtPointer,
  resizeRect,
  resolveDropTarget,
  type BtwRect,
  type BtwViewport,
} from "./btwGeometry";

const VIEW: BtwViewport = { width: 1280, height: 800 };
const BOX: BtwRect = { x: 400, y: 120, width: 420, height: 360 };

describe("clampRect", () => {
  it("enforces the minimum size and keeps the title bar inside the viewport", () => {
    const next = clampRect({ x: -2000, y: -50, width: 10, height: 10 }, VIEW);
    expect(next.width).toBe(BTW_MIN_WIDTH);
    expect(next.height).toBe(BTW_MIN_HEIGHT);
    expect(next.y).toBe(0);
    expect(next.x + next.width).toBeGreaterThan(0);
  });

  it("does not grow past the viewport", () => {
    const next = clampRect({ x: 0, y: 0, width: 4000, height: 4000 }, VIEW);
    expect(next.width).toBe(VIEW.width);
    expect(next.height).toBe(VIEW.height);
  });

  it("replaces non-finite sizes with the minimum instead of producing NaN", () => {
    const next = clampRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY, width: Number.NaN, height: -Infinity }, VIEW);
    expect(next.width).toBe(BTW_MIN_WIDTH);
    expect(next.height).toBe(BTW_MIN_HEIGHT);
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
  });
});

describe("resizeRect", () => {
  it("grows and shrinks all eight handles without dropping below the minimum", () => {
    expect(resizeRect(BOX, "e", { x: 40, y: 0 }, VIEW)).toMatchObject({ width: 460, x: 400 });
    expect(resizeRect(BOX, "s", { x: 0, y: 40 }, VIEW)).toMatchObject({ height: 400, y: 120 });
    expect(resizeRect(BOX, "w", { x: -40, y: 0 }, VIEW)).toMatchObject({ width: 460, x: 360 });
    expect(resizeRect(BOX, "n", { x: 0, y: -40 }, VIEW)).toMatchObject({ height: 400, y: 80 });
    expect(resizeRect(BOX, "se", { x: 20, y: 20 }, VIEW)).toMatchObject({ width: 440, height: 380 });
    expect(resizeRect(BOX, "nw", { x: -20, y: -20 }, VIEW)).toMatchObject({ width: 440, height: 380, x: 380, y: 100 });
    expect(resizeRect(BOX, "ne", { x: 20, y: -20 }, VIEW)).toMatchObject({ width: 440, height: 380, y: 100 });
    expect(resizeRect(BOX, "sw", { x: -20, y: 20 }, VIEW)).toMatchObject({ width: 440, height: 380, x: 380 });
  });

  it("caps a west/north drag so the far edge does not slide once the minimum is hit", () => {
    const west = resizeRect(BOX, "w", { x: 2000, y: 0 }, VIEW);
    expect(west.width).toBe(BTW_MIN_WIDTH);
    expect(west.x + west.width).toBe(BOX.x + BOX.width);
    const north = resizeRect(BOX, "n", { x: 0, y: 2000 }, VIEW);
    expect(north.height).toBe(BTW_MIN_HEIGHT);
    expect(north.y + north.height).toBe(BOX.y + BOX.height);
  });
});

describe("resolveDropTarget", () => {
  it("docks on the right-edge band while the side panel is collapsed", () => {
    expect(
      resolveDropTarget({ pointer: { x: VIEW.width - BTW_EDGE_DOCK_BAND, y: 40 }, sideOpen: false, viewportWidth: VIEW.width }),
    ).toBe("dock");
    expect(
      resolveDropTarget({ pointer: { x: VIEW.width - BTW_EDGE_DOCK_BAND - 1, y: 40 }, sideOpen: false, viewportWidth: VIEW.width }),
    ).toBe("float");
  });

  it("docks only on the tab strip while the side panel is open", () => {
    const head = { x: 800, y: 44, width: 480, height: 40 };
    expect(
      resolveDropTarget({ pointer: { x: 820, y: 50 }, sideOpen: true, sideHeadRect: head, viewportWidth: VIEW.width }),
    ).toBe("dock");
    expect(
      resolveDropTarget({ pointer: { x: VIEW.width - 8, y: 400 }, sideOpen: true, sideHeadRect: head, viewportWidth: VIEW.width }),
    ).toBe("float");
    expect(
      resolveDropTarget({ pointer: { x: 820, y: 50 }, sideOpen: true, viewportWidth: VIEW.width }),
    ).toBe("float");
  });
});

describe("defaults and helpers", () => {
  it("places the first window and capsule inside the viewport", () => {
    const rect = defaultRect(VIEW);
    expect(rect.width).toBeGreaterThanOrEqual(BTW_MIN_WIDTH);
    expect(rect.x + rect.width).toBeLessThanOrEqual(VIEW.width);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    const capsule = defaultCapsulePos(VIEW);
    expect(capsule.x + BTW_CAPSULE_WIDTH).toBeLessThanOrEqual(VIEW.width);
    expect(capsule.y + BTW_CAPSULE_HEIGHT).toBeLessThanOrEqual(VIEW.height);
  });

  it("treats a 6px move as a drag and anchors an undocked window under the pointer", () => {
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(false);
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    const next = rectAtPointer({ x: 640, y: 400 }, BOX, VIEW);
    expect(next.y).toBe(400 - BTW_TITLEBAR_HEIGHT / 2);
    expect(clampCapsule({ x: -10, y: 900 }, VIEW)).toEqual({ x: 0, y: VIEW.height - BTW_CAPSULE_HEIGHT });
  });
});
