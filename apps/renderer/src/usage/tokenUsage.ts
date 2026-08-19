import type { TokenUsageReadModel } from "@omp-studio/client-contract";

export const DAY_MS = 86_400_000;
export const USAGE_POLL_MS = 30_000;

export const EMPTY_USAGE: TokenUsageReadModel = {
  generatedAt: "",
  days: [],
  models: [],
  byModel: [],
  hours: [],
};

type TokenDay = { readonly date: number; readonly claude: number; readonly codex: number; readonly total: number };

export function startOfDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function localDateKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDateKey(date: string): number {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) return Number.NaN;
  return new Date(year, month - 1, day).getTime();
}

function seedBy(i: number, salt: number): number {
  const value = Math.sin((i + 1) * 37.719 + salt * 97.31) * 46638.9426;
  return value - Math.floor(value);
}

function isQuietPreviewDay(month: number, day: number): boolean {
  if (month === 0 && day <= 11) return true;
  if (month === 1 && day >= 15 && day <= 23) return true;
  if (month === 3 && day >= 4 && day <= 12) return true;
  if (month === 4 && day >= 1 && day <= 5) return true;
  if (month === 6 && day >= 10 && day <= 27) return true;
  return false;
}

function isCrunchPreviewDay(month: number, day: number): boolean {
  return (month === 2 && day >= 16 && day <= 20) || (month === 7 && day >= 3 && day <= 7);
}

function weekdayUseChance(month: number): number {
  if (month <= 1) return 0.32;
  if (month <= 3) return 0.48;
  if (month <= 5) return 0.55;
  if (month === 6) return 0.5;
  return 0.58;
}

function previewTokensForDay(date: number): TokenDay {
  const d = new Date(date);
  const month = d.getMonth();
  const day = d.getDate();
  const dow = d.getDay();
  const weekend = dow === 0 || dow === 6;
  const salt = month * 50 + day;
  const roll = seedBy(salt, 7);
  if (isQuietPreviewDay(month, day) || (weekend && roll > 0.12) || (!weekend && roll > weekdayUseChance(month))) {
    return { date, claude: 0, codex: 0, total: 0 };
  }
  const crunch = isCrunchPreviewDay(month, day);
  const light = !crunch && seedBy(salt, 4) < 0.38;
  const base = crunch ? 62_000 : light ? 3_800 : weekend ? 8_500 : 20_500;
  const amount = Math.round(base * (0.72 + seedBy(salt, 1) * 0.5));
  const claude = Math.round(amount * (0.52 + seedBy(salt, 2) * 0.12));
  return { date, claude, codex: amount - claude, total: amount };
}

/** Preview-only series: sparse real-looking year, no future days. */
function buildMockTokenUsage(now = Date.now()): TokenDay[] {
  const today = startOfDay(now);
  const yearStart = new Date(new Date(today).getFullYear(), 0, 1).getTime();
  const days: TokenDay[] = [];
  for (let date = yearStart; date <= today; date += DAY_MS) {
    days.push(previewTokensForDay(date));
  }
  return days;
}

export function buildPreviewUsage(now = Date.now()): TokenUsageReadModel {
  const mock = buildMockTokenUsage(now);
  const days = mock.map((day) => ({ date: localDateKey(day.date), totalTokens: day.total }));
  const byModel = mock.flatMap((day) => {
    const date = localDateKey(day.date);
    const rows: TokenUsageReadModel["byModel"][number][] = [];
    if (day.claude > 0) rows.push({ date, model: "claude", tokens: day.claude });
    if (day.codex > 0) rows.push({ date, model: "codex", tokens: day.codex });
    return rows;
  });
  const weekend = new Date(now).getDay() === 0 || new Date(now).getDay() === 6;
  const hours: TokenUsageReadModel["hours"][number][] = [];
  for (let hour = 0; hour < 24; hour++) {
    let value = 200 + ((hour * 17) % 350);
    if (hour >= 9 && hour <= 12) value = 1800 + ((hour * 31) % 1100);
    else if (hour >= 14 && hour <= 18) value = 2200 + ((hour * 41) % 1400);
    else if (hour >= 1 && hour <= 5) value = 0;
    else if (hour === 13 || hour === 19) value = 800;
    const total = weekend ? Math.round(value * 0.45) : value;
    if (total <= 0) continue;
    const claude = Math.round(total * 0.58);
    hours.push({ hour, model: "claude", tokens: claude });
    hours.push({ hour, model: "codex", tokens: total - claude });
  }
  return {
    generatedAt: new Date(now).toISOString(),
    days,
    models: [{ id: "claude" }, { id: "codex" }],
    byModel,
    hours,
  };
}

export function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

export function intensity(value: number, cap: number): number {
  if (value <= 0 || cap <= 0) return 0;
  return Math.min(1, Math.pow(value / cap, 0.5));
}

export function totalsByDayFromUsage(usage: TokenUsageReadModel): Map<number, number> {
  const map = new Map<number, number>();
  for (const day of usage.days) {
    const ts = parseDateKey(day.date);
    if (!Number.isFinite(ts)) continue;
    map.set(ts, day.totalTokens);
  }
  return map;
}
