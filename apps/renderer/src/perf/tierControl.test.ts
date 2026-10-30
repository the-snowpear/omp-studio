/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { TierState, effectiveTier, startTierControl, type MachinePerfSnapshot, type TierControlSource } from "./tierControl";
import { PERF_TIER_ATTRIBUTE } from "./tiers";

/**
 * The renderer entry's tier wiring.
 *
 * The regression these tests were written against: `main.tsx` applied
 * `onChanged` snapshots but kept none, so a later `prefers-reduced-motion`
 * change re-read the *startup cache* and pulled a live L2/L3 back to L0.
 */

const CACHED_L0: MachinePerfSnapshot = { tier: "L0", motion: "full", probedAt: "2026-10-30T09:00:00.000Z" };
const CACHED_L2: MachinePerfSnapshot = { tier: "L2", motion: "reduced", probedAt: "2026-10-30T09:00:00.000Z" };

interface Harness {
  readonly root: Element;
  readonly source: TierControlSource;
  readonly probe: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  tier(): string | null;
  push(snapshot: MachinePerfSnapshot): void;
  setMotionPreference(off: boolean): void;
  resolveProbe(snapshot: MachinePerfSnapshot): Promise<void>;
  rejectProbe(error?: Error): Promise<void>;
  readonly dispose: () => void;
  motionListeners(): number;
}

function harness(options: { cached?: MachinePerfSnapshot | null; motionOff?: boolean } = {}): Harness {
  const root = document.createElement("html");
  let listener: ((snapshot: MachinePerfSnapshot) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  let settle: { resolve: (snapshot: MachinePerfSnapshot) => void; reject: (error: Error) => void } | undefined;
  const probe = vi.fn(
    () =>
      new Promise<MachinePerfSnapshot>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  const source: TierControlSource = {
    cached: options.cached === undefined ? CACHED_L0 : options.cached,
    probe,
    onChanged(next) {
      listener = next;
      return unsubscribe;
    },
  };
  const motion = { off: options.motionOff ?? false, listeners: new Set<() => void>() };
  const dispose = startTierControl({
    root,
    source,
    motionOff: () => motion.off,
    onMotionPreferenceChange(changed) {
      motion.listeners.add(changed);
      return () => motion.listeners.delete(changed);
    },
  });
  return {
    root,
    source,
    probe,
    unsubscribe,
    tier: () => root.getAttribute(PERF_TIER_ATTRIBUTE),
    push: snapshot => listener?.(snapshot),
    setMotionPreference: off => {
      motion.off = off;
      for (const changed of [...motion.listeners]) changed();
    },
    resolveProbe: async snapshot => {
      settle?.resolve(snapshot);
      await Promise.resolve();
      await Promise.resolve();
    },
    rejectProbe: async (error = new Error("probe failed")) => {
      settle?.reject(error);
      await Promise.resolve();
      await Promise.resolve();
    },
    dispose,
    motionListeners: () => motion.listeners.size,
  };
}

describe("effectiveTier", () => {
  it("treats the user's motion preference as a floor, never as a lift", () => {
    expect(effectiveTier("L0", false)).toBe("L0");
    expect(effectiveTier("L0", true)).toBe("L1");
    expect(effectiveTier("L1", true)).toBe("L1");
    expect(effectiveTier("L2", true)).toBe("L2");
    expect(effectiveTier("L3", true)).toBe("L3");
    expect(effectiveTier("L2", false)).toBe("L2");
  });
});

describe("TierState", () => {
  it("keeps the newest snapshot and drops a stale one", () => {
    const state = new TierState(CACHED_L0);
    expect(state.accept({ tier: "L2", probedAt: "2026-10-30T10:00:00.000Z" })).toBe(true);
    expect(state.machine?.tier).toBe("L2");
    expect(state.accept({ tier: "L0", probedAt: "2026-10-30T09:30:00.000Z" })).toBe(false);
    expect(state.machine?.tier).toBe("L2");
    expect(state.accept({ tier: "L3", probedAt: "2026-10-30T10:00:00.000Z" })).toBe(true);
    expect(state.machine?.tier).toBe("L3");
  });

  it("ignores an absent snapshot instead of resetting to a default", () => {
    const state = new TierState(CACHED_L2);
    expect(state.accept(null)).toBe(false);
    expect(state.accept(undefined)).toBe(false);
    expect(state.machine?.tier).toBe("L2");
  });

  it("folds Main's own motion verdict into the resolved tier", () => {
    expect(new TierState({ tier: "L3", motion: "off" }).resolve(false)).toBe("L3");
    expect(new TierState({ tier: "L1", motion: "off" }).resolve(false)).toBe("L1");
    expect(new TierState({ tier: "L2", motion: "reduced" }).resolve(false)).toBe("L2");
    expect(new TierState({ tier: "L0", motion: "full" }).resolve(true)).toBe("L1");
    expect(new TierState(null).resolve(false)).toBe("L0");
  });
});

describe("startTierControl: the live tier survives a preference change", () => {
  it("keeps a pushed L2 when the OS motion preference changes", () => {
    const wiring = harness({ cached: CACHED_L0 });
    expect(wiring.tier()).toBe("L0");
    wiring.push({ tier: "L2", motion: "reduced", probedAt: "2026-10-30T10:00:00.000Z" });
    expect(wiring.tier()).toBe("L2 L1");
    wiring.setMotionPreference(true);
    // The machine tier is the live one, not the startup cache: L2 stays L2.
    expect(wiring.tier()).toBe("L2 L1");
    wiring.dispose();
  });

  it("keeps a pushed L3 when the OS motion preference changes", () => {
    const wiring = harness({ cached: CACHED_L0 });
    wiring.push({ tier: "L3", motion: "off", probedAt: "2026-10-30T10:00:00.000Z" });
    expect(wiring.tier()).toBe("L3 L2 L1");
    wiring.setMotionPreference(true);
    expect(wiring.tier()).toBe("L3 L2 L1");
    wiring.setMotionPreference(false);
    expect(wiring.tier()).toBe("L3 L2 L1");
    wiring.dispose();
  });

  it("uses the newest snapshot when a better machine is reported", () => {
    const wiring = harness({ cached: CACHED_L2 });
    expect(wiring.tier()).toBe("L2 L1");
    wiring.push({ tier: "L0", motion: "full", probedAt: "2026-10-30T10:00:00.000Z" });
    expect(wiring.tier()).toBe("L0");
    wiring.setMotionPreference(true);
    expect(wiring.tier()).toBe("L1");
    wiring.dispose();
  });

  it("turns a plain L0 into L1 while the preference is on, and back", () => {
    const wiring = harness({ cached: CACHED_L0 });
    wiring.setMotionPreference(true);
    expect(wiring.tier()).toBe("L1");
    wiring.setMotionPreference(false);
    expect(wiring.tier()).toBe("L0");
    wiring.dispose();
  });

  it("probes once when the profile has no cached snapshot yet", async () => {
    const wiring = harness({ cached: null });
    expect(wiring.probe).toHaveBeenCalledTimes(1);
    // First frame is optimistic; the probe refines it without a flash.
    expect(wiring.tier()).toBe("L0");
    await wiring.resolveProbe({ tier: "L2", motion: "reduced", probedAt: "2026-10-30T10:00:00.000Z" });
    expect(wiring.tier()).toBe("L2 L1");
    wiring.dispose();
  });

  it("does not probe when a cached snapshot already exists", () => {
    const wiring = harness({ cached: CACHED_L2 });
    expect(wiring.probe).not.toHaveBeenCalled();
    wiring.dispose();
  });

  it("keeps the last valid state when the probe fails", async () => {
    const wiring = harness({ cached: null, motionOff: true });
    expect(wiring.tier()).toBe("L1");
    await wiring.rejectProbe();
    expect(wiring.tier()).toBe("L1");
    wiring.dispose();
  });

  it("ignores a probe that resolves after a newer push", async () => {
    const wiring = harness({ cached: null });
    wiring.push({ tier: "L2", motion: "reduced", probedAt: "2026-10-30T10:00:00.000Z" });
    expect(wiring.tier()).toBe("L2 L1");
    await wiring.resolveProbe({ tier: "L0", motion: "full", probedAt: "2026-10-30T09:00:00.000Z" });
    expect(wiring.tier()).toBe("L2 L1");
    wiring.dispose();
  });

  it("works without the desktop bridge at all", () => {
    const root = document.createElement("html");
    let off = false;
    const listeners = new Set<() => void>();
    const dispose = startTierControl({
      root,
      source: undefined,
      motionOff: () => off,
      onMotionPreferenceChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L0");
    off = true;
    for (const listener of [...listeners]) listener();
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L1");
    dispose();
    expect(listeners.size).toBe(0);
  });

  it("removes every listener on dispose, so HMR cannot stack a second wiring", () => {
    const wiring = harness({ cached: CACHED_L2 });
    expect(wiring.motionListeners()).toBe(1);
    wiring.dispose();
    expect(wiring.motionListeners()).toBe(0);
    expect(wiring.unsubscribe).toHaveBeenCalledTimes(1);
    // A late push from the disposed wiring must not touch the DOM again.
    wiring.root.setAttribute(PERF_TIER_ATTRIBUTE, "unchanged");
    wiring.push({ tier: "L3", probedAt: "2026-10-30T11:00:00.000Z" });
    expect(wiring.root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("unchanged");
  });
});
