import { useLayoutEffect, useRef, useState } from "react";
import { pageMotionReduced } from "../pageTransition";
import {
  CHART_AXIS_FADE_MS,
  CHART_MORPH_MS,
  CHART_SAMPLE_COUNT,
  clampPtsToPlot,
  easeIos,
  lerpPoints,
  sampleForMorph,
  smoothPath,
  type ChartPx,
} from "./tokenChart";

export type TokenChartModelPts = {
  readonly id: string;
  readonly pts: ReadonlyArray<ChartPx>;
};

export type TokenChartModelPath = {
  readonly id: string;
  readonly pts: ReadonlyArray<ChartPx>;
  readonly path: string;
};

type SampleMap = Map<string, Array<[number, number]>>;

function chartMotionReduced(): boolean {
  return typeof window.matchMedia === "function" && pageMotionReduced();
}

function uniqueIds(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...left, ...right]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function nativePaths(models: readonly TokenChartModelPts[]): TokenChartModelPath[] {
  return models.map((model) => ({
    id: model.id,
    pts: model.pts,
    path: model.pts.length >= 2 ? smoothPath(model.pts) : "",
  }));
}

function pathOf(id: string, pts: ReadonlyArray<ChartPx>): TokenChartModelPath {
  return { id, pts, path: pts.length >= 2 ? smoothPath(pts) : "" };
}

function pathsEqual(left: readonly TokenChartModelPath[], right: readonly TokenChartModelPath[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.id === other.id && entry.path === other.path;
  });
}

export function useTokenChartMorph(
  models: readonly TokenChartModelPts[],
  options: {
    readonly view: string;
    readonly width: number;
    readonly padTop: number;
    readonly plotH: number;
  },
): { paths: readonly TokenChartModelPath[]; morphing: boolean } {
  const { view, width, padTop, plotH } = options;
  const baselineY = padTop + plotH;
  const [paths, setPaths] = useState<TokenChartModelPath[]>([]);
  const [morphing, setMorphing] = useState(false);
  const viewRef = useRef(view);
  const widthRef = useRef(width);
  const modelsRef = useRef(models);
  const displayRef = useRef<SampleMap>(new Map());
  const fromRef = useRef<SampleMap>(new Map());
  const toRef = useRef<SampleMap>(new Map());
  const idsRef = useRef<string[]>([]);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const morphingRef = useRef(false);
  const primedRef = useRef(false);
  modelsRef.current = models;

  const stop = () => {
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  const writePaths = (next: TokenChartModelPath[]) => {
    setPaths((prev) => (pathsEqual(prev, next) ? prev : next));
  };

  const sampleModel = (pts: ReadonlyArray<ChartPx>) =>
    clampPtsToPlot(sampleForMorph(pts, CHART_SAMPLE_COUNT, width, baselineY), padTop, plotH, width);

  const sampleAll = (next: readonly TokenChartModelPts[]): SampleMap => {
    const map: SampleMap = new Map();
    for (const model of next) map.set(model.id, sampleModel(model.pts));
    return map;
  };

  const applyNative = (next: readonly TokenChartModelPts[]) => {
    stop();
    morphingRef.current = false;
    setMorphing((prev) => (prev ? false : prev));
    displayRef.current = width < 8 ? new Map() : sampleAll(next);
    idsRef.current = next.map((model) => model.id);
    writePaths(width < 8 ? [] : nativePaths(next));
  };

  useLayoutEffect(() => {
    const next = modelsRef.current;
    const viewChanged = viewRef.current !== view;
    const widthChanged = widthRef.current !== width;
    const firstPaint = !primedRef.current;
    viewRef.current = view;
    widthRef.current = width;
    primedRef.current = true;

    if (width < 8 || firstPaint || chartMotionReduced() || widthChanged || !viewChanged) {
      if (morphingRef.current && width >= 8 && !widthChanged && !viewChanged) {
        toRef.current = sampleAll(next);
        return stop;
      }
      applyNative(next);
      return stop;
    }

    const target = sampleAll(next);
    const from: SampleMap = new Map();
    const to: SampleMap = new Map();
    const liveIds = uniqueIds([...displayRef.current.keys()], next.map((model) => model.id));
    const flat = sampleModel([]);
    for (const id of liveIds) {
      from.set(id, displayRef.current.get(id) ?? flat);
      to.set(id, target.get(id) ?? flat);
    }
    fromRef.current = from;
    toRef.current = to;
    idsRef.current = liveIds;
    startRef.current = performance.now();
    morphingRef.current = true;
    setMorphing(true);
    stop();

    const tick = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / CHART_MORPH_MS);
      const eased = easeIos(t);
      const mixed: SampleMap = new Map();
      const nextPaths: TokenChartModelPath[] = [];
      for (const id of idsRef.current) {
        const a = fromRef.current.get(id);
        const b = toRef.current.get(id);
        if (!a || !b) continue;
        const pts = clampPtsToPlot(lerpPoints(a, b, eased), padTop, plotH, width);
        mixed.set(id, pts);
        nextPaths.push(pathOf(id, pts));
      }
      displayRef.current = mixed;
      writePaths(nextPaths);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
        return;
      }
      applyNative(modelsRef.current);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return stop;
  }, [padTop, plotH, view, width]);

  useLayoutEffect(() => {
    if (!primedRef.current) return;
    if (morphingRef.current) {
      if (width >= 8) toRef.current = sampleAll(models);
      return;
    }
    applyNative(models);
  }, [models, padTop, plotH, width]);

  return { paths, morphing };
}

export function useAxisCrossfade<T>(value: T, view: string): {
  incoming: T;
  outgoing: T | null;
  live: boolean;
} {
  const [outgoing, setOutgoing] = useState<T | null>(null);
  const [live, setLive] = useState(false);
  const viewRef = useRef(view);
  const valueRef = useRef(value);

  useLayoutEffect(() => {
    if (viewRef.current === view) {
      valueRef.current = value;
      return;
    }
    const previous = valueRef.current;
    viewRef.current = view;
    valueRef.current = value;
    if (chartMotionReduced()) {
      setOutgoing(null);
      setLive(false);
      return;
    }
    setOutgoing(previous);
    setLive(true);
    const timer = window.setTimeout(() => {
      setOutgoing(null);
      setLive(false);
    }, CHART_AXIS_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [value, view]);

  return { incoming: value, outgoing, live };
}
