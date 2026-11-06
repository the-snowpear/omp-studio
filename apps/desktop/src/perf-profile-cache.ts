/** The persisted profile is untrusted; Main IPC carries the parsed snapshot. */
import type { PerfMotion, PerfProfileSnapshot, PerfTier } from "./perf-profile-shared.js";

const PERF_TIERS: readonly PerfTier[] = ["L0", "L1", "L2", "L3"];
const PERF_MOTION_POLICIES: readonly PerfMotion[] = ["full", "reduced", "off"];
const MAX_TEXT = 200;
const MAX_REASONS = 12;
const MAX_CORES = 4_096;
const MAX_MEMORY = 64 * 1024 ** 4;
const PROBED_AT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u;
const CACHE_FIELDS = new Set([
  "tier", "motion", "softwareCompositing", "gpuCompositing", "canvas2d", "glRenderer",
  "cores", "totalMemoryBytes", "onBattery", "reasons", "probedAt", "source",
]);

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined;
}

/** Reject an unreadable cache whole rather than silently mis-grading first paint. */
export function parsePerfProfileSnapshot(value: unknown): PerfProfileSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !CACHE_FIELDS.has(key))) return undefined;
  if (typeof raw.tier !== "string" || !PERF_TIERS.includes(raw.tier as PerfTier)) return undefined;
  if (typeof raw.motion !== "string" || !PERF_MOTION_POLICIES.includes(raw.motion as PerfMotion)) return undefined;
  if (typeof raw.softwareCompositing !== "boolean" || typeof raw.onBattery !== "boolean") return undefined;
  const gpuCompositing = boundedText(raw.gpuCompositing);
  const canvas2d = boundedText(raw.canvas2d);
  const probedAt = boundedText(raw.probedAt);
  if (gpuCompositing === undefined || canvas2d === undefined || probedAt === undefined) return undefined;
  if (!PROBED_AT.test(probedAt)) return undefined;
  if (raw.glRenderer !== null && boundedText(raw.glRenderer) === undefined) return undefined;
  const { cores, totalMemoryBytes } = raw;
  if (typeof cores !== "number" || !Number.isSafeInteger(cores) || cores < 0 || cores > MAX_CORES) return undefined;
  if (typeof totalMemoryBytes !== "number" || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes < 0 || totalMemoryBytes > MAX_MEMORY) return undefined;
  if (!Array.isArray(raw.reasons) || raw.reasons.length > MAX_REASONS) return undefined;
  const reasons: string[] = [];
  for (const reason of raw.reasons) {
    const text = boundedText(reason);
    if (text === undefined) return undefined;
    reasons.push(text);
  }
  if (raw.source !== "probe" && raw.source !== "cache") return undefined;
  return {
    tier: raw.tier as PerfTier,
    motion: raw.motion as PerfMotion,
    softwareCompositing: raw.softwareCompositing,
    gpuCompositing,
    canvas2d,
    glRenderer: raw.glRenderer === null ? null : raw.glRenderer as string,
    cores,
    totalMemoryBytes,
    onBattery: raw.onBattery,
    reasons,
    probedAt,
    source: raw.source,
  };
}
