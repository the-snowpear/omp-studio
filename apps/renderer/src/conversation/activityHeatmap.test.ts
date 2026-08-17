import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HEAT_DAYS,
  MONTH_LABEL_MIN_GAP,
  buildActivityHeatmap,
  heatCellTip,
  usageLevel,
  yearWindowStart,
} from "./activityHeatmap";
import { DAY_MS, startOfDay } from "../usage/tokenUsage";

describe("activity heatmap", () => {
  it("covers 365 inclusive days on a Monday-aligned board", () => {
    const now = Date.parse("2026-08-17T12:00:00");
    const today = startOfDay(now);
    const map = new Map<number, number>([[today, 1200], [today - DAY_MS, 400]]);
    const heat = buildActivityHeatmap(map, now);
    const window = yearWindowStart(now);

    expect(heat.weeks).toBe(window.weeks);
    expect(window.weeks).toBeGreaterThanOrEqual(53);
    expect(window.weeks).toBeLessThanOrEqual(54);
    expect(heat.cells).toHaveLength(window.weeks * 7);
    expect(new Date(heat.cells[0]!.ts).getDay()).toBe(1);
    expect(heat.cells.filter((cell) => !cell.future && !cell.pad)).toHaveLength(ACTIVITY_HEAT_DAYS);
    expect(heat.tokens).toBe(1600);
    expect(heat.activeDays).toBe(2);
    expect(heat.cells.filter((cell) => cell.future || cell.pad).every((cell) => cell.level === 0 && cell.tokens === 0)).toBe(true);
    expect(heat.cells.find((cell) => cell.ts === today)?.level).toBeGreaterThan(0);
  });

  it("skips month labels that would sit on adjacent week columns", () => {
    const heat = buildActivityHeatmap(new Map(), Date.parse("2026-08-17T12:00:00"));
    for (let index = 1; index < heat.months.length; index++) {
      expect(heat.months[index]!.week - heat.months[index - 1]!.week).toBeGreaterThanOrEqual(MONTH_LABEL_MIN_GAP);
    }
    expect(heat.months.map((month) => month.label)).toContain("8月");
  });

  it("does not place 11月 and 12月 on neighboring columns", () => {
    const heat = buildActivityHeatmap(new Map(), Date.parse("2026-11-29T12:00:00"));
    const labels = heat.months.map((month) => month.label);
    const nov = heat.months.find((month) => month.label === "11月");
    const dec = heat.months.find((month) => month.label === "12月");
    expect(labels).toContain("11月");
    if (nov !== undefined && dec !== undefined) {
      expect(dec.week - nov.week).toBeGreaterThanOrEqual(MONTH_LABEL_MIN_GAP);
    }
  });

  it("maps token intensity onto the same 0–4 steps as the homepage", () => {
    expect(usageLevel(0, 1000)).toBe(0);
    expect(usageLevel(100, 1000)).toBe(1);
    expect(usageLevel(1000, 1000)).toBe(4);
    expect(heatCellTip({ ts: Date.parse("2026-08-17T00:00:00"), week: 0, dow: 0, tokens: 0, level: 0, future: false, pad: false })).toMatch(/^无用量/);
    expect(heatCellTip({ ts: Date.parse("2026-08-17T00:00:00"), week: 0, dow: 0, tokens: 1200, level: 2, future: false, pad: false })).toContain("1.2k tok");
  });
});
