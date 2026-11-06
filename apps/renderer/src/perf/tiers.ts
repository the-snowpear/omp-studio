/**
 * Performance tiers L0–L3: the single vocabulary between Main and the CSS.
 *
 * Main grades the machine once (`apps/desktop/src/perf-profile.ts`, from GPU
 * feature status, cores, memory and battery) and publishes the verdict. The
 * renderer keeps the newest verdict (`perf/tierControl.ts`), folds the user's
 * motion preference in, and writes exactly one attribute on `<html>`:
 *
 *     <html data-perf-tier="L2 L1">
 *
 * The attribute is a *set of included layers*: the painted tier first, then
 * every layer it contains (`L3` includes `L2` includes `L1`). That is why CSS
 * can key each rule off one short selector (`[data-perf-tier~="L2"]`) instead of
 * repeating a three-way `:is([data-gpu=…], [data-perf=…], [data-motion=…])` list
 * at every rule, and why "reduce motion on a software-GPU machine" cannot
 * accidentally fall back to the lighter layer.
 *
 * This replaced three derived attributes (`data-gpu`, `data-motion`,
 * `data-perf`). To fill those the renderer had to re-derive the machine class
 * from GPU/CPU/memory facts — a second grading rule to keep in sync with Main,
 * and one that could contradict it (Main grades L3 for a low-memory machine
 * while the derived mapping announced `gpu=software` on hardware compositing).
 * Now Main owns the grading and the renderer owns only the tier it publishes.
 *
 * The raw evidence (gpu_compositing, glRenderer, cores, memory, battery) stays
 * in the Main-side snapshot for diagnostics; this attribute carries the verdict,
 * not the reasons.
 */

/** Ordered from full visuals to the most aggressive degradation. */
export const PERF_TIERS = ["L0", "L1", "L2", "L3"] as const;

export type PerfTier = (typeof PERF_TIERS)[number];

/** The only DOM state the tiering system owns. */
export const PERF_TIER_ATTRIBUTE = "data-perf-tier";

const TIER_LAYERS: Readonly<Record<PerfTier, readonly PerfTier[]>> = {
  L0: [], L1: ["L1"], L2: ["L2", "L1"], L3: ["L3", "L2", "L1"],
};
const TIER_ATTRIBUTES: Readonly<Record<PerfTier, string>> = {
  L0: "L0", L1: "L1", L2: "L2 L1", L3: "L3 L2 L1",
};

/** Every layer a tier includes, most aggressive first: `L2` → `L2 L1`. */
export function tierLayers(tier: PerfTier): readonly PerfTier[] {
  return TIER_LAYERS[tier];
}

export function isPerfTier(value: unknown): value is PerfTier {
  return typeof value === "string" && (PERF_TIERS as readonly string[]).includes(value);
}

function elementOf(root: Element | Document | null | undefined): Element | null {
  if (root === null || root === undefined) return null;
  // A Document is only accepted as a convenience for callers that pass the whole
  // document; everything is written to the root element either way.
  return "documentElement" in root ? root.documentElement : root;
}

/**
 * Write `tier` onto `root` (normally `document.documentElement`).
 *
 * Idempotent: repeated snapshots leave the attribute untouched, including DOM
 * observers. A `null` root is tolerated before React mounts and in tests.
 */
export function applyTier(root: Element | Document | null | undefined, tier: PerfTier): void {
  const element = elementOf(root);
  if (element === null) return;
  const value = TIER_ATTRIBUTES[tier];
  // L0 still states the tier explicitly even though it has no degradation layer.
  if (element.getAttribute(PERF_TIER_ATTRIBUTE) !== value) element.setAttribute(PERF_TIER_ATTRIBUTE, value);
}

/** The painted tier, or `null` when the attribute is absent or unreadable. */
export function readTier(root: Element | Document | null | undefined): PerfTier | null {
  const element = elementOf(root);
  if (element === null) return null;
  const painted = element.getAttribute(PERF_TIER_ATTRIBUTE)?.trim().split(/\s+/u)[0];
  return isPerfTier(painted) ? painted : null;
}
