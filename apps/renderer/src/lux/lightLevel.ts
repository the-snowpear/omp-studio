/**
 * The 光效 setting and the one attribute it owns on <html>.
 *
 * The value is a set of included layers, like `data-perf-tier`: vivid includes
 * standard includes soft, so styles/light.css keys every rule off one short
 * `[data-light~="std"]` selector. The performance tier still has the last
 * word (perf/tiers.css removes light from L2 down).
 */

export type LightLevel = "off" | "soft" | "standard" | "vivid";

export const LIGHT_LEVELS: readonly LightLevel[] = ["off", "soft", "standard", "vivid"];

export const LIGHT_ATTRIBUTE = "data-light";

const LIGHT_LAYERS: Readonly<Record<LightLevel, string>> = {
  off: "off",
  soft: "soft",
  standard: "std soft",
  vivid: "vivid std soft",
};

export function lightAttributeValue(level: LightLevel): string {
  return LIGHT_LAYERS[level];
}

export function applyLightLevel(root: Element, level: LightLevel): void {
  const value = LIGHT_LAYERS[level];
  if (root.getAttribute(LIGHT_ATTRIBUTE) !== value) root.setAttribute(LIGHT_ATTRIBUTE, value);
}
