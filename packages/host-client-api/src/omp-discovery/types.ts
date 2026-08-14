/**
 * Internal types for OMP-compatible skill and plugin discovery.
 * These are richer than the display-layer SkillRecord/PluginRecord contracts.
 */

export interface DiscoveredSkill {
  /** Skill name (from frontmatter or directory name) */
  readonly name: string;
  /** Description (from frontmatter) */
  readonly description: string;
  /** Absolute path to SKILL.md */
  readonly path: string;
  /** Scope classification (workspace / global / builtin) */
  readonly scope: 'workspace' | 'global' | 'builtin';
  /** Source kind (native / plugin / managed) */
  readonly sourceKind: 'native' | 'plugin' | 'managed';
  /** Display label for source (项目 / 用户 / 插件 / 托管) */
  readonly sourceLabel: string;
  /** Provider id (native, omp-plugins, claude, agent-plugins, etc.) */
  readonly providerId: string;
  /** Provider priority (higher wins on collision) */
  readonly priority: number;
  /** Frontmatter enabled field */
  readonly enabled: boolean;
  /** Frontmatter hide field */
  readonly hide: boolean;
  /** Frontmatter disable-model-invocation / disableModelInvocation */
  readonly disableModelInvocation: boolean;
  /** Full parsed frontmatter (for advanced consumers) */
  readonly frontmatter: Record<string, unknown>;
}

export interface PluginManifestView {
  readonly tools?: string;
  readonly hooks?: string;
  readonly extensions?: string[];
  readonly commands?: string[];
  readonly features?: Record<
    string,
    { tools?: string[]; hooks?: string[]; commands?: string[]; extensions?: string[] }
  >;
}

export interface DiscoveredPlugin {
  /** Plugin name (npm package name or plugin id) */
  readonly name: string;
  /** Plugin version */
  readonly version: string;
  /** Root directory path */
  readonly root: string;
  /** Source classification (npm / marketplace / link / git) */
  readonly sourceKind: 'npm' | 'marketplace' | 'link' | 'git';
  /** Whether the plugin is enabled */
  readonly enabled: boolean;
  /** Whether the plugin carries an OMP/pi package manifest (or a marketplace manifest) */
  readonly hasOmpManifest: boolean;
  /** Parsed plugin manifest (from pkg.omp / pkg.pi / plugin.json) */
  readonly manifest: PluginManifestView;
  /** Skill directory paths this plugin contributes */
  readonly skillDirs: string[];
}

/**
 * Settings-driven discovery filters. Declared for the next round; this
 * round `discover*` must ignore them.
 */
export interface SkillDiscoveryFilters {
  // enabled?: boolean;
  // enableCodexUser?: boolean;
  // enableClaudeUser?: boolean;
  // enableClaudeProject?: boolean;
  // enablePiUser?: boolean;
  // enablePiProject?: boolean;
  // enableAgentsUser?: boolean;
  // enableAgentsProject?: boolean;
  // ignoredSkills?: string[];
  // includeSkills?: string[];
  // customDirectories?: string[];
  // disabledExtensions?: string[];
}

export interface DiscoveryOptions {
  /** User home directory */
  readonly home?: string;
  /** Current working directory (project root) */
  readonly cwd?: string;
  /** Settings filters — reserved, ignored this round */
  readonly filters?: SkillDiscoveryFilters;
}

export interface LoadContext {
  /** User home directory */
  readonly home: string;
  /** Current working directory (project root) */
  readonly cwd: string;
}

export interface DiscoveryWarning {
  readonly message: string;
  readonly providerId?: string;
}

export interface DiscoveryResult {
  readonly skills: DiscoveredSkill[];
  readonly plugins: DiscoveredPlugin[];
  readonly warnings: DiscoveryWarning[];
}
