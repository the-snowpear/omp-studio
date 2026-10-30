/**
 * Machine performance tier → DOM, for the renderer entry.
 *
 * Main grades the machine into L0–L3 (`apps/desktop/src/perf-profile.ts`) and
 * publishes the verdict through the read-only preload bridge:
 *
 *   cached      a snapshot read synchronously at preload time, for the first frame
 *   probe()     a promise for a fresh snapshot
 *   onChanged() pushes after a GPU/power change
 *
 * The renderer owns exactly two things here: keep the newest machine snapshot,
 * and fold the user's "reduce motion" preference into an effective tier. It
 * does not re-derive the machine class from GPU/CPU/RAM facts — that would be a
 * second grading rule to keep in sync with Main.
 *
 * The bug this replaces: the entry applied `onChanged` snapshots but never kept
 * them, so every later re-render (`prefers-reduced-motion` change, for example)
 * fell back to the *startup cache* and could pull a live L2/L3 back to L0.
 */

import { applyTier, TIER_ATTRIBUTES, type PerfTier } from "./tiers";

/** Main's own motion suggestion for the machine (`off` only on the lowest tier). */
export type MotionPolicy = "full" | "reduced" | "off";

/** One machine verdict as published by Main. `probedAt` orders two snapshots. */
export interface MachinePerfSnapshot {
  readonly tier: PerfTier;
  readonly motion?: MotionPolicy;
  readonly probedAt?: string;
}

/** The read-only surface the preload exposes as `window.ompStudioPerf`. */
export interface TierControlSource {
  readonly cached: MachinePerfSnapshot | null;
  probe(): Promise<MachinePerfSnapshot>;
  onChanged(listener: (snapshot: MachinePerfSnapshot) => void): () => void;
}

/**
 * The largest effect set the user can ask for is a *floor* they can tighten:
 * "reduce motion" turns L0 into L1 and leaves L1–L3 alone. It never lifts a
 * machine tier, because the reasons those tiers exist (software rasterizer,
 * low-end hardware) are not animations.
 */
export function effectiveTier(machine: PerfTier, motionOff: boolean): PerfTier {
  if (!motionOff) return machine;
  return machine === "L0" ? "L1" : machine;
}

/**
 * Newest snapshot wins, and the startup cache is only the initial value.
 *
 * `probe()` and `onChanged()` can interleave: a probe started at startup may
 * resolve after a newer push has already arrived. Accepting that stale result
 * would visibly rewind the tier, so a snapshot older than the one in hand is
 * dropped.
 */
export class TierState {
  #machine: MachinePerfSnapshot | null;

  constructor(initial: MachinePerfSnapshot | null = null) {
    this.#machine = initial;
  }

  get machine(): MachinePerfSnapshot | null {
    return this.#machine;
  }

  /** Returns true when the snapshot became the current one. */
  accept(snapshot: MachinePerfSnapshot | null | undefined): boolean {
    if (snapshot === null || snapshot === undefined) return false;
    const current = this.#machine;
    const currentAt = current?.probedAt;
    const incomingAt = snapshot.probedAt;
    if (currentAt !== undefined && incomingAt !== undefined && incomingAt < currentAt) return false;
    this.#machine = snapshot;
    return true;
  }

  /** The tier and motion state the DOM should carry right now. */
  resolve(motionOff: boolean): { tier: PerfTier; motionOff: boolean } {
    const machine = this.#machine;
    // Main's own verdict (`motion: "off"` on L3) is a floor too.
    const off = motionOff || machine?.motion === "off";
    return { tier: effectiveTier(machine?.tier ?? "L0", off), motionOff: off };
  }
}

export interface TierControlEnvironment {
  /** Usually `document.documentElement`; a detached element in tests. */
  readonly root: Element;
  /** `window.ompStudioPerf`; absent in a browser or a harness without the shell. */
  readonly source: TierControlSource | undefined;
  /** User or OS "reduce motion" preference, read on every apply. */
  motionOff(): boolean;
  /** Subscribe to preference changes; returns a disposer. */
  onMotionPreferenceChange?(listener: () => void): () => void;
}

/**
 * Write the tier before the first frame and keep it current. Returns a disposer
 * that removes every listener, so an HMR reload or a page unload cannot leave a
 * second wiring behind (a duplicated listener would apply the tier twice and
 * keep the old module reachable).
 */
export function startTierControl(environment: TierControlEnvironment): () => void {
  const { root, source } = environment;
  const state = new TierState(source?.cached ?? null);
  const element = root;

  const render = (): void => {
    const resolved = state.resolve(environment.motionOff());
    applyTier(element, resolved.tier);
    // `applyTier` writes the tier's canonical motion value; the user floor and
    // Main's verdict are applied on top. An unchanged `setAttribute` does not
    // invalidate style, so re-applying on every change is free.
    if (resolved.motionOff) element.setAttribute(TIER_ATTRIBUTES.motion, "off");
  };

  render();

  const disposers: Array<() => void> = [];
  if (source !== undefined) {
    disposers.push(source.onChanged(snapshot => {
      if (state.accept(snapshot)) render();
    }));
    if (source.cached === null) {
      // First launch for this profile: no synchronous snapshot yet, so the
      // first frame is optimistic (L0) and the probe refines it without a flash
      // of "fully degraded then normal".
      const pending = source.probe();
      void pending
        .then(snapshot => {
          if (state.accept(snapshot)) render();
        })
        .catch(() => {
          // Keep the last valid state; an unreachable Main is not a reason to
          // change what the user is looking at.
        });
    }
  }
  disposers.push(environment.onMotionPreferenceChange?.(render) ?? (() => {}));

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
