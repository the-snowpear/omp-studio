/**
 * OMP-compatible skill and plugin discovery entry point.
 * Orchestrates all providers and returns a unified result.
 */

import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoadContext, DiscoveryResult, DiscoveredPlugin, DiscoveryOptions, DiscoveryWarning } from "./types.js";
import { deduplicateSkills } from "./registry.js";
import { parseManifest } from "./plugin-manifest.js";
import { listClaudePluginRoots } from "./helpers.js";
import { listOmpPluginRoots, resolvePluginSkillDirs } from "./plugin-roots.js";
import {
  loadNativeSkills,
  loadManagedSkills,
  loadOmpPluginsSkills,
  loadClaudeSkills,
  loadAgentPluginsSkills,
  loadClaudePluginsSkills,
  loadCodexSkills,
  loadOpencodeSkills,
  loadGithubSkills,
  loadAgentsSkills,
} from "./providers.js";

/**
 * Discover all skills from all providers, deduplicated by priority.
 */
export async function discoverSkills(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const ctx: LoadContext = { home, cwd };

  // Run all providers in parallel
  const results = await Promise.all([
    loadNativeSkills(ctx),
    loadOmpPluginsSkills(ctx),
    loadClaudeSkills(ctx),
    loadAgentPluginsSkills(ctx),
    loadClaudePluginsSkills(ctx),
    loadAgentsSkills(ctx),
    loadCodexSkills(ctx),
    loadOpencodeSkills(ctx),
    loadGithubSkills(ctx),
    loadManagedSkills(ctx),
  ]);

  const allSkills = results.flatMap((r) => r.skills);
  const allWarnings = results.flatMap((r) => r.warnings);

  // Deduplicate by priority (higher wins), reporting skipped collisions
  const { skills, warnings: collisionWarnings } = deduplicateSkills(allSkills);

  return {
    skills,
    plugins: [], // Plugins will be added below
    warnings: [...allWarnings, ...collisionWarnings],
  };
}

/**
 * Resolve a path to its canonical form, or undefined when it does not exist.
 */
async function canonicalPath(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(path.resolve(p));
  } catch {
    return undefined;
  }
}

/**
 * Discover all plugins: shared OMP roots (user + project, npm ∪ lock union,
 * project shadows user) plus Claude marketplace roots not already covered.
 */
export async function discoverPlugins(options: DiscoveryOptions = {}): Promise<DiscoveredPlugin[]> {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const plugins: DiscoveredPlugin[] = [];
  const warnings: DiscoveryWarning[] = [];

  // 1. OMP plugin roots (npm/link/git, user + project)
  const { roots, warnings: rootWarnings } = await listOmpPluginRoots(home, cwd);
  warnings.push(...rootWarnings);
  for (const root of roots) {
    plugins.push({
      name: root.name,
      version: root.version,
      root: root.root,
      sourceKind: root.sourceKind,
      enabled: root.enabled,
      hasOmpManifest: root.hasOmpManifest,
      manifest: root.manifest,
      skillDirs: await resolvePluginSkillDirs(root.root, warnings),
    });
  }

  // 2. Claude marketplace plugins, deduplicated against npm/link by canonical path
  const { roots: claudeRoots, warnings: claudeWarnings } = await listClaudePluginRoots(home, cwd);
  warnings.push(...claudeWarnings);

  const covered = new Set<string>();
  for (const plugin of plugins) {
    const canonical = await canonicalPath(plugin.root);
    if (canonical) covered.add(canonical);
  }

  for (const root of claudeRoots) {
    const canonical = await canonicalPath(root.path);
    if (canonical && covered.has(canonical)) continue;

    let version = root.version;
    let manifest = {};
    // Marketplace installs carry their own manifest and stay "configured";
    // the omp/pi package rule only applies to npm/link/git packages.
    let hasOmpManifest = true;

    let pluginJson: Record<string, unknown> | undefined;
    try {
      const raw = await fs.readFile(path.join(root.path, ".claude-plugin", "plugin.json"), "utf8");
      pluginJson = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      pluginJson = undefined;
    }
    if (pluginJson && typeof pluginJson.version === "string") {
      version = pluginJson.version;
    }

    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root.path, "package.json"), "utf8")) as Record<string, unknown>;
      if (!pluginJson && typeof pkg.version === "string") version = pkg.version;
      const ompManifest = pkg.omp ?? pkg.pi;
      if (ompManifest !== undefined) {
        manifest = parseManifest(ompManifest);
        hasOmpManifest = true;
      }
    } catch {
      // No package.json / no manifest
    }

    plugins.push({
      name: root.plugin,
      version,
      root: root.path,
      sourceKind: "marketplace",
      enabled: root.enabled,
      hasOmpManifest,
      manifest,
      skillDirs: await resolvePluginSkillDirs(root.path, warnings),
    });
  }

  return plugins;
}

/**
 * Discover both skills and plugins.
 */
export async function discoverAll(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const [skillsResult, plugins] = await Promise.all([
    discoverSkills(options),
    discoverPlugins(options),
  ]);

  return {
    skills: skillsResult.skills,
    plugins,
    warnings: skillsResult.warnings,
  };
}
