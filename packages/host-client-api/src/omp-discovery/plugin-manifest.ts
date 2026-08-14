/**
 * Plugin manifest parsing — from package.json (pkg.omp / pkg.pi).
 */

import type { PluginManifestView } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/**
 * Parse plugin manifest from pkg.omp or pkg.pi field in package.json.
 */
export function parseManifest(value: unknown): PluginManifestView {
  if (!isRecord(value)) return {};

  const features: PluginManifestView["features"] = {};
  if (isRecord(value.features)) {
    for (const [key, raw] of Object.entries(value.features)) {
      if (!isRecord(raw)) continue;
      features[key] = {
        tools: stringList(raw.tools),
        hooks: stringList(raw.hooks),
        commands: stringList(raw.commands),
        extensions: stringList(raw.extensions),
      };
    }
  }

  return {
    ...(typeof value.tools === "string" ? { tools: value.tools } : {}),
    ...(typeof value.hooks === "string" ? { hooks: value.hooks } : {}),
    ...(Array.isArray(value.extensions) ? { extensions: stringList(value.extensions) } : {}),
    ...(Array.isArray(value.commands) ? { commands: stringList(value.commands) } : {}),
    ...(Object.keys(features).length > 0 ? { features } : {}),
  };
}

/**
 * Collect declared item names from a plugin manifest (for contribution counts).
 */
export function collectDeclaredItems(manifest: PluginManifestView): {
  toolItems: string[];
  commandItems: string[];
  hookItems: string[];
  uiItems: string[];
} {
  const tools = new Set<string>();
  const commands = new Set<string>();
  const hooks = new Set<string>();
  const ui = new Set<string>();

  const add = (set: Set<string>, value: string | undefined) => {
    if (!value) return;
    const item = value.trim();
    if (item) set.add(item);
  };

  add(tools, manifest.tools);
  add(hooks, manifest.hooks);
  for (const command of manifest.commands ?? []) add(commands, command);
  for (const extension of manifest.extensions ?? []) add(ui, extension);

  for (const feature of Object.values(manifest.features ?? {})) {
    for (const tool of feature.tools ?? []) add(tools, tool);
    for (const hook of feature.hooks ?? []) add(hooks, hook);
    for (const command of feature.commands ?? []) add(commands, command);
    for (const extension of feature.extensions ?? []) add(ui, extension);
  }

  const take = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b)).slice(0, 24);

  return {
    toolItems: take(tools),
    commandItems: take(commands),
    hookItems: take(hooks),
    uiItems: take(ui),
  };
}
