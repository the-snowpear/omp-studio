/**
 * GPU / low-spec grading (P0-6), Main side.
 *
 * Why this exists: the previous shell had zero GPU probing (0 hits for
 * `getGPUFeatureStatus`), so a machine compositing in software (VM, RDP,
 * integrated GPU with a broken driver) got the full animation set and paid
 * ~+62% idle CPU. `app.getGPUInfo("basic")` is NOT usable as the signal: its
 * fields are identical under hardware and software compositing (measured in
 * docs/performance-review-2026-10-29-round2.md §2.7/§5.2). The reliable
 * signals are `app.getGPUFeatureStatus()` (`*_software` values) and, as a
 * fallback, the `glRenderer` string from `app.getGPUInfo("complete")`.
 *
 * This module is Electron-free: every Electron call arrives through the
 * injected `PerfProfileProbeDeps`, so the grading is a pure function over
 * facts and the tests never start a GPU.
 *
 * Grading (documented in docs/performance.md):
 * - L0 — hardware compositing, enough cores/memory, on AC power: full motion.
 * - L1 — hardware compositing, but on battery: reduce continuous animation.
 * - L2 — software compositing (`*_software`, SwiftShader, WARP): simplify.
 * - L3 — low-spec machine (≤ 2 logical cores or ≤ 4 GiB RAM): reduce motion
 *   outright and let the Renderer cut decoration.
 * Precedence is L3 > L2 > L1 > L0: a low-spec machine stays L3 even when it
 * also composites in software, because L3 is the superset.
 *
 * The tier is a statement about the machine, not about the user: the
 * `motion: off` / `gpuTier` overrides live in the Renderer settings and are
 * applied there (they can only tighten the policy, never loosen the evidence).
 */

import {
  parsePerfProfileSnapshot,
  type PerfMotion,
  type PerfProfileSnapshot,
  type PerfTier,
} from "./perf-profile-shared.js";

/** ≤ this many logical cores counts as low spec (Win11 minimum is 2C). */
export const PERF_LOW_SPEC_CORES = 2;

/** ≤ this much RAM counts as low spec (Win11 minimum is 4 GiB). */
export const PERF_LOW_SPEC_MEMORY_BYTES = 4 * 1024 ** 3;

/** GPU feature-status keys whose `*_software` value means "software path". */
export const GPU_SOFTWARE_FEATURES = ["gpu_compositing", "2d_canvas", "rasterization", "webgl"] as const;

/** `glRenderer` strings that mean Chromium fell back to a software rasterizer. */
export const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|softpipe|software|microsoft basic render|basic render driver|\bwarp\b/iu;

/** How long a probed snapshot is treated as fresh by `probe()`. */
export const PERF_PROBE_FRESH_MS = 30_000;

export interface PerfProbeInput {
  /** Raw `app.getGPUFeatureStatus()`; `{}` when the probe failed. */
  readonly gpuFeatureStatus: Readonly<Record<string, string>> | undefined;
  /** `glRenderer` from `app.getGPUInfo("complete")`, when the fallback was needed. */
  readonly glRenderer?: string | undefined;
  /** `os.cpus().length`. */
  readonly cores: number;
  /** `os.totalmem()`. */
  readonly totalMemoryBytes: number;
  /** `powerMonitor.isOnBatteryPower()`. */
  readonly onBattery: boolean;
}

export interface PerfGrading {
  readonly tier: PerfTier;
  readonly motion: PerfMotion;
  readonly softwareCompositing: boolean;
  /** Human-readable evidence, in grading order. */
  readonly reasons: readonly string[];
}

/** Read one GPU feature-status value, normalised to a trimmed lowercase-free string. */
export function gpuFeatureValue(
  status: Readonly<Record<string, string>> | undefined,
  feature: string,
): string {
  const value = status?.[feature];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Software-compositing detection from the feature status, with the
 * `glRenderer` string as corroboration. Any feature reporting `*_software`
 * (or the literal `software`) proves the software path; otherwise a known
 * software renderer name does.
 */
export function detectSoftwareCompositing(
  status: Readonly<Record<string, string>> | undefined,
  glRenderer?: string | undefined,
): { readonly software: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  let software = false;
  for (const feature of GPU_SOFTWARE_FEATURES) {
    const value = gpuFeatureValue(status, feature);
    if (value.length === 0) continue;
    if (/software/iu.test(value)) {
      reasons.push(`${feature}=${value}`);
      software = true;
    }
  }
  const renderer = (glRenderer ?? "").trim();
  if (renderer.length > 0 && SOFTWARE_RENDERER_PATTERN.test(renderer)) {
    reasons.push(`glRenderer=${renderer}`);
    software = true;
  }
  return { software, reasons };
}

/**
 * True when the feature status cannot prove hardware compositing, i.e. the
 * `getGPUInfo("complete")` renderer string is worth the (slow) round-trip:
 * no signal at all, a disabled/unknown feature, or anything that is not
 * plainly `enabled`. A `*_software` value already proves the software path,
 * so no extra call is made.
 */
export function needsGpuInfoFallback(status: Readonly<Record<string, string>> | undefined): boolean {
  const values = ["gpu_compositing", "2d_canvas"].map((feature) => gpuFeatureValue(status, feature));
  if (values.some((value) => /software/iu.test(value))) return false;
  return !values.every((value) => value.toLowerCase() === "enabled");
}

/** Pure grading: facts in, tier + motion policy + evidence out. */
export function gradePerfProfile(input: PerfProbeInput): PerfGrading {
  const detection = detectSoftwareCompositing(input.gpuFeatureStatus, input.glRenderer);
  const reasons: string[] = [...detection.reasons];
  const lowCores = input.cores > 0 && input.cores <= PERF_LOW_SPEC_CORES;
  if (lowCores) reasons.push(`cores=${input.cores}<=${PERF_LOW_SPEC_CORES}`);
  const lowMemory = input.totalMemoryBytes > 0 && input.totalMemoryBytes <= PERF_LOW_SPEC_MEMORY_BYTES;
  if (lowMemory) reasons.push(`memory=${memoryGib(input.totalMemoryBytes)}GiB<=4GiB`);
  if (input.onBattery) reasons.push("power=battery");
  const lowSpec = lowCores || lowMemory;
  const tier: PerfTier = lowSpec ? "L3" : detection.software ? "L2" : input.onBattery ? "L1" : "L0";
  if (tier === "L0") reasons.push("gpu=hardware");
  const motion: PerfMotion = tier === "L3" ? "off" : tier === "L0" ? "full" : "reduced";
  return { tier, motion, softwareCompositing: detection.software, reasons };
}

/** Assemble the wire snapshot from a probe plus the facts used to grade it. */
export function createPerfProfileSnapshot(
  input: PerfProbeInput,
  options: { readonly probedAt: Date; readonly source: PerfProfileSnapshot["source"] },
): PerfProfileSnapshot {
  const grading = gradePerfProfile(input);
  return {
    tier: grading.tier,
    motion: grading.motion,
    softwareCompositing: grading.softwareCompositing,
    gpuCompositing: gpuFeatureValue(input.gpuFeatureStatus, "gpu_compositing"),
    canvas2d: gpuFeatureValue(input.gpuFeatureStatus, "2d_canvas"),
    glRenderer: input.glRenderer?.trim() ? input.glRenderer.trim() : null,
    cores: input.cores,
    totalMemoryBytes: input.totalMemoryBytes,
    onBattery: input.onBattery,
    reasons: grading.reasons,
    probedAt: options.probedAt.toISOString(),
    source: options.source,
  };
}

/** One-line, redaction-safe diagnostic line for the Host log. */
export function formatPerfProfileDetail(snapshot: PerfProfileSnapshot): string {
  return [
    `tier=${snapshot.tier}`,
    `motion=${snapshot.motion}`,
    `software=${snapshot.softwareCompositing}`,
    `gpu_compositing=${snapshot.gpuCompositing || "unknown"}`,
    `2d_canvas=${snapshot.canvas2d || "unknown"}`,
    `cores=${snapshot.cores}`,
    `memory_gib=${memoryGib(snapshot.totalMemoryBytes)}`,
    `battery=${snapshot.onBattery}`,
    `source=${snapshot.source}`,
    `reasons=${snapshot.reasons.length === 0 ? "none" : snapshot.reasons.join(",")}`,
  ].join(" ");
}

function memoryGib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export type PerfLogLevel = "info" | "warn";

/** Everything Electron-dependent the probe needs, injected by `main.ts`. */
export interface PerfProfileProbeDeps {
  /** `app.getGPUFeatureStatus()`. */
  getGPUFeatureStatus(): Readonly<Record<string, string>>;
  /** `app.getGPUInfo("complete")` → `gpuDevice[0].glRenderer`. */
  getGLRenderer(): Promise<string | undefined>;
  /** `os.cpus().length`. */
  cores(): number;
  /** `os.totalmem()`. */
  totalMemoryBytes(): number;
  /** `powerMonitor.isOnBatteryPower()`. */
  onBattery(): boolean;
  now(): Date;
  /** Read the previous snapshot from disk (`undefined` when absent). */
  readCache(): Promise<unknown>;
  /** Persist the snapshot for the next first paint. Best effort. */
  writeCache(snapshot: PerfProfileSnapshot): Promise<void>;
  log?(level: PerfLogLevel, event: string, detail: string): void;
  /** Called after every successful probe so Main can push `changed`. */
  onChanged?(snapshot: PerfProfileSnapshot): void;
  /**
   * Whether `getGPUFeatureStatus()` can be believed yet.
   *
   * The GPU process starts asynchronously: a probe that runs before Chromium
   * has decided reports `gpu_compositing: "disabled_software"` even on a
   * machine that composites in hardware (observed on this project: the very
   * first snapshot said software, the next `gpu-info-update` said hardware).
   * Grading such a transient verdict would persist L2 for the next launch and
   * make effects pop out on a machine that does not need it, so an unsettled
   * probe treats the GPU status as unknown instead of "software", and it is
   * neither cached nor broadcast. Defaults to `true` (tests and any caller
   * that has no asynchronous GPU service).
   */
  gpuStatusSettled?(): boolean;
}

export interface PerfProfileServiceOptions {
  /** `probe()` re-probes when the current snapshot is older than this. */
  readonly freshMs?: number;
}

/**
 * Owns the current snapshot: loads the previous one from disk before the
 * first window exists, re-probes on GPU/power changes, and never runs two
 * probes at once (`gpu-info-update` can fire in bursts).
 */
export class PerfProfileService {
  readonly #deps: PerfProfileProbeDeps;
  readonly #freshMs: number;
  #current: PerfProfileSnapshot | undefined;
  #lastProbeAt = 0;
  #inflight: Promise<PerfProfileSnapshot> | undefined;

  constructor(deps: PerfProfileProbeDeps, options: PerfProfileServiceOptions = {}) {
    this.#deps = deps;
    this.#freshMs = options.freshMs ?? PERF_PROBE_FRESH_MS;
  }

  /** Last known snapshot (probed, or the cached one before the first probe). */
  current(): PerfProfileSnapshot | undefined {
    return this.#current;
  }

  /** Read the persisted snapshot. Called once, before the first window loads. */
  async load(): Promise<PerfProfileSnapshot | undefined> {
    let raw: unknown;
    try {
      raw = await this.#deps.readCache();
    } catch {
      return undefined;
    }
    const parsed = parsePerfProfileSnapshot(raw);
    if (parsed === undefined) return undefined;
    const snapshot: PerfProfileSnapshot = { ...parsed, source: "cache" };
    if (this.#current === undefined) {
      this.#current = snapshot;
      this.#log("info", `cache ${formatPerfProfileDetail(snapshot)}`);
    }
    return snapshot;
  }

  /** Re-probe now. Concurrent callers share one probe. */
  async refresh(): Promise<PerfProfileSnapshot> {
    if (this.#inflight !== undefined) return this.#inflight;
    const inflight = this.#probe().finally(() => {
      this.#inflight = undefined;
    });
    this.#inflight = inflight;
    return inflight;
  }

  /** Renderer-facing query: the current snapshot, re-probed when stale. */
  async probe(): Promise<PerfProfileSnapshot> {
    const current = this.#current;
    if (current !== undefined && this.#lastProbeAt > 0 && this.#deps.now().getTime() - this.#lastProbeAt < this.#freshMs) {
      return current;
    }
    return this.refresh();
  }

  async #probe(): Promise<PerfProfileSnapshot> {
    const deps = this.#deps;
    const settled = deps.gpuStatusSettled?.() ?? true;
    let status: Record<string, string> | undefined;
    if (!settled) {
      // Chromium has not published its GPU verdict yet; "disabled_software"
      // here means "not initialized", not "software compositing".
      this.#log("info", "gpu_status=pending");
    } else {
      try {
        status = { ...deps.getGPUFeatureStatus() };
      } catch {
        // Headless/early-startup GPU service: grade from the remaining facts.
        status = undefined;
        this.#log("warn", "gpu_status=unavailable");
      }
    }
    let glRenderer: string | undefined;
    if (needsGpuInfoFallback(status)) {
      try {
        glRenderer = await deps.getGLRenderer();
      } catch {
        glRenderer = undefined;
        this.#log("warn", "gl_renderer=unavailable");
      }
    }
    const input: PerfProbeInput = {
      gpuFeatureStatus: status,
      glRenderer,
      cores: safeNumber(() => deps.cores()),
      totalMemoryBytes: safeNumber(() => deps.totalMemoryBytes()),
      onBattery: safeBoolean(() => deps.onBattery()),
    };
    const probedAt = deps.now();
    const snapshot = createPerfProfileSnapshot(input, { probedAt, source: "probe" });
    this.#current = snapshot;
    this.#log("info", formatPerfProfileDetail(snapshot));
    if (!settled) {
      // A provisional probe answers `probe()` without becoming the next
      // launch's first-paint tier; the settled probe replaces it in place.
      return snapshot;
    }
    this.#lastProbeAt = probedAt.getTime();
    try {
      await deps.writeCache(snapshot);
    } catch {
      this.#log("warn", "cache_write=failed");
    }
    try {
      deps.onChanged?.(snapshot);
    } catch {
      // A dead window must not fail the probe.
    }
    return snapshot;
  }

  #log(level: PerfLogLevel, detail: string): void {
    try {
      this.#deps.log?.(level, "desktop.perf_profile", detail);
    } catch {
      // Diagnostics are best effort; the profile itself is already computed.
    }
  }
}

function safeNumber(read: () => number): number {
  try {
    const value = read();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function safeBoolean(read: () => boolean): boolean {
  try {
    return read() === true;
  } catch {
    return false;
  }
}
