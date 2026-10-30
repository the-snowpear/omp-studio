import { describe, expect, it } from "vitest";
import { canScroll, planScroll, wheelDelta, type ScrollBox, type WheelLike } from "./scrollChain";

/** A scroll box with no DOM: geometry decisions must be pure data. */
function box(values: Partial<ScrollBox> = {}): ScrollBox {
  return { scrollTop: 0, scrollHeight: 1000, clientHeight: 400, scrollLeft: 0, scrollWidth: 400, clientWidth: 400, ...values };
}
function wheel(values: Partial<WheelLike> = {}): WheelLike {
  return { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: false, defaultPrevented: false, ...values };
}
const bottom = (values: Partial<ScrollBox> = {}) => box({ scrollTop: 600, ...values }); // 1000 - 400

describe("wheel deltas", () => {
  it("scales line and page modes and keeps trackpad fractions intact", () => {
    expect(wheelDelta(wheel({ deltaY: 3, deltaMode: 1 }), { width: 500, height: 400 })).toEqual({ x: 0, y: 48 });
    expect(wheelDelta(wheel({ deltaY: 1, deltaMode: 2 }), { width: 500, height: 400 })).toEqual({ x: 0, y: 400 });
    expect(wheelDelta(wheel({ deltaX: 2, deltaY: -1, deltaMode: 1 }), { width: 500, height: 400 })).toEqual({ x: 32, y: -16 });
    expect(wheelDelta(wheel({ deltaY: 0.75 }), { width: 500, height: 400 })).toEqual({ x: 0, y: 0.75 });
  });
});

describe("scroll edges", () => {
  it("only allows a direction with real room left", () => {
    expect(canScroll(box(), "y", 10)).toBe(true);
    expect(canScroll(bottom(), "y", 10)).toBe(false);
    expect(canScroll(bottom(), "y", -10)).toBe(true);
    expect(canScroll(box(), "y", -10)).toBe(false);
    expect(canScroll(box({ scrollHeight: 400 }), "y", 10)).toBe(false);
    expect(canScroll(box(), "y", 0)).toBe(false);
    expect(canScroll(box({ scrollLeft: 100, scrollWidth: 600 }), "x", -10)).toBe(true);
  });

  it("treats sub-pixel edges as an edge so a gesture never stalls there", () => {
    expect(canScroll(box({ scrollTop: 599.5 }), "y", 10)).toBe(false);
    expect(canScroll(box({ scrollTop: 598 }), "y", 10)).toBe(true);
    expect(canScroll(box({ scrollTop: 0.5 }), "y", -10)).toBe(false);
    expect(canScroll(box({ scrollTop: 2 }), "y", -10)).toBe(true);
  });
});

describe("wheel handoff between a body and the card column", () => {
  it("leaves the event to native scrolling while the body still has room", () => {
    const plan = planScroll(wheel(), [box()], [box({ scrollTop: 100 })]);
    expect(plan).toMatchObject({ handled: false, target: null });
  });

  it("scrolls the card column with the remainder at the bottom edge", () => {
    const column = box({ scrollTop: 100, scrollHeight: 2000 });
    const plan = planScroll(wheel({ deltaY: 100 }), [bottom()], [column]);
    expect(plan.handled).toBe(true);
    expect(plan.target).toBe(column);
    expect(plan.top).toBe(200);
    expect(plan.left).toBe(0);
  });

  it("scrolls the card column upward at the top edge", () => {
    const column = box({ scrollTop: 300, scrollHeight: 2000 });
    const plan = planScroll(wheel({ deltaY: -100 }), [box()], [column]);
    expect(plan.handled).toBe(true);
    expect(plan.target).toBe(column);
    expect(plan.top).toBe(200);
  });

  it("does nothing when nobody in either chain can move further", () => {
    expect(planScroll(wheel(), [bottom()], [box({ scrollTop: 600 })])).toMatchObject({ handled: false, target: null });
    expect(planScroll(wheel({ deltaY: -100 }), [box()], [box()])).toMatchObject({ handled: false, target: null });
  });

  it("does nothing when the slot has no scrollable ancestor", () => {
    expect(planScroll(wheel(), [bottom()], [])).toMatchObject({ handled: false, target: null });
  });

  it("clamps the handoff to the card column's own room, never amplifying it", () => {
    const column = box({ scrollTop: 1500, scrollHeight: 2000 }); // 100px of room left
    const plan = planScroll(wheel({ deltaY: 400 }), [bottom()], [column]);
    expect(plan).toMatchObject({ handled: true, target: column, top: 1600 });
  });

  it("hands fractional trackpad deltas over unchanged", () => {
    const column = box({ scrollTop: 0, scrollHeight: 2000 });
    const plan = planScroll(wheel({ deltaY: 0.5 }), [bottom()], [column]);
    expect(plan).toMatchObject({ handled: true, top: 0.5 });
  });

  it("returns the nearest enclosing container that can still scroll", () => {
    const atEdge = box({ scrollTop: 600 }); // e.g. the tab group body, clipped
    const column = box({ scrollTop: 0, scrollHeight: 2000 });
    const page = box({ scrollTop: 0, scrollHeight: 5000, clientHeight: 900 });
    const plan = planScroll(wheel(), [bottom()], [atEdge, column, page]);
    expect(plan.target).toBe(column);
    expect(plan.top).toBe(100);
  });
});

describe("wheel gestures the dock must not hijack", () => {
  it("ignores zoom gestures", () => {
    expect(planScroll(wheel({ ctrlKey: true }), [bottom()], [box()])).toMatchObject({ handled: false });
    expect(planScroll(wheel({ metaKey: true }), [bottom()], [box()])).toMatchObject({ handled: false });
  });

  it("ignores events another component already consumed", () => {
    expect(planScroll(wheel({ defaultPrevented: true }), [bottom()], [box()])).toMatchObject({ handled: false });
  });

  it("ignores mostly horizontal gestures", () => {
    expect(planScroll(wheel({ deltaX: 120, deltaY: 20 }), [bottom()], [box()])).toMatchObject({ handled: false });
    expect(planScroll(wheel({ deltaX: 120, deltaY: 0 }), [bottom()], [box()])).toMatchObject({ handled: false });
    // A vertical-dominant diagonal still belongs to the vertical chain.
    expect(planScroll(wheel({ deltaX: 20, deltaY: 120 }), [bottom()], [box()])).toMatchObject({ handled: true });
  });

  it("ignores empty deltas", () => {
    expect(planScroll(wheel({ deltaY: 0 }), [bottom()], [box()])).toMatchObject({ handled: false });
  });
});

describe("nested scroll containers", () => {
  it("consumes in the innermost scroller first and hands off only past it", () => {
    const deep = box();
    const host = box();
    const column = box({ scrollTop: 0, scrollHeight: 2000 });
    expect(planScroll(wheel(), [deep, host], [column])).toMatchObject({ handled: false });
    deep.scrollTop = 600; // the inner pane reached its end, the host still has room
    expect(planScroll(wheel(), [deep, host], [column])).toMatchObject({ handled: false });
    host.scrollTop = 600; // both are done, the card column owns the rest
    const plan = planScroll(wheel(), [deep, host], [column]);
    expect(plan.target).toBe(column);
    expect(plan.top).toBe(100);
  });

  it("uses the innermost container for page-sized deltas", () => {
    const deep = box({ clientHeight: 120, scrollHeight: 600, scrollTop: 480 });
    const host = box({ clientHeight: 300, scrollTop: 700 });
    const column = box({ scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });
    const plan = planScroll(wheel({ deltaY: 1, deltaMode: 2 }), [deep, host], [column]);
    expect(plan.top).toBe(120);
  });
});
