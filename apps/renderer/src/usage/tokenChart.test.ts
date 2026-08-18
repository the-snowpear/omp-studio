import { describe, expect, it } from "vitest";
import {
  clampPtsToPlot,
  flattenToBaseline,
  lerpPoints,
  resamplePoints,
  sampleForMorph,
  sampleSmoothCurve,
  smoothPath,
  yAtX,
} from "./tokenChart";

describe("resamplePoints", () => {
  it("emits N monotonic points whose ends match the source series", () => {
    const source = [[10, 20], [50, 80], [90, 40]] as const;
    const sampled = resamplePoints(source, 5);
    expect(sampled).toHaveLength(5);
    expect(sampled[0]).toEqual([10, 20]);
    expect(sampled[4]).toEqual([90, 40]);
    for (let index = 1; index < sampled.length; index++) {
      expect(sampled[index]![0]).toBeGreaterThan(sampled[index - 1]![0]);
    }
    expect(sampled[2]![1]).toBe(80);
  });

  it("turns a single point into a horizontal line across the span", () => {
    const sampled = resamplePoints([[40, 12]], 8, { x0: 0, x1: 100 });
    expect(sampled).toHaveLength(8);
    expect(sampled[0]).toEqual([0, 12]);
    expect(sampled[7]).toEqual([100, 12]);
    expect(sampled.every((point) => point[1] === 12)).toBe(true);
  });

  it("fills an empty series with the baseline", () => {
    const sampled = resamplePoints([], 4, { x0: 0, x1: 90, baselineY: 188 });
    expect(sampled).toHaveLength(4);
    expect(sampled[0]).toEqual([0, 188]);
    expect(sampled[3]).toEqual([90, 188]);
    expect(sampled.every((point) => point[1] === 188)).toBe(true);
  });
});

describe("lerpPoints", () => {
  const from = [[0, 10], [50, 20], [100, 30]] as const;
  const to = [[0, 40], [50, 50], [100, 70]] as const;

  it("returns the source at t=0 and the target at t=1", () => {
    expect(lerpPoints(from, to, 0)).toEqual([[0, 10], [50, 20], [100, 30]]);
    expect(lerpPoints(from, to, 1)).toEqual([[0, 40], [50, 50], [100, 70]]);
  });

  it("returns the midpoint at t=0.5", () => {
    expect(lerpPoints(from, to, 0.5)).toEqual([[0, 25], [50, 35], [100, 50]]);
  });
});

describe("sampleSmoothCurve", () => {
  it("keeps original endpoints and passes through source x values", () => {
    const source = [[10, 20], [50, 80], [90, 40]] as const;
    const sampled = sampleSmoothCurve(source, 5);
    expect(sampled).toHaveLength(5);
    expect(sampled[0]).toEqual([10, 20]);
    expect(sampled[4]).toEqual([90, 40]);
    expect(sampled[2]![0]).toBe(50);
    expect(sampled[2]![1]).toBe(80);
  });

  it("does not collapse a sparse cubic to the linear polyline", () => {
    const source = [[0, 0], [50, 100], [100, 0]] as const;
    const linear = resamplePoints(source, 5);
    const cubic = sampleSmoothCurve(source, 5);
    expect(cubic[1]![1]).not.toBe(linear[1]![1]);
    expect(smoothPath(source).startsWith("M")).toBe(true);
    expect(smoothPath(source)).toContain("C");
  });
});

describe("sampleForMorph", () => {
  it("keeps the native first and last x instead of snapping to 0", () => {
    const source = [[12, 40], [80, 10], [148, 30]] as const;
    const sampled = sampleForMorph(source, 8, 200, 188);
    expect(sampled[0]![0]).toBe(12);
    expect(sampled[7]![0]).toBe(148);
  });
});

describe("clampPtsToPlot", () => {
  it("clamps x to the plot and keeps peak y above the top pad", () => {
    const clamped = clampPtsToPlot([[-8, 2], [40, 90], [220, 400]], 10, 178, 200);
    expect(clamped[0]).toEqual([0, 2]);
    expect(clamped[1]).toEqual([40, 90]);
    expect(clamped[2]).toEqual([200, 188]);
  });
});

describe("flattenToBaseline", () => {
  it("keeps each sample x and parks y on the baseline", () => {
    expect(flattenToBaseline([[12, 40], [80, 10], [148, 30]], 188)).toEqual([
      [12, 188],
      [80, 188],
      [148, 188],
    ]);
  });
});

describe("yAtX", () => {
  it("interpolates between neighbors and clamps outside the span", () => {
    const pts = [[10, 0], [30, 20]] as const;
    expect(yAtX(pts, 10)).toBe(0);
    expect(yAtX(pts, 20)).toBe(10);
    expect(yAtX(pts, 0)).toBe(0);
    expect(yAtX(pts, 40)).toBe(20);
  });
});
