import type { ModelCostMeta, ModelLongContextPrice, ModelPricingMeta } from "./read-models.js";

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function rates(value: unknown): ModelCostMeta | undefined {
  const source = record(value);
  if (!source || RATE_KEYS.some(key => !nonnegative(source[key]))) return undefined;
  return Object.fromEntries(RATE_KEYS.map(key => [key, source[key]])) as ModelCostMeta;
}

function tier(value: unknown): ModelLongContextPrice | undefined {
  const source = record(value);
  const cost = rates(value);
  if (!source || !cost || !nonnegative(source.inputThreshold) || source.inputThreshold <= 0) return undefined;
  if (source.inputThresholdInclusive !== undefined && typeof source.inputThresholdInclusive !== "boolean") return undefined;
  return {
    ...cost,
    inputThreshold: source.inputThreshold,
    ...(typeof source.inputThresholdInclusive === "boolean" ? { inputThresholdInclusive: source.inputThresholdInclusive } : {}),
  };
}

export function parseModelPricing(value: unknown): ModelPricingMeta | undefined {
  const source = record(value);
  if (!source) return undefined;
  const longContext = tier(source.longContext);
  const schedule = record(source.timeBased);
  let timeBased: ModelPricingMeta["timeBased"];
  if (schedule && nonnegative(schedule.offPeakMultiplier) && Array.isArray(schedule.peakWindows)) {
    const windows: { weekdays: number[]; startMinute: number; endMinute: number }[] = [];
    let valid = true;
    for (const candidate of schedule.peakWindows) {
      const window = record(candidate);
      if (!window || !Array.isArray(window.weekdays) || window.weekdays.length === 0 ||
        window.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(window.weekdays).size !== window.weekdays.length ||
        !Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute) ||
        (window.startMinute as number) < 0 || (window.endMinute as number) > 1440 ||
        (window.startMinute as number) >= (window.endMinute as number)) {
        valid = false;
        break;
      }
      windows.push({ weekdays: [...window.weekdays], startMinute: window.startMinute as number, endMinute: window.endMinute as number });
    }
    const effectiveRates: (ModelCostMeta & { effectiveFrom: number; longContext?: ModelLongContextPrice })[] = [];
    const dates = new Set<number>();
    if (schedule.effectiveRates !== undefined) {
      if (!Array.isArray(schedule.effectiveRates)) valid = false;
      else for (const candidate of schedule.effectiveRates) {
        const entry = record(candidate);
        const cost = rates(candidate);
        const threshold = tier(entry?.longContext);
        if (!entry || !cost || !Number.isSafeInteger(entry.effectiveFrom) ||
          Math.abs(entry.effectiveFrom as number) > 8_640_000_000_000_000 ||
          dates.has(entry.effectiveFrom as number) || (entry.longContext !== undefined && !threshold)) {
          valid = false;
          break;
        }
        dates.add(entry.effectiveFrom as number);
        effectiveRates.push({ ...cost, effectiveFrom: entry.effectiveFrom as number, ...(threshold ? { longContext: threshold } : {}) });
      }
    }
    if (valid) timeBased = {
      offPeakMultiplier: schedule.offPeakMultiplier,
      peakWindows: windows,
      ...(schedule.effectiveRates === undefined ? {} : { effectiveRates }),
    };
  }
  if (!longContext && !timeBased) return undefined;
  return { ...(longContext ? { longContext } : {}), ...(timeBased ? { timeBased } : {}) };
}

export function resolveModelPrice(
  base: ModelCostMeta | undefined,
  pricing: ModelPricingMeta | undefined,
  timestamp = Date.now(),
  promptInputTokens = 0,
): { cost: ModelCostMeta | undefined; period?: "peak" | "off-peak"; longContext: boolean } {
  let cost = base;
  let threshold = pricing?.longContext;
  let effectiveFrom = -Infinity;
  for (const candidate of pricing?.timeBased?.effectiveRates ?? []) {
    if (candidate.effectiveFrom <= timestamp && candidate.effectiveFrom > effectiveFrom) {
      cost = candidate;
      threshold = candidate.longContext;
      effectiveFrom = candidate.effectiveFrom;
    }
  }
  const longContext = threshold !== undefined && (promptInputTokens > threshold.inputThreshold ||
    (threshold.inputThresholdInclusive === true && promptInputTokens === threshold.inputThreshold));
  if (longContext) cost = threshold;
  const schedule = pricing?.timeBased;
  if (!schedule) return { cost, longContext };
  const date = new Date(timestamp);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const peak = schedule.peakWindows.some(window => window.weekdays.includes(date.getUTCDay()) &&
    minute >= window.startMinute && minute < window.endMinute);
  const multiplier = peak ? 1 : schedule.offPeakMultiplier;
  return {
    cost: cost === undefined ? undefined : Object.fromEntries(RATE_KEYS.flatMap(key => cost?.[key] === undefined ? [] : [[key, cost[key] * multiplier]])),
    period: peak ? "peak" : "off-peak",
    longContext,
  };
}
