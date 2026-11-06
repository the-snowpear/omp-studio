import { describe, expect, it } from "vitest";
import { conversationSnapHit, defaultSnapRatios, resizeSnapRatio, snapCells, snapSurfaceSize, snapTemplateFits, snapTree, WindowSnapTracker, SNAP_TEMPLATES } from "./snap";

describe("conversation snapping", () => {
  it("offers layouts only when every conversation fits its minimum size", () => {
    const large = { width: 1440, height: 900 };
    for (const template of SNAP_TEMPLATES) {
      expect(snapTemplateFits(template, large)).toBe(true);
      const cells = snapCells(template, defaultSnapRatios(template), large);
      expect(cells.every(rect => rect.width >= 360 && rect.height >= 280)).toBe(true);
      expect(cells.reduce((area, rect) => area + rect.width * rect.height, 0)).toBe(large.width * large.height);
    }
    expect(SNAP_TEMPLATES.filter(template => snapTemplateFits(template, { width: 800, height: 400 }))).toEqual(["halves"]);
    expect(snapTemplateFits("columns", { width: 1080, height: 280 })).toBe(true);
  });
  it("prioritizes corners, snaps edges, maximizes at the top and ignores free positions", () => {
    const bounds = { x: 300, y: 80, width: 1100, height: 800 };
    expect(conversationSnapHit(305, 85, bounds)).toEqual({ template: "quarters", cell: 0 });
    expect(conversationSnapHit(1395, 875, bounds)).toEqual({ template: "quarters", cell: 3 });
    expect(conversationSnapHit(305, 400, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(conversationSnapHit(1395, 400, bounds)).toEqual({ template: "halves", cell: 1 });
    expect(conversationSnapHit(800, 85, bounds)).toEqual({ maximize: true });
    expect(conversationSnapHit(800, 400, bounds)).toBeNull();
  });
  it("accepts broad edges and corners without aiming at the workspace border", () => {
    const bounds = new DOMRect(300, 80, 1100, 800);
    expect(conversationSnapHit(385, 400, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(conversationSnapHit(1315, 400, bounds)).toEqual({ template: "halves", cell: 1 });
    expect(conversationSnapHit(420, 220, bounds)).toEqual({ template: "quarters", cell: 0 });
    expect(conversationSnapHit(1280, 220, bounds)).toEqual({ template: "quarters", cell: 1 });
    expect(conversationSnapHit(420, 740, bounds)).toEqual({ template: "quarters", cell: 2 });
    expect(conversationSnapHit(1280, 740, bounds)).toEqual({ template: "quarters", cell: 3 });
    expect(conversationSnapHit(850, 140, bounds)).toEqual({ maximize: true });
    expect(conversationSnapHit(550, 400, bounds)).toBeNull();
    expect(conversationSnapHit(250, 400, bounds)).toBeNull();
  });
  it("keeps a preview through small pointer deviations but releases on a deliberate move away", () => {
    const bounds = { x: 300, y: 80, width: 1100, height: 800 }, tracker = new WindowSnapTracker();
    expect(tracker.hit(385, 400, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(tracker.hit(400, 400, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(tracker.hit(410, 400, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(tracker.hit(430, 400, bounds)).toBeNull();
    expect(tracker.hit(470, 220, bounds)).toEqual({ template: "quarters", cell: 0 });
    expect(tracker.hit(488, 220, bounds)).toEqual({ template: "quarters", cell: 0 });
    expect(tracker.hit(510, 220, bounds)).toBeNull();
  });
  it("does not flicker between a side and its corner while still allowing immediate intentional changes", () => {
    const bounds = { x: 300, y: 80, width: 1100, height: 800 }, tracker = new WindowSnapTracker();
    expect(tracker.hit(350, 400, bounds)).toEqual({ template: "halves", cell: 0 });
    for (const height of [278, 282, 274, 285]) expect(tracker.hit(350, height, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(tracker.hit(350, 230, bounds)).toEqual({ template: "quarters", cell: 0 });
    expect(tracker.hit(350, 296, bounds)).toEqual({ template: "quarters", cell: 0 });
    expect(tracker.hit(350, 340, bounds)).toEqual({ template: "halves", cell: 0 });
    expect(tracker.hit(1340, 700, bounds)).toEqual({ template: "quarters", cell: 3 });
    tracker.reset();
    expect(tracker.hit(400, 400, bounds)).toBeNull();
  });
  it("uses generous three-way split targets and adapts to small and large workspaces", () => {
    const bounds = { x: 300, y: 80, width: 1100, height: 800 };
    const layout = { template: "halves" as const, tree: snapTree("halves"), members: { 0: "A", 1: "B" } };
    expect(conversationSnapHit(420, 220, bounds, layout)).toEqual({ template: "stack-left", cell: 0, splitSide: "left" });
    expect(conversationSnapHit(1280, 740, bounds, layout)).toEqual({ template: "stack-right", cell: 2, splitSide: "right" });
    expect(conversationSnapHit(60, 300, { x: 0, y: 0, width: 800, height: 600 })).toEqual({ template: "halves", cell: 0 });
    expect(conversationSnapHit(110, 900, { x: 0, y: 0, width: 3840, height: 2160 })).toEqual({ template: "halves", cell: 0 });
    expect(conversationSnapHit(250, 900, { x: 0, y: 0, width: 3840, height: 2160 })).toBeNull();
    expect(conversationSnapHit(100, 100, { x: 0, y: 0, width: 600, height: 400 })).toBeNull();
  });
  it("resizes adjoining partitions together and preserves their proportions in a scrolling workspace", () => {
    const before = defaultSnapRatios("halves");
    const ratios = resizeSnapRatio(before, "column", 0, 0.9, { width: 1000, height: 700 });
    const cells = snapCells("halves", ratios, { width: 1000, height: 700 });
    expect(cells.map(rect => rect.width)).toEqual([640, 360]);
    const size = snapSurfaceSize("halves", ratios, { width: 500, height: 250 });
    expect(size).toEqual({ width: 1000, height: 280 });
    expect(snapCells("halves", ratios, size).map(rect => rect.width)).toEqual([640, 360]);
    expect(before.columns).toEqual([0.5]);
  });
});
