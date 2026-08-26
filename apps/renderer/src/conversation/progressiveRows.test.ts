import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "./conversationViewModel";
import { FIRST_PAINT_ROWS, useProgressiveRows } from "./progressiveRows";

function rows(count: number, prefix = "u"): readonly TimelineRow[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "user" as const,
    itemId: `${prefix}${index}`,
    text: `line ${index}`,
    createdAt: "2026-08-25T00:00:00.000Z",
  })) as unknown as readonly TimelineRow[];
}

/** 手动驱动动画帧：不靠真实时钟，帧由测试自己放行。 */
let pendingFrames: FrameRequestCallback[] = [];

beforeEach(() => {
  pendingFrames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => pendingFrames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    pendingFrames[handle - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runFrames(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    const batch = pendingFrames;
    pendingFrames = [];
    await act(async () => {
      for (const callback of batch) callback(0);
    });
  }
}

describe("useProgressiveRows", () => {
  it("renders a small transcript in one pass", () => {
    const all = rows(FIRST_PAINT_ROWS);
    const { result } = renderHook(({ input }) => useProgressiveRows(input), {
      initialProps: { input: all },
    });
    expect(result.current).toBe(all);
    expect(pendingFrames).toHaveLength(0);
  });

  it("paints the tail first and fills in the rest across frames", async () => {
    const all = rows(50);
    const { result } = renderHook(({ input }) => useProgressiveRows(input), {
      initialProps: { input: all },
    });
    expect(result.current).toHaveLength(FIRST_PAINT_ROWS);
    // 贴底渲染：先出现的是最新的那些行。
    expect(result.current.at(-1)).toBe(all.at(-1));
    expect(result.current[0]).toBe(all[all.length - FIRST_PAINT_ROWS]);

    await runFrames(3);
    expect(result.current).toBe(all);
  });

  it("does not throttle steady-state appends", async () => {
    const first = rows(50);
    const { result, rerender } = renderHook(({ input }) => useProgressiveRows(input), {
      initialProps: { input: first },
    });
    await runFrames(3);
    expect(result.current).toBe(first);

    const grown = [...first, ...rows(1, "next")] as readonly TimelineRow[];
    rerender({ input: grown });
    expect(result.current).toBe(grown);
  });

  it("stages again after the transcript is unmounted and a new one arrives", async () => {
    const { result, rerender } = renderHook(({ input }) => useProgressiveRows(input), {
      initialProps: { input: rows(50) },
    });
    await runFrames(3);

    const empty: readonly TimelineRow[] = [];
    rerender({ input: empty });
    await runFrames(1);
    expect(result.current).toBe(empty);

    const next = rows(50, "b");
    rerender({ input: next });
    expect(result.current).toHaveLength(FIRST_PAINT_ROWS);
    await runFrames(3);
    expect(result.current).toBe(next);
  });
});
