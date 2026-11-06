/**
 * GPU / performance profile contract shared by Main and the sandboxed preload.
 *
 * P0-6 splits in two halves:
 * - Main probes reliable GPU/power facts (`app.getGPUFeatureStatus()`, the
 *   `getGPUInfo("complete")` renderer string, cores, memory, battery) and
 *   grades them into L0–L3 — `apps/desktop/src/perf-profile.ts`.
 * - This module is the wire shape the preload exposes read-only to the
 *   Renderer. Nothing here is writable from the Renderer: `probe` re-reads
 *   Main's snapshot, `cached` is the last snapshot for first-paint decisions,
 *   and `changed` is a Main → Renderer push. Disk cache parsing lives only
 *   at its Main-side entry; these fixed channels carry Main's typed output.
 *
 * The Renderer-side tier→attribute/CSS mapping and the user override
 * (`motion: off`, `gpuTier`) live in the Renderer (`apps/renderer/src/perf/`):
 * this module reports the machine, not the user's preference.
 */

/** L0 full / L1 reduced continuous animation / L2 software compositing / L3 low spec. */
export type PerfTier = "L0" | "L1" | "L2" | "L3";

/** Suggested motion policy; the user setting may override it in the Renderer. */
export type PerfMotion = "full" | "reduced" | "off";

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

/** IPC sender subset the perf channels need; Electron WebContents satisfies it. */
export interface PerfProfileSender {
  isDestroyed(): boolean;
  getURL(): string;
}

/** Fixed Main-owned profile channels; values have already been produced or parsed. */
export interface PerfProfileApiIpc {
  invoke(channel: string): Promise<PerfProfileSnapshot | null | undefined>;
  sendSync(channel: string): PerfProfileSnapshot | null | undefined;
  on(channel: string, listener: (event: unknown, payload: PerfProfileSnapshot | null | undefined) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: PerfProfileSnapshot | null | undefined) => void): void;
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
    cached = ipc.sendSync(PERF_PROFILE_CHANNELS.cached) ?? null;
  } catch {
    cached = null;
  }
  const api: OmpStudioPerfApi = {
    cached,
    async probe() {
      const snapshot = await ipc.invoke(PERF_PROFILE_CHANNELS.probe);
      if (snapshot == null) throw new Error("perf profile: unavailable");
      return snapshot;
    },
    onChanged(listener) {
      const wrapped = (_event: unknown, snapshot: PerfProfileSnapshot | null | undefined): void => {
        if (snapshot != null) listener(snapshot);
      };
      ipc.on(PERF_PROFILE_CHANNELS.changed, wrapped);
      return () => {
        ipc.removeListener(PERF_PROFILE_CHANNELS.changed, wrapped);
      };
    },
  };
  return Object.freeze(api);
}
