/**
 * Preview-only skills / plugins, ported from ui_reference/ver1/assets/js/mock-data.js.
 * Used by the sidebar drawer until Host exposes a skills read model.
 */

export type SkillScope = "workspace" | "global" | "builtin";
export type DrawerKind = "skill" | "plugin";
export type DrawerCat = "all" | "skill" | "plugin";

export type SkillPreview = {
  kind: "skill";
  name: string;
  desc: string;
  src: string;
  scope: SkillScope;
  path: string;
  enabled: boolean;
  loaded: boolean;
  session: boolean;
  error?: string;
  retrying?: boolean;
};

export type PluginPreview = {
  kind: "plugin";
  name: string;
  src: string;
  status: "loaded" | "error";
  tools: number;
  commands: number;
  hooks: number;
  ui: boolean;
  err: string | null;
  enabled?: boolean;
  retrying?: boolean;
  toolItems?: string[];
  commandItems?: string[];
  hookItems?: string[];
  uiItems?: string[];
};

export type DrawerItem = SkillPreview | PluginPreview;

export const ICON_BY_NAME: Record<string, string> = {
  "upstream-sync": "refresh",
  "code-review-graph": "network",
  "mermaid-verify": "image",
  "commit-msg": "pencil",
  "oss-audit": "shield",
  "omp-preview-tools": "eye",
  "git-worktree-plus": "branch",
  "browser-lab": "globe",
};

export type SkillTone = "purple" | "blue" | "green" | "amber" | "teal" | "cyan" | "rose" | "gray" | "red";

const SKILL_TONES: readonly Exclude<SkillTone, "red" | "gray">[] = [
  "purple",
  "blue",
  "green",
  "amber",
  "teal",
  "cyan",
  "rose",
];

/** Named preview fixtures keep a stable hue; unknown names hash into the palette. */
export const COLOR_BY_NAME: Partial<Record<string, Exclude<SkillTone, "red">>> = {
  "upstream-sync": "green",
  "code-review-graph": "purple",
  "mermaid-verify": "blue",
  "commit-msg": "amber",
  "oss-audit": "rose",
  "omp-preview-tools": "teal",
  "git-worktree-plus": "cyan",
  "browser-lab": "amber",
};

function hashTone(name: string): (typeof SKILL_TONES)[number] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 33 + name.charCodeAt(i)) | 0;
  return SKILL_TONES[Math.abs(hash) % SKILL_TONES.length] ?? "purple";
}

/** Card accent. Errors stay red; everything else is per-name, not per-scope. */
export function itemTone(item: DrawerItem): SkillTone {
  if (isDrawerItemError(item)) return "red";
  return COLOR_BY_NAME[item.name] ?? hashTone(item.name);
}

export function createPreviewDrawerItems(): DrawerItem[] {
  return [
    {
      kind: "skill",
      name: "upstream-sync",
      desc: "跟踪上游仓库同步的标准流程（graft、合并、验证）",
      src: "OMP",
      scope: "workspace",
      path: ".omp/skills/upstream-sync/SKILL.md",
      enabled: true,
      loaded: true,
      session: true,
    },
    {
      kind: "skill",
      name: "code-review-graph",
      desc: "生成代码审查依赖图",
      src: "OMP",
      scope: "global",
      path: "~/.omp/skills/code-review-graph/SKILL.md",
      enabled: true,
      loaded: true,
      session: true,
    },
    {
      kind: "skill",
      name: "mermaid-verify",
      desc: "Mermaid 图表渲染回归验证",
      src: "OMP",
      scope: "workspace",
      path: ".omp/skills/mermaid-verify/SKILL.md",
      enabled: true,
      loaded: true,
      session: false,
    },
    {
      kind: "skill",
      name: "commit-msg",
      desc: "生成符合 Conventional Commits 的提交信息",
      src: "OMP",
      scope: "global",
      path: "~/.omp/skills/commit-msg/SKILL.md",
      enabled: false,
      loaded: false,
      session: false,
    },
    {
      kind: "skill",
      name: "oss-audit",
      desc: "开源仓库发布前合规检查",
      src: "托管",
      scope: "builtin",
      path: "omp:builtin/oss-audit",
      enabled: true,
      loaded: true,
      session: true,
      error: "SKILL.md 第 42 行 frontmatter 缺 summary",
    },
    {
      kind: "plugin",
      name: "omp-preview-tools",
      src: "内置",
      status: "loaded",
      tools: 4,
      commands: 1,
      hooks: 2,
      ui: true,
      err: null,
      toolItems: ["preview_snapshot", "preview_diff", "preview_open", "preview_dom"],
      commandItems: ["/preview"],
      hookItems: ["PreToolUse:Preview", "PostToolUse:Preview"],
      uiItems: ["Preview 侧栏扩展"],
    },
    {
      kind: "plugin",
      name: "git-worktree-plus",
      src: "npm · omp-plugin-worktree",
      status: "loaded",
      tools: 3,
      commands: 2,
      hooks: 1,
      ui: true,
      err: null,
      toolItems: ["git_blame_range", "git_file_history", "git_stash_diff"],
      commandItems: ["/blame", "/file-history"],
      hookItems: ["PreToolUse:Bash"],
      uiItems: ["Diff 侧栏扩展"],
    },
    {
      kind: "plugin",
      name: "browser-lab",
      src: "本地目录 · ~/omp-plugins/browser-lab",
      status: "error",
      tools: 0,
      commands: 0,
      hooks: 0,
      ui: false,
      err: "加载失败：manifest.json 缺少 \"omp\" 字段",
    },
  ];
}

/** Inventory on/off. Skills: SKILL.md `enabled`. Plugins: explicit override or loaded. */
export function isDrawerItemEnabled(item: DrawerItem): boolean {
  if (item.kind === "skill") return item.enabled;
  return item.enabled ?? item.status === "loaded";
}

/**
 * Drawer「加入态」: the skill was used in the current conversation (`session`),
 * not merely present in configured inventory. Plugins stay session-loaded.
 */
export function isDrawerItemAdded(item: DrawerItem): boolean {
  if (item.kind === "skill") return item.session;
  return isDrawerItemEnabled(item);
}

export function isDrawerItemError(item: DrawerItem): boolean {
  return item.kind === "skill" ? Boolean(item.error) : Boolean(item.err);
}

/** Sidebar badge: skills used in this conversation + loaded plugins. */
export function countEnabledDrawerItems(items: readonly DrawerItem[]): number {
  return items.filter(isDrawerItemAdded).length;
}

export function matchesDrawerQuery(item: DrawerItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const desc = item.kind === "skill" ? item.desc : item.err ?? "";
  return `${item.name} ${desc} ${item.src}`.toLowerCase().includes(q);
}

/**
 * List identity for React keys and filter animation.
 * `name` alone is not unique: a skill and a plugin (or two plugins) can share one.
 */
export function drawerItemKey(item: DrawerItem): string {
  if (item.kind === "plugin") return `plugin:${item.src}:${item.name}`;
  return `skill:${item.scope}:${item.src}:${item.name}`;
}

/** Disambiguate duplicate `drawerItemKey` values among siblings (`base`, `base#1`, …). */
export function withUniqueDrawerKeys<T extends DrawerItem>(items: readonly T[]): Array<{ item: T; key: string }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = drawerItemKey(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { item, key: n === 0 ? base : `${base}#${n}` };
  });
}
