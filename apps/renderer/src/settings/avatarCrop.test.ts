import { describe, expect, it } from "vitest";
import {
  clampCropView,
  coverScale,
  cropSourceRect,
  initialCropView,
  panCropView,
  zoomCropView,
  type AvatarCropView,
} from "./avatarCrop";

function expectCircleInsideImage(view: AvatarCropView): void {
  const { sx, sy, size } = cropSourceRect(view);
  expect(sx).toBeGreaterThanOrEqual(-1e-6);
  expect(sy).toBeGreaterThanOrEqual(-1e-6);
  expect(sx + size).toBeLessThanOrEqual(view.naturalWidth + 1e-6);
  expect(sy + size).toBeLessThanOrEqual(view.naturalHeight + 1e-6);
  expect(size).toBeCloseTo(Math.min(view.circleSize / view.scale, view.naturalWidth, view.naturalHeight), 5);
}

describe("avatar crop view", () => {
  it("starts covering the circle and maps it into the source image", () => {
    const landscape = initialCropView(800, 450);
    expect(landscape.scale).toBeCloseTo(coverScale(800, 450, landscape.circleSize), 8);
    expectCircleInsideImage(landscape);
    const portrait = initialCropView(450, 800);
    expectCircleInsideImage(portrait);
    const square = initialCropView(200, 200);
    expect(square.scale).toBeCloseTo(square.circleSize / 200, 8);
    expectCircleInsideImage(square);
  });

  it("keeps the circle filled when panning or zooming past the edges", () => {
    const start = initialCropView(640, 480);
    const panned = panCropView(start, 4000, -4000);
    expectCircleInsideImage(panned);
    const clamped = clampCropView({ ...start, x: 9999, y: -9999, scale: 0.01 });
    expect(clamped.scale).toBeCloseTo(coverScale(640, 480, start.circleSize), 8);
    expectCircleInsideImage(clamped);
    const zoomedOut = zoomCropView(start, 0.01);
    expect(zoomedOut.scale).toBeCloseTo(coverScale(640, 480, start.circleSize), 8);
    expectCircleInsideImage(zoomedOut);
    const zoomedIn = zoomCropView(start, 4);
    expect(zoomedIn.scale).toBeGreaterThan(start.scale);
    expectCircleInsideImage(zoomedIn);
  });
});
