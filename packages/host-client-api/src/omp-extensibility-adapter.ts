/**
 * File-backed configured skills / plugins inventory.
 *
 * OMP-compatible configured scan: native, omp-plugins, claude,
 * agent-plugins, claude-plugins, agents, codex, opencode, github,
 * omp-managed. Not Runtime loadSkills() — the read model never claims the
 * Runtime effective/loaded set. This is a thin sanitizing adapter over the
 * omp-discovery layer (ancestor traversal, marketplace registry stack, …).
 *
 * `setEnabled` implements the whole-package plugin toggle (OMP-native
 * `omp plugin enable/disable <pkg>` semantics): it never uninstalls or
 * touches node_modules, only the config files the discovery layer reads, so
 * `skills.get` reflects the change immediately.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import type {
  ConfigWriteResult,
  ExtensibilityReadModel,
  PluginRecord,
  PluginSourceKind,
  SkillRecord,
} from "@omp-studio/client-contract";

import { redactText, sanitizeDisplayText } from "./read-models.js";
import type { HostExtensibilityService } from "./services.js";
import { discoverAll, discoverSkills } from "./omp-discovery/index.js";
import type { DiscoveredSkill, DiscoveredPlugin } from "./omp-discovery/types.js";
import { collectDeclaredItems } from "./omp-discovery/plugin-manifest.js";
import { resolveActiveProjectRegistryPath } from "./omp-discovery/helpers.js";
import { getPluginsDir } from "./omp-discovery/paths.js";

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DESC_MAX = 240;
const NAME_MAX = 80;

const WRITE_OK = (message: string): ConfigWriteResult => ({
  applied: true,
  runtimeEffect: "new-session",
  message,
});

export interface OmpExtensibilityAdapterOptions {
  readonly home?: string;
  readonly cwd?: string;
  readonly now?: () => string;
}

function emptyModel(now: string, reason?: string): ExtensibilityReadModel {
  return {
    skills: [],
    plugins: [],
    warnings: [],
    generatedAt: now,
    ...(reason === undefined ? {} : { unavailableReason: reason }),
  };
}

function safeName(value: string, fallback: string): string {
  const trimmed = value.trim();
  const candidate = SKILL_NAME.test(trimmed) ? trimmed : fallback;
  return sanitizeDisplayText(candidate, NAME_MAX) ?? fallback.slice(0, NAME_MAX);
}

function safeDesc(value: string | undefined): string {
  return sanitizeDisplayText(value, DESC_MAX) ?? "";
}

function sourceLabelOf(kind: PluginSourceKind): string {
  if (kind === "marketplace") return "市场";
  if (kind === "link") return "链接";
  if (kind === "git") return "git";
  return "npm";
}

/**
 * Convert DiscoveredSkill to SkillRecord (display-layer contract).
 */
function toSkillRecord(skill: DiscoveredSkill): SkillRecord {
  const desc = safeDesc(skill.description);
  return {
    name: safeName(skill.name, "skill"),
    desc,
    scope: skill.scope,
    sourceKind: skill.sourceKind,
    sourceLabel: skill.sourceLabel,
    enabled: skill.enabled,
    hide: skill.hide || skill.disableModelInvocation,
    ...(desc.length === 0 ? { error: "SKILL.md 缺少 description" } : {}),
  };
}

/**
 * Convert DiscoveredPlugin to PluginRecord (display-layer contract).
 * Packages without an OMP/pi manifest are still listed, marked as error.
 */
function toPluginRecord(plugin: DiscoveredPlugin): PluginRecord {
  const displayName = sanitizeDisplayText(plugin.name, NAME_MAX) ?? "plugin";
  const version = sanitizeDisplayText(plugin.version, 32) ?? "0.0.0";
  const items = collectDeclaredItems(plugin.manifest);
  const err = plugin.hasOmpManifest ? undefined : sanitizeDisplayText("package.json 缺少 omp/pi", 80);

  return {
    name: displayName,
    version,
    sourceKind: plugin.sourceKind,
    srcLabel: sourceLabelOf(plugin.sourceKind),
    enabled: plugin.enabled,
    status: plugin.hasOmpManifest ? "configured" : "error",
    tools: items.toolItems.length,
    commands: items.commandItems.length,
    hooks: items.hookItems.length,
    ui: items.uiItems.length > 0,
    toolItems: items.toolItems,
    commandItems: items.commandItems,
    hookItems: items.hookItems,
    uiItems: items.uiItems,
    ...(err === undefined ? {} : { err }),
  };
}

// ---------------------------------------------------------------------------
// plugins.setEnabled — whole-package toggle over the OMP-native config files
// ---------------------------------------------------------------------------

type PluginScope = "user" | "project";

/** One inventory scope (user plugins dir or project plugins dir). */
interface PluginScopeState {
  readonly scope: PluginScope;
  readonly pluginsDir: string;
  /** installed_plugins.json path (marketplace registry of this scope). */
  readonly registryPath: string;
  /** omp-plugins.lock.json path (runtime config of this scope). */
  readonly lockPath: string;
  readonly registry: Record<string, unknown> | undefined;
  readonly lock: Record<string, unknown> | undefined;
  readonly pkg: Record<string, unknown> | undefined;
  /** Registry keys `name@marketplace` whose plugin name part matches. */
  readonly marketplaceKeys: string[];
  /** Present in the lock or in package.json#dependencies. */
  readonly npmPresent: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

/** Atomic JSON write: tmp + rename, with the Windows EPERM fallback. */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Atomic text write: tmp + rename, with the Windows EPERM fallback. */
async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      // Windows: rename over an existing file can fail; unlink then rename.
      await fs.rm(filePath, { force: true });
      await fs.rename(temporary, filePath);
    } else {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}

/**
 * Rewrite the frontmatter `enabled` key of a SKILL.md without touching any
 * other byte: an existing `enabled:` line gets its value replaced, a
 * missing key is appended before the closing `---`. Throws
 * INVALID_ARGUMENT when the content has no frontmatter block.
 */
function editFrontmatterEnabled(content: string, enabled: boolean): string {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n?)/.exec(content);
  if (match === null) {
    throw { code: "INVALID_ARGUMENT", message: "SKILL.md 缺少 frontmatter，无法切换" };
  }
  const eol = match[1] as string;
  const block = match[2] as string;
  const value = enabled ? "true" : "false";
  const linePattern = /^(\s*enabled\s*:\s*)[^\r\n]*$/m;
  const nextBlock = linePattern.test(block)
    ? block.replace(linePattern, `$1${value}`)
    : `${block}${eol}enabled: ${value}`;
  const closing = match[3] ?? "";
  return `---${eol}${nextBlock}${eol}---${closing}${content.slice(match.index + match[0].length)}`;
}

/** Keys of `installed_plugins.json` whose plugin name part equals `name`. */
function marketplaceKeysOf(registry: Record<string, unknown> | undefined, name: string): string[] {
  const plugins = asRecord(registry?.plugins);
  if (plugins === undefined) return [];
  const keys: string[] = [];
  for (const key of Object.keys(plugins)) {
    const at = key.lastIndexOf("@");
    const pluginName = at > 0 ? key.slice(0, at) : key;
    if (pluginName === name) keys.push(key);
  }
  return keys;
}

function lockEntryOf(lock: Record<string, unknown> | undefined, name: string): Record<string, unknown> | undefined {
  const plugins = asRecord(lock?.plugins);
  return plugins === undefined ? undefined : asRecord(plugins[name]);
}

function depsContain(pkg: Record<string, unknown> | undefined, name: string): boolean {
  const deps = asRecord(pkg?.dependencies);
  return deps !== undefined && typeof deps[name] === "string";
}

async function readScopeState(pluginsDir: string, scope: PluginScope, name: string): Promise<PluginScopeState> {
  const registryPath = path.join(pluginsDir, "installed_plugins.json");
  const lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
  const [registry, lock, pkg] = await Promise.all([
    readJsonFile(registryPath),
    readJsonFile(lockPath),
    readJsonFile(path.join(pluginsDir, "package.json")),
  ]);
  return {
    scope,
    pluginsDir,
    registryPath,
    lockPath,
    registry,
    lock,
    pkg,
    marketplaceKeys: marketplaceKeysOf(registry, name),
    npmPresent: lockEntryOf(lock, name) !== undefined || depsContain(pkg, name),
  };
}

/** Version of `<pluginsDir>/node_modules/<name>/package.json`, if readable. */
async function readVersionOf(pluginsDir: string, name: string): Promise<string | undefined> {
  const pkg = await readJsonFile(path.join(pluginsDir, "node_modules", ...name.split("/"), "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : undefined;
}

/**
 * Project-level toggles are also recorded in `<cwd>/.omp/plugin-overrides.json`
 * `disabled` (the same file the discovery layer reads): disabling adds the
 * name, enabling removes it. Other keys are preserved.
 */
async function updateProjectOverrides(cwd: string, name: string, enabled: boolean): Promise<void> {
  const overridesPath = path.join(cwd, ".omp", "plugin-overrides.json");
  const current = (await readJsonFile(overridesPath)) ?? {};
  const disabled = Array.isArray(current.disabled)
    ? current.disabled.filter((entry): entry is string => typeof entry === "string")
    : [];
  const nextDisabled = enabled
    ? disabled.filter((entry) => entry !== name)
    : disabled.includes(name)
      ? disabled
      : [...disabled, name];
  await writeJsonFile(overridesPath, { ...current, disabled: nextDisabled });
}

async function applyMarketplaceToggle(state: PluginScopeState, name: string, enabled: boolean): Promise<void> {
  const registry = state.registry ?? { version: 2, plugins: {} };
  const plugins = asRecord(registry.plugins) ?? {};
  const nextPlugins: Record<string, unknown> = { ...plugins };
  for (const key of state.marketplaceKeys) {
    const entries = Array.isArray(nextPlugins[key]) ? (nextPlugins[key] as unknown[]) : [];
    nextPlugins[key] = entries.map((entry) => ({
      ...(asRecord(entry) ?? {}),
      enabled,
    }));
  }
  await writeJsonFile(state.registryPath, { ...registry, plugins: nextPlugins });
}

async function applyNpmToggle(state: PluginScopeState, name: string, enabled: boolean): Promise<void> {
  const lock = state.lock ?? { plugins: {}, settings: {} };
  const plugins = asRecord(lock.plugins) ?? {};
  const previous = asRecord(plugins[name]);
  const version = previous?.version ?? (await readVersionOf(state.pluginsDir, name));
  const nextPlugins = {
    ...plugins,
    [name]: {
      ...(previous ?? {}),
      ...(version === undefined ? {} : { version }),
      enabled,
    },
  };
  await writeJsonFile(state.lockPath, { ...lock, plugins: nextPlugins });
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function createOmpExtensibilityService(
  options: OmpExtensibilityAdapterOptions = {}
): HostExtensibilityService {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async get(): Promise<ExtensibilityReadModel> {
      const generatedAt = now();
      try {
        const home = options.home ?? homedir();
        const cwd = options.cwd ?? process.cwd();

        // Call the new discovery layer
        const { skills, plugins, warnings } = await discoverAll({ home, cwd });

        return {
          skills: skills.map(toSkillRecord),
          plugins: plugins.map(toPluginRecord),
          warnings: warnings.map((w) => redactText(w.message)).slice(0, 32),
          generatedAt,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "skills.get failed";
        return emptyModel(generatedAt, redactText(message));
      }
    },

    async setEnabled(input: {
      readonly name: string;
      readonly enabled: boolean;
      readonly scope?: "user" | "project";
    }): Promise<ConfigWriteResult> {
      const { name, enabled } = input;
      if (typeof name !== "string" || name.trim().length === 0) {
        throw { code: "INVALID_ARGUMENT", message: "plugins.setEnabled name must not be empty" };
      }
      if (typeof enabled !== "boolean") {
        throw { code: "INVALID_ARGUMENT", message: "plugins.setEnabled enabled must be a boolean" };
      }
      if (input.scope !== undefined && input.scope !== "user" && input.scope !== "project") {
        throw { code: "INVALID_ARGUMENT", message: "plugins.setEnabled scope must be 'user' or 'project'" };
      }

      const home = options.home ?? homedir();
      const cwd = options.cwd ?? process.cwd();
      const userDir = getPluginsDir(home);
      const projectRegistryPath = await resolveActiveProjectRegistryPath(cwd);
      const projectDir =
        projectRegistryPath === undefined ? undefined : path.dirname(projectRegistryPath);

      const userState = await readScopeState(userDir, "user", name);
      const projectState =
        projectDir !== undefined && projectDir !== userDir
          ? await readScopeState(projectDir, "project", name)
          : undefined;

      const inUser = userState.marketplaceKeys.length > 0 || userState.npmPresent;
      const inProject =
        projectState !== undefined &&
        (projectState.marketplaceKeys.length > 0 || projectState.npmPresent);

      if (!inUser && !inProject) {
        throw { code: "INVALID_ARGUMENT", message: `Plugin "${name}" is not installed` };
      }

      // Scope disambiguation (mirrors OMP's marketplace setPluginEnabled):
      // an explicit scope edits exactly that inventory; without one, the
      // winning (project-shadowing-user) record is the target.
      let target: PluginScopeState;
      if (inUser && inProject) {
        if (input.scope === undefined) target = projectState!;
        else target = input.scope === "user" ? userState : projectState!;
      } else if (inProject) {
        if (input.scope === "user") {
          throw { code: "INVALID_ARGUMENT", message: `Plugin "${name}" is not installed in user scope` };
        }
        target = projectState!;
      } else {
        if (input.scope === "project") {
          throw { code: "INVALID_ARGUMENT", message: `Plugin "${name}" is not installed in project scope` };
        }
        target = userState;
      }

      if (target.marketplaceKeys.length > 0) {
        // Marketplace installs: installed_plugins.json entries carry enabled.
        await applyMarketplaceToggle(target, name, enabled);
      } else {
        // npm/link/git packages: the scope lock file is the runtime config.
        await applyNpmToggle(target, name, enabled);
      }
      // Project-level toggles are also recorded in plugin-overrides.json so
      // the disable survives lock regeneration and applies project-wide.
      if (target.scope === "project") {
        await updateProjectOverrides(cwd, name, enabled);
      }

      const where = target.scope === "project" ? "（项目级）" : "（用户级）";
      return WRITE_OK(`已${enabled ? "启用" : "禁用"}插件 ${name}${where}，新会话生效。`);
    },

    async setSkillEnabled(input: {
      readonly name: string;
      readonly enabled: boolean;
      readonly scope?: "user" | "project";
    }): Promise<ConfigWriteResult> {
      const { name, enabled } = input;
      if (typeof name !== "string" || name.trim().length === 0) {
        throw { code: "INVALID_ARGUMENT", message: "skills.setEnabled name must not be empty" };
      }
      if (typeof enabled !== "boolean") {
        throw { code: "INVALID_ARGUMENT", message: "skills.setEnabled enabled must be a boolean" };
      }
      if (input.scope !== undefined && input.scope !== "user" && input.scope !== "project") {
        throw { code: "INVALID_ARGUMENT", message: "skills.setEnabled scope must be 'user' or 'project'" };
      }

      const home = options.home ?? homedir();
      const cwd = options.cwd ?? process.cwd();
      const { skills } = await discoverSkills({ home, cwd });

      // The winning (deduplicated) record is the one the UI lists. An
      // explicit scope maps user → global, project → workspace and only
      // considers that scope's visible record.
      let target: DiscoveredSkill | undefined;
      if (input.scope === undefined) {
        target = skills.find((skill) => skill.name === name && skill.scope !== "builtin") ?? skills.find((skill) => skill.name === name);
      } else {
        const want = input.scope === "user" ? "global" : "workspace";
        target = skills.find((skill) => skill.name === name && skill.scope === want);
      }
      if (target === undefined) {
        const detail = input.scope === undefined ? "" : ` in ${input.scope} scope`;
        throw { code: "INVALID_ARGUMENT", message: `Skill "${name}" is not installed${detail}` };
      }
      if (target.scope === "builtin") {
        throw { code: "INVALID_ARGUMENT", message: `Skill "${name}" 是内置技能，不可切换` };
      }

      let content: string;
      try {
        content = await fs.readFile(target.path, "utf8");
      } catch {
        throw { code: "UNAVAILABLE", message: `Skill "${name}" 的 SKILL.md 不可读` };
      }
      await atomicWriteText(target.path, editFrontmatterEnabled(content, enabled));

      const where = target.scope === "workspace" ? "（项目级）" : "（用户级）";
      return WRITE_OK(`已${enabled ? "启用" : "禁用"}技能 ${name}${where}。`);
    },
  };
}
