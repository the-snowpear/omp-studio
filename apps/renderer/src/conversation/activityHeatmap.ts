import { DAY_MS, fmtTokens, intensity, startOfDay } from "../usage/tokenUsage";

/** Adjacent month labels need at least this many week columns or they collide. */
export const MONTH_LABEL_MIN_GAP = 2;
export const ACTIVITY_HEAT_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export type ActivityHeatLevel = 0 | 1 | 2 | 3 | 4;

export type ActivityHeatCell = {
  readonly ts: number;
  readonly week: number;
  readonly dow: number;
  readonly tokens: number;
  readonly level: ActivityHeatLevel;
  readonly future: boolean;
  readonly pad: boolean;
};

export type ActivityHeatMonth = {
  readonly week: number;
  readonly label: string;
};

export type ActivityHeatmap = {
  readonly weeks: number;
  readonly cells: readonly ActivityHeatCell[];
  readonly months: readonly ActivityHeatMonth[];
  readonly tokens: number;
  readonly activeDays: number;
  readonly heatCap: number;
};

export function usageLevel(tokens: number, cap: number): ActivityHeatLevel {
  if (tokens <= 0 || cap <= 0) return 0;
  return Math.min(4, Math.ceil(intensity(tokens, cap) * 5) - 1) as ActivityHeatLevel;
}

export function heatDayLabel(ts: number): string {
  const date = new Date(ts);
  const weekday = ACTIVITY_HEAT_WEEKDAYS[(date.getDay() + 6) % 7] ?? "";
  return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday}`;
}

export function heatCellTip(cell: ActivityHeatCell): string {
  const day = heatDayLabel(cell.ts);
  if (cell.future) return `未来 · ${day}`;
  if (cell.pad) return day;
  return cell.tokens > 0 ? `${fmtTokens(cell.tokens)} tok · ${day}` : `无用量 · ${day}`;
}

export function yearWindowStart(now = Date.now()): {
  readonly today: number;
  readonly yearStart: number;
  readonly yearEnd: number;
  readonly start: number;
  readonly weeks: number;
} {
  const today = startOfDay(now);
  const year = new Date(today).getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEnd = new Date(year, 11, 31).getTime();
  const start = yearStart - ((new Date(yearStart).getDay() + 6) % 7) * DAY_MS;
  const weeks = Math.floor((yearEnd - start) / (7 * DAY_MS)) + 1;
  return { today, yearStart, yearEnd, start, weeks };
}

export function buildActivityHeatmap(
  totalsByDay: ReadonlyMap<number, number>,
  now = Date.now(),
): ActivityHeatmap {
  const { today, yearStart, yearEnd, start, weeks } = yearWindowStart(now);
  const windowTotals: number[] = [];
  const cells: ActivityHeatCell[] = [];
  const months: ActivityHeatMonth[] = [];
  let prevMonth = -1;

  for (let week = 0; week < weeks; week++) {
    const weekTs = start + week * 7 * DAY_MS;
    const month = new Date(weekTs < yearStart ? yearStart : weekTs).getMonth();
    if (month !== prevMonth) {
      const last = months[months.length - 1];
      if (last === undefined || week - last.week >= MONTH_LABEL_MIN_GAP) {
        months.push({ week, label: `${month + 1}月` });
      }
      prevMonth = month;
    }
    for (let dow = 0; dow < 7; dow++) {
      const ts = start + (week * 7 + dow) * DAY_MS;
      const pad = ts < yearStart || ts > yearEnd;
      const future = !pad && ts > today;
      const value = future || pad ? 0 : (totalsByDay.get(ts) ?? 0);
      if (!future && !pad) windowTotals.push(value);
      cells.push({ ts, week, dow, tokens: value, level: 0, future, pad });
    }
  }

  const tokens = windowTotals.reduce((sum, value) => sum + value, 0);
  const activeDays = windowTotals.filter((value) => value > 0).length;
  const heatCap = Math.max(1, ...windowTotals);
  return {
    weeks,
    cells: cells.map((cell) => (
      cell.future || cell.pad ? cell : { ...cell, level: usageLevel(cell.tokens, heatCap) }
    )),
    months,
    tokens,
    activeDays,
    heatCap,
  };
}
