import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_MORPH_MS, smoothPath } from "./tokenChart";
import { useTokenChartMorph, type TokenChartModelPts } from "./useTokenChartMorph";

const PAD_TOP = 10;
const PLOT_H = 178;
const BASELINE_Y = PAD_TOP + PLOT_H;
const CURVE: TokenChartModelPts = {
  id: "claude",
  pts: [[20, 40], [80, 20], [140, 60]],
};

function pathPairs(d: string): Array<[number, number]> {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 1 < nums.length; index += 2) {
    pairs.push([nums[index]!, nums[index + 1]!]);
  }
  return pairs;
}

function firstY(d: string): number {
  return pathPairs(d)[0]![1];
}

function ChartProbe(props: {
  readonly models: readonly TokenChartModelPts[];
  readonly view?: string;
  readonly width?: number;
}) {
  const { paths, morphing } = useTokenChartMorph(props.models, {
    view: props.view ?? "month",
    width: props.width ?? 200,
    padTop: PAD_TOP,
    plotH: PLOT_H,
  });
  return (
    <div>
      <span data-testid="morph">{morphing ? "1" : "0"}</span>
      {paths.map((entry) => (
        <span key={entry.id} data-testid={`path-${entry.id}`}>{entry.path}</span>
      ))}
    </div>
  );
}

describe("useTokenChartMorph intro", () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    now = 0;
    frames = [];
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      frames = [];
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function flush(at: number) {
    now = at;
    const queued = frames.splice(0);
    act(() => {
      for (const callback of queued) callback(at);
    });
  }

  it("rises from the zero baseline instead of jumping to the live curve", () => {
    render(<ChartProbe models={[CURVE]} />);
    const path = screen.getByTestId("path-claude").textContent ?? "";
    expect(screen.getByTestId("morph").textContent).toBe("1");
    expect(pathPairs(path).every((point) => point[1] === BASELINE_Y)).toBe(true);

    flush(CHART_MORPH_MS);
    expect(screen.getByTestId("morph").textContent).toBe("0");
    expect(screen.getByTestId("path-claude").textContent).toBe(smoothPath(CURVE.pts));
  });

  it("waits for width and still rises instead of snapping", () => {
    const view = render(<ChartProbe models={[CURVE]} width={0} />);
    expect(screen.queryByTestId("path-claude")).toBeNull();

    view.rerender(<ChartProbe models={[CURVE]} width={200} />);
    const path = screen.getByTestId("path-claude").textContent ?? "";
    expect(screen.getByTestId("morph").textContent).toBe("1");
    expect(firstY(path)).toBe(BASELINE_Y);

    flush(CHART_MORPH_MS);
    expect(screen.getByTestId("path-claude").textContent).toBe(smoothPath(CURVE.pts));
  });

  it("skips the rise when motion is reduced", () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;

    render(<ChartProbe models={[CURVE]} />);
    expect(screen.getByTestId("morph").textContent).toBe("0");
    expect(screen.getByTestId("path-claude").textContent).toBe(smoothPath(CURVE.pts));
    expect(frames).toHaveLength(0);
  });
});
