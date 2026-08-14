/**
 * Capability registry — deduplicates skills across providers by priority.
 * Higher priority wins on collision (first-wins within same priority).
 */

import type { DiscoveredSkill, DiscoveryWarning } from "./types.js";

/**
 * Merge skills from multiple providers, deduplicating by name.
 * Higher priority wins; within same priority, enabled skills beat disabled
 * ones, then first wins by name order. Skipped collisions are reported as
 * warnings (absolute paths are redacted by the adapter before they reach
 * the UI contract). A disabled skill therefore only appears when no
 * enabled skill of the same name exists.
 */
export function deduplicateSkills(skills: DiscoveredSkill[]): {
  skills: DiscoveredSkill[];
  warnings: DiscoveryWarning[];
} {
  const winners = new Map<string, DiscoveredSkill>();
  const warnings: DiscoveryWarning[] = [];

  // Sort by priority desc, then enabled desc (enabled wins ties), then by
  // name for determinism.
  const sorted = [...skills].sort((a, b) => {
    const priorityCompare = b.priority - a.priority;
    if (priorityCompare !== 0) return priorityCompare;
    const enabledCompare = Number(b.enabled) - Number(a.enabled);
    if (enabledCompare !== 0) return enabledCompare;
    return a.name.localeCompare(b.name);
  });

  for (const skill of sorted) {
    const existing = winners.get(skill.name);
    if (existing) {
      // Higher priority already claimed this name, skip
      warnings.push({
        message: `name collision: "${skill.name}" already loaded from ${existing.path}, skipping this one`,
      });
      continue;
    }
    winners.set(skill.name, skill);
  }

  // Return in alphabetical order by name
  return {
    skills: [...winners.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}
