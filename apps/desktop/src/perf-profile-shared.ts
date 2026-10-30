/**
 * GPU / performance profile contract shared by Main and the sandboxed preload.
 *
 * P0-6 splits in two halves:
 * - Main probes reliable GPU/power facts (`app.getGPUFeatureStatus()`, the
 *   `getGPUInfo("complete")` renderer string, cores, memory, battery) and
 *   grades them into L0–L3 — `apps/desktop/src/perf-profile.ts`.
 * - This module is the wire shape the preload exposes read-only to the
 *   Renderer, plus the guard for what may cross that boundary. Nothing here
 *   is writable from the Renderer: `probe` re-reads Main's snapshot, `cached`
 *   is a synchronous copy of the last snapshot for first-paint decisions, and
 *   `changed` is a Main → Renderer push.
 *
 * The Renderer-side tier→attribute/CSS mapping and the user override
 * (`motion: off`, `gpuTier`) live in the Renderer (`apps/renderer/src/perf/`):
 * this module reports the machine, not the user's preference.
 */

/** L0 full / L1 reduced continuous animation / L2 software compositing / L3 low spec. */
export type PerfTier = "L0" | "L1" | "L2" | "L3";

/** Suggested motion policy; the user setting may override it in the Renderer. */
export type PerfMotion = "full" | "reduced" | "off";

export const PERF_TIERS: readonly PerfTier[] = ["L0", "L1", "L2", "L3"];
export const PERF_MOTION_POLICIES: readonly PerfMotion[] = ["full", "reduced", "off"];

/**
 * Read-only performance profile. Every field is a fact about the machine plus
 * the grading derived from it; `reasons` carries the evidence in the same
 * order the grader applied it, so a wrong tier can be diagnosed from a log.
 */
export interface PerfProfileSnapshot {
  /** Graded machine class. */
  readonly tier: PerfTier;
  /** Motion policy Main suggests for this tier (Renderer may tighten it). */
  readonly motion: PerfMotion;
  /** True when Chromium is compositing in software (SwiftShader / WARP / `*_software`). */
  readonly softwareCompositing: boolean;
  /** Raw `app.getGPUFeatureStatus().gpu_compositing`; empty when unavailable. */
  readonly gpuCompositing: string;
  /** Raw `app.getGPUFeatureStatus()["2d_canvas"]`; empty when unavailable. */
  readonly canvas2d: string;
  /** GL renderer string from `app.getGPUInfo("complete")`; null when not needed/available. */
  readonly glRenderer: string | null;
  /** `os.cpus().length`. */
  readonly cores: number;
  /** `os.totalmem()`. */
  readonly totalMemoryBytes: number;
  /** `powerMonitor.isOnBatteryPower()` at probe time. */
  readonly onBattery: boolean;
  /** Grading evidence, e.g. `gpu_compositing=unavailable_software`. */
  readonly reasons: readonly string[];
  /** ISO timestamp of the probe that produced this snapshot. */
  readonly probedAt: string;
  /** `probe` = measured now; `cache` = read from disk at startup. */
  readonly source: "probe" | "cache";
}

/** Desktop-chrome IPC channels for the perf profile (not Host transport). */
export const PERF_PROFILE_CHANNELS = {
  /** Renderer -> Main (invoke): current snapshot, re-probing when stale. */
  probe: "omp-studio:desktop:perf-profile-probe",
  /** Renderer -> Main (sendSync, preload only): last snapshot, no probe. */
  cached: "omp-studio:desktop:perf-profile-cached",
  /** Main -> Renderer: a fresh snapshot after a GPU/power change. */
  changed: "omp-studio:desktop:perf-profile-changed",
} as const;

const MAX_TEXT = 200;
const MAX_REASONS = 12;
const MAX_CORES = 4_096;
const MAX_MEMORY = 64 * 1024 ** 4;
const PROBED_AT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u;

/** Text field of a cross-process payload: bounded, never silently truncated. */
function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= MAX_TEXT ? value : undefined;
}

/**
 * Validate a snapshot crossing a process boundary (cache file, IPC push,
 * preload sync read). Unknown shapes are rejected whole rather than partially
 * patched: a half-valid profile would silently mis-grade the UI.
 */
export function parsePerfProfileSnapshot(value: unknown): PerfProfileSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "tier",
    "motion",
    "softwareCompositing",
    "gpuCompositing",
    "canvas2d",
    "glRenderer",
    "cores",
    "totalMemoryBytes",
    "onBattery",
    "reasons",
    "probedAt",
    "source",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return undefined;
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
    glRenderer: raw.glRenderer === null ? null : (raw.glRenderer as string),
    cores,
    totalMemoryBytes,
    onBattery: raw.onBattery,
    reasons,
    probedAt,
    source: raw.source,
  };
}

/** IPC sender subset the perf channels need; Electron WebContents satisfies it. */
export interface PerfProfileSender {
  isDestroyed(): boolean;
  getURL(): string;
}

/** Sync read/write subset for the on-disk snapshot cache (test seam). */
export interface PerfProfileApiIpc {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  sendSync(channel: string): unknown;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

/** Read-only surface exposed by the preload as `window.ompStudioPerf`. */
export interface OmpStudioPerfApi {
  /**
   * Last snapshot Main knows about, read synchronously at preload time.
   * Null on the very first run (nothing cached yet). Safe for the first paint:
   * no IPC round-trip, no flash of the wrong tier.
   */
  readonly cached: PerfProfileSnapshot | null;
  /** Ask Main for the current snapshot (re-probes when the last one is stale). */
  probe(): Promise<PerfProfileSnapshot>;
  /** Subscribe to snapshots Main re-probes after a GPU or power change. */
  onChanged(listener: (snapshot: PerfProfileSnapshot) => void): () => void;
}

/**
 * Build `window.ompStudioPerf`. Frozen so the renderer cannot add fields, and
 * deliberately read-only: there is no method that writes anything to Main.
 */
export function createPerfProfileApi(ipc: PerfProfileApiIpc): OmpStudioPerfApi {
  let cached: PerfProfileSnapshot | null = null;
  try {
    // `sendSync` keeps this available before the first paint. It is one tiny
    // object once per document, and a handler-less Main throws instead of
    // blocking, hence the guard.
    cached = parsePerfProfileSnapshot(ipc.sendSync(PERF_PROFILE_CHANNELS.cached)) ?? null;
  } catch {
    cached = null;
  }
  const api: OmpStudioPerfApi = {
    cached,
    async probe() {
      const snapshot = parsePerfProfileSnapshot(await ipc.invoke(PERF_PROFILE_CHANNELS.probe));
      if (snapshot === undefined) throw new Error("perf profile: invalid response");
      return snapshot;
    },
    onChanged(listener) {
      const wrapped = (_event: unknown, payload: unknown): void => {
        const snapshot = parsePerfProfileSnapshot(payload);
        if (snapshot !== undefined) listener(snapshot);
      };
      ipc.on(PERF_PROFILE_CHANNELS.changed, wrapped);
      return () => {
        ipc.removeListener(PERF_PROFILE_CHANNELS.changed, wrapped);
      };
    },
  };
  return Object.freeze(api);
}
