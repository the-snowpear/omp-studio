import { describe, expect, it, vi } from "vitest";
import {
  createAnimationFrameGate,
  createConversationViewportController,
  nearestSortedIndex,
} from "./conversationViewportController";

describe("conversationViewportController", () => {
  it("retains keyed measurements after a virtual row unmounts", () => {
    const controller = createConversationViewportController();
    controller.setItems(["a", "b", "c", "d"]);
    controller.recordMeasurements([{ itemId: "b", offset: 150, size: 100 }], 1_000);
    const measured = controller.fractions().b;

    controller.recordMeasurements([], 1_000);

    expect(controller.fractions().b).toBe(measured);
    expect(controller.fractions().a).toBeLessThan(controller.fractions().b!);
    expect(controller.fractions().c).toBeGreaterThan(controller.fractions().b!);
  });

  it("publishes direct Virtuoso measurements to shared consumers", () => {
    const controller = createConversationViewportController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.setItems(["a", "b"]);
    controller.recordMeasurements([{ itemId: "a", offset: 100, size: 20 }], 500);
    controller.recordMeasurements([{ itemId: "a", offset: 100, size: 20 }], 500);
    unsubscribe();
    controller.recordMeasurements([{ itemId: "b", offset: 300, size: 20 }], 500);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("interpolates unmeasured rows monotonically between measured neighbours", () => {
    const controller = createConversationViewportController();
    controller.setItems(["a", "b", "c", "d", "e"]);
    controller.recordMeasurements([
      { itemId: "a", offset: 90, size: 20 },
      { itemId: "e", offset: 890, size: 20 },
    ], 1_000);

    const fractions = controller.fractions();
    expect(fractions.a).toBeCloseTo(0.1);
    expect(fractions.b).toBeCloseTo(0.3);
    expect(fractions.c).toBeCloseTo(0.5);
    expect(fractions.d).toBeCloseTo(0.7);
    expect(fractions.e).toBeCloseTo(0.9);
  });

  it("invalidates retained list-relative offsets when rows are prepended", () => {
    const controller = createConversationViewportController();
    controller.setItems(["a", "b"]);
    controller.recordMeasurements([{ itemId: "b", offset: 890, size: 20 }], 1_000);
    expect(controller.fractions().b).toBeCloseTo(0.9);

    controller.setItems(["older", "a", "b"]);

    // With no valid post-prepend measurement yet, all marks use stable
    // interpolation. The old 0.9 fraction must not survive as if its offset
    // were still in the previous list coordinate space.
    expect(controller.fractions().b).toBeCloseTo(5 / 6);
    expect(controller.fractions().older).toBeLessThan(controller.fractions().a!);
    expect(controller.fractions().a).toBeLessThan(controller.fractions().b!);
  });

  it("finds the nearest active mark with binary search semantics", () => {
    expect(nearestSortedIndex([], 0.5)).toBe(-1);
    expect(nearestSortedIndex([0.1, 0.3, 0.8], 0.24)).toBe(1);
    expect(nearestSortedIndex([0.1, 0.3, 0.8], 0.54)).toBe(1);
    expect(nearestSortedIndex([0.1, 0.3, 0.8], 0.7)).toBe(2);

    const controller = createConversationViewportController();
    controller.setItems(["a", "b", "c"]);
    expect(controller.nearestItemId(0.51)).toBe("b");
  });

  it("coalesces a 120-event burst into one frame callback", () => {
    const frames: FrameRequestCallback[] = [];
    const callback = vi.fn();
    const gate = createAnimationFrameGate(callback, (frame) => {
      frames.push(frame);
      return frames.length;
    });

    for (let event = 0; event < 120; event += 1) gate.request();
    expect(frames).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled();

    frames.shift()!(16);
    expect(callback).toHaveBeenCalledTimes(1);

    gate.request();
    expect(frames).toHaveLength(1);
  });

  it("cancels a pending frame", () => {
    const cancelled: number[] = [];
    const gate = createAnimationFrameGate(vi.fn(), () => 42, (handle) => cancelled.push(handle));
    gate.request();
    gate.cancel();
    expect(cancelled).toEqual([42]);
  });
});
