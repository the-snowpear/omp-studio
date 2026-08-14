/**
 * Skill discovery providers — native, omp-plugins, claude, agent-plugins,
 * claude-plugins, agents, codex, opencode, github, omp-managed.
 * Each provider scans specific directories with its own priority.
 */

import * as path from "node:path";
import {
  scanSkillsFromDir,
  getAncestorDirs,
  findRepoRoot,
  listClaudePluginRoots,
} from "./helpers.js";
import { getAgentDir } from "./paths.js";
import { listOmpPluginRoots, listSettingsExtensionRoots, resolvePluginSkillDirs } from "./plugin-roots.js";
import { classifyAgentPluginRoot, legacyProviderAllowed } from "./agent-plugin.js";
import type { LoadContext, DiscoveredSkill, DiscoveryWarning } from "./types.js";

export interface ProviderResult {
  readonly skills: DiscoveredSkill[];
  readonly warnings: DiscoveryWarning[];
}

/**
 * Native provider (priority 100):
 * - Project: walk up from cwd to repoRoot, scan <dir>/.omp/skills at each ancestor
 * - User: ~/.omp/agent/skills (profile-scoped)
 */
export async function loadNativeSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  // Find repo root (for ancestor traversal)
  const repoRoot = await findRepoRoot(ctx.cwd, ctx.home);

  // Project-level: walk up from cwd to repoRoot
  const ancestors = getAncestorDirs(ctx.cwd, repoRoot, ctx.home);
  for (const ancestor of ancestors) {
    const dir = path.join(ancestor, ".omp", "skills");
    const { skills, warnings } = await scanSkillsFromDir({
      dir,
      providerId: "native",
      priority: 100,
      scope: "workspace",
      sourceKind: "native",
      sourceLabel: "项目",
      requireDescription: true,
    });
    allSkills.push(...skills);
    allWarnings.push(...warnings);
  }

  // User-level: ~/.omp/agent/skills (profile-scoped)
  const userDir = path.join(getAgentDir(ctx.home), "skills");
  const { skills: userSkills, warnings: userWarnings } = await scanSkillsFromDir({
    dir: userDir,
    providerId: "native",
    priority: 100,
    scope: "global",
    sourceKind: "native",
    sourceLabel: "用户",
    requireDescription: true,
  });
  allSkills.push(...userSkills);
  allWarnings.push(...userWarnings);

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * Managed skills provider (priority 5):
 * - User: ~/.omp/agent/managed-skills
 */
export async function loadManagedSkills(ctx: LoadContext): Promise<ProviderResult> {
  const dir = path.join(getAgentDir(ctx.home), "managed-skills");
  const { skills, warnings } = await scanSkillsFromDir({
    dir,
    providerId: "omp-managed",
    priority: 5,
    scope: "builtin",
    sourceKind: "managed",
    sourceLabel: "托管",
    requireDescription: true,
  });
  return { skills, warnings };
}

/**
 * OMP plugins provider (priority 90):
 * - Enabled plugin roots (user + project, npm ∪ lock union) and settings
 *   extension directories: scan <root>/skills. Agent Plugins roots are
 *   exclusive to the agent-plugins provider.
 */
export async function loadOmpPluginsSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  const { roots, warnings } = await listOmpPluginRoots(ctx.home, ctx.cwd);
  allWarnings.push(...warnings);

  const scanRoots: Array<{ dir: string; scope: "workspace" | "global" | "builtin" }> = [];
  for (const root of roots) {
    if (!root.enabled) continue;
    if (!(await legacyProviderAllowed(root.root, "skills"))) continue;
    scanRoots.push({ dir: path.join(root.root, "skills"), scope: "builtin" });
  }
  for (const ext of await listSettingsExtensionRoots(ctx.home, ctx.cwd)) {
    if (!(await legacyProviderAllowed(ext.path, "skills"))) continue;
    scanRoots.push({ dir: path.join(ext.path, "skills"), scope: ext.level === "project" ? "workspace" : "builtin" });
  }

  for (const scan of scanRoots) {
    const { skills, warnings: scanWarnings } = await scanSkillsFromDir({
      dir: scan.dir,
      providerId: "omp-plugins",
      priority: 90,
      scope: scan.scope,
      sourceKind: "plugin",
      sourceLabel: "插件",
      requireDescription: true,
    });
    allSkills.push(...skills);
    allWarnings.push(...scanWarnings);
  }

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * Claude provider (priority 80):
 * - Project: walk up from cwd to repoRoot, scan <dir>/.claude/skills at each ancestor
 * - User: ~/.claude/skills
 */
export async function loadClaudeSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  const repoRoot = await findRepoRoot(ctx.cwd, ctx.home);

  // Project-level: walk up from cwd to repoRoot
  const ancestors = getAncestorDirs(ctx.cwd, repoRoot, ctx.home);
  for (const ancestor of ancestors) {
    const dir = path.join(ancestor, ".claude", "skills");
    const { skills, warnings } = await scanSkillsFromDir({
      dir,
      providerId: "claude",
      priority: 80,
      scope: "workspace",
      sourceKind: "native",
      sourceLabel: "项目",
      requireDescription: false,
    });
    allSkills.push(...skills);
    allWarnings.push(...warnings);
  }

  // User-level: ~/.claude/skills
  const userDir = path.join(ctx.home, ".claude", "skills");
  const { skills: userSkills, warnings: userWarnings } = await scanSkillsFromDir({
    dir: userDir,
    providerId: "claude",
    priority: 80,
    scope: "global",
    sourceKind: "native",
    sourceLabel: "用户",
    requireDescription: false,
  });
  allSkills.push(...userSkills);
  allWarnings.push(...userWarnings);

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * Agent Plugins provider (priority 75):
 * - Candidate roots: marketplace installs ∪ OMP plugin package dirs ∪
 *   settings extension dirs. Only roots whose root plugin.json targets the
 *   Agent Plugins schema contribute skills (exclusive to this provider).
 */
export async function loadAgentPluginsSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  const candidates: Array<{ path: string; scope: "workspace" | "builtin" }> = [];
  const seen = new Set<string>();

  const { roots: marketplaceRoots, warnings: marketplaceWarnings } = await listClaudePluginRoots(ctx.home, ctx.cwd);
  allWarnings.push(...marketplaceWarnings);
  for (const root of marketplaceRoots) {
    if (!root.enabled) continue;
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    candidates.push({ path: root.path, scope: root.scope === "project" ? "workspace" : "builtin" });
  }

  const { roots: ompRoots, warnings: ompWarnings } = await listOmpPluginRoots(ctx.home, ctx.cwd);
  allWarnings.push(...ompWarnings);
  for (const root of ompRoots) {
    if (!root.enabled) continue;
    if (seen.has(root.root)) continue;
    seen.add(root.root);
    candidates.push({ path: root.root, scope: root.scope === "project" ? "workspace" : "builtin" });
  }

  for (const ext of await listSettingsExtensionRoots(ctx.home, ctx.cwd)) {
    if (seen.has(ext.path)) continue;
    seen.add(ext.path);
    candidates.push({ path: ext.path, scope: ext.level === "project" ? "workspace" : "builtin" });
  }

  for (const candidate of candidates) {
    let status;
    try {
      status = await classifyAgentPluginRoot(candidate.path);
    } catch {
      allWarnings.push({ message: `Failed to read agent plugin root: ${candidate.path}`, providerId: "agent-plugins" });
      continue;
    }
    if (status.kind !== "standard") continue;

    const { skills, warnings } = await scanSkillsFromDir({
      dir: path.join(candidate.path, "skills"),
      providerId: "agent-plugins",
      priority: 75,
      scope: candidate.scope,
      sourceKind: "plugin",
      sourceLabel: "插件",
      requireDescription: false,
    });
    allSkills.push(...skills);
    allWarnings.push(...warnings);
  }

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * Claude marketplace plugins provider (priority 70):
 * - Each marketplace root's skills/ (includeSelf) plus any skills paths
 *   declared in .claude-plugin/plugin.json.
 */
export async function loadClaudePluginsSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  const { roots, warnings } = await listClaudePluginRoots(ctx.home, ctx.cwd);
  allWarnings.push(...warnings);

  for (const root of roots) {
    if (!root.enabled) continue;
    if (!(await legacyProviderAllowed(root.path, "skills"))) continue;
    const dirs = await resolvePluginSkillDirs(root.path, allWarnings);
    for (const dir of dirs) {
      const { skills, warnings: scanWarnings } = await scanSkillsFromDir({
        dir,
        providerId: "claude-plugins",
        priority: 70,
        scope: root.scope === "project" ? "workspace" : "builtin",
        sourceKind: "plugin",
        sourceLabel: "插件",
        includeSelf: true,
        requireDescription: false,
      });
      allSkills.push(...skills);
      allWarnings.push(...scanWarnings);
    }
  }

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * Codex provider (priority 70):
 * - Project: <cwd>/.codex/skills (cwd only, no ancestor walk)
 * - User: ~/.codex/skills
 */
export async function loadCodexSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  // Project
  const projectDir = path.join(ctx.cwd, ".codex", "skills");
  const { skills: projectSkills, warnings: projectWarnings } = await scanSkillsFromDir({
    dir: projectDir,
    providerId: "codex",
    priority: 70,
    scope: "workspace",
    sourceKind: "native",
    sourceLabel: "项目",
    requireDescription: false,
  });
  allSkills.push(...projectSkills);
  allWarnings.push(...projectWarnings);

  // User
  const userDir = path.join(ctx.home, ".codex", "skills");
  const { skills: userSkills, warnings: userWarnings } = await scanSkillsFromDir({
    dir: userDir,
    providerId: "codex",
    priority: 70,
    scope: "global",
    sourceKind: "native",
    sourceLabel: "用户",
    requireDescription: false,
  });
  allSkills.push(...userSkills);
  allWarnings.push(...userWarnings);

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * OpenCode provider (priority 55):
 * - Project: <cwd>/.opencode/skills (cwd only)
 * - User: ~/.config/opencode/skills
 */
export async function loadOpencodeSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  // Project
  const projectDir = path.join(ctx.cwd, ".opencode", "skills");
  const { skills: projectSkills, warnings: projectWarnings } = await scanSkillsFromDir({
    dir: projectDir,
    providerId: "opencode",
    priority: 55,
    scope: "workspace",
    sourceKind: "native",
    sourceLabel: "项目",
    requireDescription: false,
  });
  allSkills.push(...projectSkills);
  allWarnings.push(...projectWarnings);

  // User
  const userDir = path.join(ctx.home, ".config", "opencode", "skills");
  const { skills: userSkills, warnings: userWarnings } = await scanSkillsFromDir({
    dir: userDir,
    providerId: "opencode",
    priority: 55,
    scope: "global",
    sourceKind: "native",
    sourceLabel: "用户",
    requireDescription: false,
  });
  allSkills.push(...userSkills);
  allWarnings.push(...userWarnings);

  return { skills: allSkills, warnings: allWarnings };
}

/**
 * GitHub provider (priority 30):
 * - Project: <cwd>/.github/skills (requireDescription: true)
 */
export async function loadGithubSkills(ctx: LoadContext): Promise<ProviderResult> {
  const dir = path.join(ctx.cwd, ".github", "skills");
  const { skills, warnings } = await scanSkillsFromDir({
    dir,
    providerId: "github",
    priority: 30,
    scope: "workspace",
    sourceKind: "native",
    sourceLabel: "项目",
    requireDescription: true, // GitHub skills require description
  });
  return { skills, warnings };
}

/**
 * Agents provider (priority 70):
 * - Project: walk up, scan <dir>/.agent/skills and <dir>/.agents/skills at each ancestor
 * - User: ~/.agent/skills, ~/.agents/skills
 */
export async function loadAgentsSkills(ctx: LoadContext): Promise<ProviderResult> {
  const allSkills: DiscoveredSkill[] = [];
  const allWarnings: DiscoveryWarning[] = [];

  const repoRoot = await findRepoRoot(ctx.cwd, ctx.home);
  const ancestors = getAncestorDirs(ctx.cwd, repoRoot, ctx.home);

  // Project-level: .agent and .agents at each ancestor
  for (const ancestor of ancestors) {
    for (const baseDir of [".agent", ".agents"]) {
      const dir = path.join(ancestor, baseDir, "skills");
      const { skills, warnings } = await scanSkillsFromDir({
        dir,
        providerId: "agents",
        priority: 70,
        scope: "workspace",
        sourceKind: "native",
        sourceLabel: "项目",
        requireDescription: false,
      });
      allSkills.push(...skills);
      allWarnings.push(...warnings);
    }
  }

  // User-level: ~/.agent/skills, ~/.agents/skills
  for (const baseDir of [".agent", ".agents"]) {
    const userDir = path.join(ctx.home, baseDir, "skills");
    const { skills, warnings } = await scanSkillsFromDir({
      dir: userDir,
      providerId: "agents",
      priority: 70,
      scope: "global",
      sourceKind: "native",
      sourceLabel: "用户",
      requireDescription: false,
    });
    allSkills.push(...skills);
    allWarnings.push(...warnings);
  }

  return { skills: allSkills, warnings: allWarnings };
}
