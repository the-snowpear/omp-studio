/**
 * Tier layers + DOM write helpers.
 *
 * The CSS half of the feature keys off the single `data-perf-tier` attribute.
 * It is verified against the *built* stylesheet by
 * `outputs/perf-020/probes/tier-computed-styles.mjs` (computed
 * `backdrop-filter` / `box-shadow` / `--bd-blur` / animation duration per tier),
 * because jsdom does not apply the cascade that actually matters here.
 */
import { describe, expect, it } from "vitest";

import { PERF_TIERS, PERF_TIER_ATTRIBUTE, applyTier, isPerfTier, readTier, tierLayers } from "./tiers";

describe("tierLayers", () => {
  it("lists the painted tier first, then every layer it includes", () => {
    expect(tierLayers("L0")).toEqual([]);
    expect(tierLayers("L1")).toEqual(["L1"]);
    expect(tierLayers("L2")).toEqual(["L2", "L1"]);
    expect(tierLayers("L3")).toEqual(["L3", "L2", "L1"]);
  });
});

describe("isPerfTier", () => {
  it("accepts exactly the four tiers", () => {
    for (const tier of PERF_TIERS) expect(isPerfTier(tier)).toBe(true);
    for (const value of ["L4", "l1", "", null, undefined, 1, {}]) expect(isPerfTier(value)).toBe(false);
  });
});

describe("applyTier", () => {
  it("writes the cumulative layer set onto the root element", () => {
    const root = document.createElement("html");
    applyTier(root, "L0");
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L0");
    applyTier(root, "L1");
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L1");
    applyTier(root, "L2");
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L2 L1");
    applyTier(root, "L3");
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L3 L2 L1");
    // Going back down must not leave a stale layer behind.
    applyTier(root, "L0");
    expect(root.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L0");
  });

  it("is idempotent and tolerates a missing root", () => {
    const root = document.createElement("html");
    applyTier(root, "L2");
    const first = root.outerHTML;
    applyTier(root, "L2");
    expect(root.outerHTML).toBe(first);
    expect(() => applyTier(null, "L2")).not.toThrow();
    expect(() => applyTier(undefined, "L2")).not.toThrow();
  });

  it("accepts the whole document and writes to its root element", () => {
    applyTier(document, "L3");
    expect(document.documentElement.getAttribute(PERF_TIER_ATTRIBUTE)).toBe("L3 L2 L1");
    applyTier(document, "L0");
  });
});

describe("readTier", () => {
  it("reads the painted tier back, including from a layer set", () => {
    const root = document.createElement("html");
    expect(readTier(root)).toBe(null);
    applyTier(root, "L3");
    expect(readTier(root)).toBe("L3");
    root.setAttribute(PERF_TIER_ATTRIBUTE, "L2 L1");
    expect(readTier(root)).toBe("L2");
  });

  it("returns null for an absent document or an unknown value", () => {
    const root = document.createElement("html");
    root.setAttribute(PERF_TIER_ATTRIBUTE, "banana");
    expect(readTier(root)).toBe(null);
    expect(readTier(null)).toBe(null);
  });
});
