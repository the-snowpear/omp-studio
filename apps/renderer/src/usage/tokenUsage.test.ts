import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  buildPreviewUsage,
  parseDateKey,
  startOfDay,
} from "./tokenUsage";

function longestRun(values: readonly number[], pred: (value: number) => boolean): number {
  let best = 0;
  let current = 0;
  for (const value of values) {
    if (pred(value)) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

describe("preview token usage", () => {
  it("leaves the rest of the year empty and mixes heavy, light, and unused days in the past", () => {
    const now = Date.parse("2026-08-19T12:00:00");
    const today = startOfDay(now);
    const yearStart = new Date(2026, 0, 1).getTime();
    const usage = buildPreviewUsage(now);
    const byDate = new Map(usage.days.map((day) => [parseDateKey(day.date), day.totalTokens]));
    const past: number[] = [];
    for (let ts = yearStart; ts <= today; ts += DAY_MS) {
      past.push(byDate.get(ts) ?? 0);
    }
    const active = past.filter((value) => value > 0);
    const unused = past.length - active.length;
    const light = active.filter((value) => value < 8_000);
    const heavy = active.filter((value) => value > 30_000);

    expect(usage.days.every((day) => parseDateKey(day.date) <= today)).toBe(true);
    expect(unused).toBeGreaterThan(past.length * 0.35);
    expect(active.length).toBeGreaterThan(past.length * 0.18);
    expect(active.length / past.length).toBeLessThan(0.65);
    expect(light.length).toBeGreaterThan(0);
    expect(heavy.length).toBeGreaterThan(0);
    expect(longestRun(past, (value) => value === 0)).toBeGreaterThanOrEqual(7);
    expect(longestRun(past, (value) => value > 0)).toBeGreaterThanOrEqual(3);
  });
});
