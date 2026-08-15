/**
 * Path resolution utilities — portable from omp-patch/vendor/oh-my-pi/packages/utils/src/dirs.ts
 * Supports profile-scoped agent dir, XDG redirects, and PI_CODING_AGENT_DIR / PI_CONFIG_DIR overrides.
 */

import * as path from "node:path";
import * as fs from "node:fs";

const CONFIG_DIR_NAME = ".omp";
const APP_NAME = "omp";

/**
 * Get the config directory name relative to home (e.g. ".omp" or PI_CONFIG_DIR override).
 */
export function getConfigDirName(): string {
  return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

function normalizeProfileName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "default") return undefined;
  return trimmed;
}

/** OMP_PROFILE overrides PI_PROFILE. */
function getActiveProfile(): string | undefined {
  try {
    return normalizeProfileName(process.env.OMP_PROFILE ?? process.env.PI_PROFILE);
  } catch {
    return undefined;
  }
}

/**
 * Get the base config root (~/.omp or profile-scoped ~/.omp/profiles/<name>).
 */
function getProfileConfigRoot(profile: string | undefined, home: string): string {
  const root = path.join(home, getConfigDirName());
  return profile ? path.join(root, "profiles", profile) : root;
}

function getProfileAgentDir(profile: string, home: string): string {
  return path.join(getProfileConfigRoot(profile, home), "agent");
}

function isProfileDerivedAgentDir(
  profile: string | undefined,
  agentDirEnv: string | undefined,
  home: string
): boolean {
  return profile !== undefined && agentDirEnv === getProfileAgentDir(profile, home);
}

/**
 * Resolve the agent dir override, filtering out profile-derived values.
 */
function resolvePreProfileAgentDir(
  profile: string | undefined,
  agentDirEnv: string | undefined,
  home: string
): string | undefined {
  return isProfileDerivedAgentDir(profile, agentDirEnv, home) ? undefined : agentDirEnv;
}

/**
 * Resolve XDG base directory for a given category (data / state / cache).
 */
function resolveXdgBase(
  envVar: string,
  profile: string | undefined,
  home: string
): string | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  const value = process.env[envVar];
  if (!value) return undefined;
  try {
    const appRoot = path.join(value, APP_NAME);
    if (profile) {
      const profilePath = path.join(appRoot, "profiles", profile);
      return fs.existsSync(profilePath) ? profilePath : undefined;
    }
    if (fs.existsSync(appRoot)) return appRoot;
  } catch {
    // unreadable XDG root — fall back to the config root
  }
  return undefined;
}

interface DirResolverOptions {
  readonly home: string;
  readonly agentDirOverride?: string | undefined;
  readonly profile?: string | undefined;
}

/**
 * Directory resolver with XDG awareness and profile support.
 */
class DirResolver {
  readonly configRoot: string;
  readonly agentDir: string;
  readonly home: string;

  readonly #rootDirs: { data: string; state: string; cache: string };
  readonly #agentDirs: { data: string; state: string; cache: string };

  constructor(options: DirResolverOptions) {
    this.home = options.home;
    const profile = normalizeProfileName(options.profile);
    this.configRoot = getProfileConfigRoot(profile, this.home);

    const defaultAgent = path.join(this.configRoot, "agent");
    const agentDirOverride = profile ? undefined : options.agentDirOverride;
    this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
    const isDefault = this.agentDir === defaultAgent;

    let xdgData: string | undefined;
    let xdgState: string | undefined;
    let xdgCache: string | undefined;
    if (isDefault) {
      xdgData = resolveXdgBase("XDG_DATA_HOME", profile, this.home);
      xdgState = resolveXdgBase("XDG_STATE_HOME", profile, this.home);
      xdgCache = resolveXdgBase("XDG_CACHE_HOME", profile, this.home);
    }

    this.#rootDirs = {
      data: xdgData ?? this.configRoot,
      state: xdgState ?? this.configRoot,
      cache: xdgCache ?? this.configRoot,
    };

    // XDG flattens the agent/ prefix: ~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions
    this.#agentDirs = {
      data: xdgData ?? this.agentDir,
      state: xdgState ?? this.agentDir,
      cache: xdgCache ?? this.agentDir,
    };
  }

  rootSubdir(subdir: string, xdg?: "data" | "state" | "cache"): string {
    const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
    return path.join(base, subdir);
  }

  agentSubdir(subdir: string, xdg?: "data" | "state" | "cache"): string {
    const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
    return path.join(base, subdir);
  }
}

let cachedResolver: DirResolver | undefined;

function getResolver(home: string): DirResolver {
  if (!cachedResolver || cachedResolver.home !== home) {
    const profile = getActiveProfile();
    const agentDirOverride = profile
      ? undefined
      : resolvePreProfileAgentDir(undefined, process.env.PI_CODING_AGENT_DIR, home);
    cachedResolver = new DirResolver({ home, agentDirOverride, profile });
  }
  return cachedResolver;
}

/**
 * Get the agent config directory (~/.omp/agent or profile/XDG-scoped).
 */
export function getAgentDir(home: string): string {
  return getResolver(home).agentDir;
}

/**
 * Get the plugins directory (~/.omp/plugins or its XDG equivalent).
 */
export function getPluginsDir(home: string): string {
  return getResolver(home).rootSubdir("plugins", "data");
}

/** Get the omp stats database path (~/.omp/stats.db or its XDG data equivalent). */
export function getStatsDbPath(home: string): string {
  return getResolver(home).rootSubdir("stats.db", "data");
}

/**
 * Get the project-local config directory (.omp).
 */
export function getProjectConfigDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME);
}
