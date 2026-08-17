export type ChartPx = readonly [number, number];

export const CHART_SAMPLE_COUNT = 96;
export const CHART_MORPH_MS = 420;
export const CHART_AXIS_FADE_MS = 160;

type BuiltCurve = {
  readonly xs: number[];
  readonly ys: number[];
  readonly c1y: number[];
  readonly c2y: number[];
};

function buildCurve(pts: ReadonlyArray<ChartPx>): BuiltCurve | null {
  if (pts.length < 2) return null;
  const xs = pts.map((point) => point[0]);
  const ys = pts.map((point) => point[1]);
  const count = pts.length;
  const dxs = Array.from({ length: count - 1 }, (_, index) => xs[index + 1]! - xs[index]!);
  const slopes = dxs.map((dx, index) => (Math.abs(dx) < 1e-6 ? 0 : (ys[index + 1]! - ys[index]!) / dx));
  const tangents = new Array<number>(count);
  tangents[0] = slopes[0]!;
  tangents[count - 1] = slopes[count - 2]!;
  for (let index = 1; index < count - 1; index++) {
    tangents[index] = slopes[index - 1]! * slopes[index]! <= 0 ? 0 : (slopes[index - 1]! + slopes[index]!) / 2;
  }
  // Fritsch–Carlson: keep each cubic inside its two endpoints so a steep
  // neighbor cannot pull a near-zero span below the axis.
  const scale = new Array<number>(count).fill(1);
  for (let index = 0; index < count - 1; index++) {
    const slope = slopes[index]!;
    if (Math.abs(slope) < 1e-8) {
      scale[index] = 0;
      scale[index + 1] = 0;
      continue;
    }
    const alpha = tangents[index]! / slope;
    const beta = tangents[index + 1]! / slope;
    const sum = alpha * alpha + beta * beta;
    if (sum > 9) {
      const tau = 3 / Math.sqrt(sum);
      scale[index] = Math.min(scale[index]!, tau);
      scale[index + 1] = Math.min(scale[index + 1]!, tau);
    }
  }
  for (let index = 0; index < count; index++) tangents[index]! *= scale[index]!;
  const c1y = new Array<number>(count - 1);
  const c2y = new Array<number>(count - 1);
  for (let index = 0; index < count - 1; index++) {
    const y0 = ys[index]!;
    const y1 = ys[index + 1]!;
    const dx = dxs[index]!;
    if (Math.abs(dx) < 1e-6) {
      c1y[index] = y0;
      c2y[index] = y1;
      continue;
    }
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    c1y[index] = Math.min(hi, Math.max(lo, y0 + tangents[index]! * dx / 3));
    c2y[index] = Math.min(hi, Math.max(lo, y1 - tangents[index + 1]! * dx / 3));
  }
  return { xs, ys, c1y, c2y };
}

function bezierY(t: number, y0: number, c1: number, c2: number, y1: number): number {
  const rest = 1 - t;
  return rest * rest * rest * y0 + 3 * rest * rest * t * c1 + 3 * rest * t * t * c2 + t * t * t * y1;
}

function yOnCurve(curve: BuiltCurve, x: number): number {
  const last = curve.xs.length - 1;
  if (x <= curve.xs[0]!) return curve.ys[0]!;
  if (x >= curve.xs[last]!) return curve.ys[last]!;
  for (let index = 0; index < last; index++) {
    const x1 = curve.xs[index + 1]!;
    if (x > x1) continue;
    const x0 = curve.xs[index]!;
    const dx = x1 - x0;
    if (Math.abs(dx) < 1e-6) return curve.ys[index + 1]!;
    return bezierY((x - x0) / dx, curve.ys[index]!, curve.c1y[index]!, curve.c2y[index]!, curve.ys[index + 1]!);
  }
  return curve.ys[last]!;
}

export function smoothPath(pts: ReadonlyArray<ChartPx>): string {
  const curve = buildCurve(pts);
  if (!curve) return "";
  let path = `M${curve.xs[0]!.toFixed(1)} ${curve.ys[0]!.toFixed(1)}`;
  for (let index = 0; index < curve.xs.length - 1; index++) {
    const x0 = curve.xs[index]!;
    const x1 = curve.xs[index + 1]!;
    const dx = x1 - x0;
    if (Math.abs(dx) < 1e-6) {
      path += `L${x1.toFixed(1)} ${curve.ys[index + 1]!.toFixed(1)}`;
      continue;
    }
    path += `C${(x0 + dx / 3).toFixed(1)} ${curve.c1y[index]!.toFixed(1)} ${(x1 - dx / 3).toFixed(1)} ${curve.c2y[index]!.toFixed(1)} ${x1.toFixed(1)} ${curve.ys[index + 1]!.toFixed(1)}`;
  }
  return path;
}

export function yAtX(pts: ReadonlyArray<ChartPx>, x: number): number {
  if (pts.length === 0) return 0;
  const first = pts[0]!;
  if (pts.length === 1 || x <= first[0]) return first[1];
  const last = pts[pts.length - 1]!;
  if (x >= last[0]) return last[1];
  for (let index = 0; index < pts.length - 1; index++) {
    const left = pts[index]!;
    const right = pts[index + 1]!;
    if (x > right[0]) continue;
    const dx = right[0] - left[0];
    if (Math.abs(dx) < 1e-6) return right[1];
    return left[1] + (right[1] - left[1]) * ((x - left[0]) / dx);
  }
  return last[1];
}

export function resamplePoints(
  pts: ReadonlyArray<ChartPx>,
  count: number,
  span?: { readonly x0?: number; readonly x1?: number; readonly baselineY?: number },
): Array<[number, number]> {
  if (count <= 0) return [];
  const baselineY = span?.baselineY ?? 0;
  const x0 = span?.x0 ?? (pts.length > 0 ? pts[0]![0] : 0);
  const x1 = span?.x1 ?? (pts.length > 0 ? pts[pts.length - 1]![0] : 0);
  const yOf = (x: number) => (pts.length === 0 ? baselineY : yAtX(pts, x));
  if (count === 1) return [[(x0 + x1) / 2, yOf((x0 + x1) / 2)]];
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const x = x0 + (x1 - x0) * t;
    return [x, yOf(x)];
  });
}

/** Sample the Fritsch–Carlson cubic, not the linear polyline. */
export function sampleSmoothCurve(
  pts: ReadonlyArray<ChartPx>,
  count: number,
  span?: { readonly x0?: number; readonly x1?: number; readonly baselineY?: number },
): Array<[number, number]> {
  if (pts.length < 2) return resamplePoints(pts, count, span);
  const curve = buildCurve(pts);
  if (!curve) return resamplePoints(pts, count, span);
  const x0 = span?.x0 ?? pts[0]![0];
  const x1 = span?.x1 ?? pts[pts.length - 1]![0];
  if (count <= 0) return [];
  if (count === 1) return [[(x0 + x1) / 2, yOnCurve(curve, (x0 + x1) / 2)]];
  return Array.from({ length: count }, (_, index) => {
    const x = x0 + (x1 - x0) * (index / (count - 1));
    return [x, yOnCurve(curve, x)];
  });
}

export function lerpPoints(
  from: ReadonlyArray<ChartPx>,
  to: ReadonlyArray<ChartPx>,
  t: number,
): Array<[number, number]> {
  const count = Math.min(from.length, to.length);
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const points: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    const a = from[index]!;
    const b = to[index]!;
    points.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return points;
}

function bezier1d(t: number, p1: number, p2: number): number {
  const rest = 1 - t;
  return 3 * rest * rest * t * p1 + 3 * rest * t * t * p2 + t * t * t;
}

function bezier1dDeriv(t: number, p1: number, p2: number): number {
  const rest = 1 - t;
  return 3 * rest * rest * p1 + 6 * rest * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** Sample along the native first→last x span so morphs do not jump to x=0. */
export function sampleForMorph(
  pts: ReadonlyArray<ChartPx>,
  count: number,
  width: number,
  baselineY: number,
): Array<[number, number]> {
  if (pts.length === 0) return resamplePoints([], count, { x0: 0, x1: width, baselineY });
  const x0 = pts[0]![0];
  const x1 = pts[pts.length - 1]![0];
  return sampleSmoothCurve(pts, count, { x0, x1, baselineY });
}

export function clampPtsToPlot(
  pts: ReadonlyArray<ChartPx>,
  padTop: number,
  plotH: number,
  width: number,
): Array<[number, number]> {
  const y1 = padTop + plotH;
  return pts.map((point) => [
    Math.min(width, Math.max(0, point[0])),
    Math.min(y1, Math.max(0, point[1])),
  ]);
}

/** CSS cubic-bezier(0.25, 0.46, 0.45, 0.94) — matches `--ease-ios`. */
export function easeIos(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let guess = t;
  for (let step = 0; step < 8; step++) {
    const current = bezier1d(guess, 0.25, 0.45) - t;
    const deriv = bezier1dDeriv(guess, 0.25, 0.45);
    if (Math.abs(deriv) < 1e-6) break;
    guess = Math.min(1, Math.max(0, guess - current / deriv));
  }
  return bezier1d(guess, 0.46, 0.94);
}
