import type {
  AgentDefinitionRecord,
  SkillRecord,
  StudioClient,
  WorkspaceFileTreeReadModel,
  WorkspaceId,
} from "@omp-studio/client-contract";

import type { MentionCandidate } from "./types";

/** `@` shows agents, skills (when the query is non-empty), and workspace paths. `/` is the command menu, not a mention. */
const MENTION_LIMIT = 12;

function matchQuery(item: MentionCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    item.label.toLowerCase().includes(needle) ||
    (item.name !== undefined && item.name.toLowerCase().includes(needle)) ||
    (item.detail !== undefined && item.detail.toLowerCase().includes(needle)) ||
    (item.path !== undefined && item.path.toLowerCase().includes(needle))
  );
}

export function filterMentions(items: readonly MentionCandidate[], query: string): MentionCandidate[] {
  return items.filter((item) => matchQuery(item, query)).slice(0, MENTION_LIMIT);
}

function agentCandidate(agent: Pick<AgentDefinitionRecord, "name" | "description">): MentionCandidate {
  return {
    kind: "agent",
    id: `agent:${agent.name}`,
    label: agent.name,
    name: agent.name,
    ...(agent.description ? { detail: agent.description } : {}),
  };
}

function skillCandidate(skill: Pick<SkillRecord, "name" | "desc">): MentionCandidate {
  return {
    kind: "skill",
    id: `skill:${skill.name}`,
    label: skill.name,
    name: skill.name,
    ...(skill.desc ? { detail: skill.desc } : {}),
  };
}

// ---- 工作区文件 / 文件夹候选 ----

export type WorkspaceEntry = {
  readonly type: "file" | "dir";
  readonly name: string;
  /** Workspace-relative, forward slashes, no trailing slash. */
  readonly path: string;
};

/** Lists one directory level. Root is `undefined` / `""`. */
export type DirectoryLister = (path?: string) => Promise<ReadonlyArray<WorkspaceEntry>>;

export type WorkspaceFileIndex = {
  search(query: string): Promise<MentionCandidate[]>;
};

/**
 * Directories skipped while indexing: huge, generated, or irrelevant as mentions.
 * A user can still reach them by typing the path (slash queries list on demand).
 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
]);

/** Bounded so the first `@` keystroke stays responsive on a large repo. */
const WALK_DIR_BUDGET = 400;
const WALK_ENTRY_BUDGET = 6_000;
const WALK_DEPTH_BUDGET = 8;
/** Directories listed concurrently per BFS level. */
const WALK_BATCH = 8;

function depthOf(path: string): number {
  return path.length === 0 ? 0 : path.split("/").length;
}

/** Referencing a generated tree is never useful, so it is not a candidate either. */
function mentionable(entry: WorkspaceEntry): boolean {
  return entry.type !== "dir" || !SKIPPED_DIRS.has(entry.name);
}

/** Dot-directories stay listable by name but are not walked into. */
function descendable(entry: WorkspaceEntry): boolean {
  return mentionable(entry) && !entry.name.startsWith(".");
}

async function walkWorkspace(list: DirectoryLister): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  let pending: string[] = [""];
  let listed = 0;
  while (pending.length > 0 && listed < WALK_DIR_BUDGET && entries.length < WALK_ENTRY_BUDGET) {
    const batch = pending.splice(0, WALK_BATCH);
    listed += batch.length;
    const levels = await Promise.all(
      batch.map(async (dir) => {
        try {
          return await list(dir === "" ? undefined : dir);
        } catch {
          return [];
        }
      }),
    );
    const next: string[] = [];
    for (const level of levels) {
      for (const entry of level) {
        if (!mentionable(entry)) continue;
        entries.push(entry);
        if (entry.type === "dir" && descendable(entry) && depthOf(entry.path) < WALK_DEPTH_BUDGET) {
          next.push(entry.path);
        }
      }
    }
    pending = [...pending, ...next];
  }
  return entries;
}

function entryCandidate(entry: WorkspaceEntry): MentionCandidate {
  return {
    kind: entry.type === "dir" ? "dir" : "file",
    id: `${entry.type}:${entry.path}`,
    label: entry.name,
    path: entry.path,
    // Capsules show only the basename, so the menu carries the parent folder.
    ...(entry.path === entry.name ? {} : { detail: entry.path }),
  };
}

/**
 * Lower sorts first: basename prefix, then basename substring, then path
 * substring. Ties break on path length so shallow paths win.
 */
function entryRank(entry: WorkspaceEntry, needle: string): number | null {
  if (needle.length === 0) return 3;
  const name = entry.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if (entry.path.toLowerCase().includes(needle)) return 2;
  return null;
}

function rankEntries(entries: readonly WorkspaceEntry[], needle: string): MentionCandidate[] {
  const scored: Array<{ entry: WorkspaceEntry; rank: number }> = [];
  for (const entry of entries) {
    const rank = entryRank(entry, needle);
    if (rank !== null) scored.push({ entry, rank });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const depth = depthOf(a.entry.path) - depthOf(b.entry.path);
    if (depth !== 0) return depth;
    return a.entry.path.localeCompare(b.entry.path);
  });
  return scored.map((item) => entryCandidate(item.entry));
}

function dedupeById(items: readonly MentionCandidate[]): MentionCandidate[] {
  const seen = new Set<string>();
  const out: MentionCandidate[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Caches one bounded workspace walk and filters it locally, so typing after `@`
 * does not re-hit the Host per keystroke. A query containing `/` also lists that
 * directory on demand, which reaches paths beyond the walk budget.
 */
export function createWorkspaceFileIndex(list: DirectoryLister): WorkspaceFileIndex {
  let walk: Promise<WorkspaceEntry[]> | null = null;
  const dirCache = new Map<string, Promise<ReadonlyArray<WorkspaceEntry>>>();
  const listDir = (path: string): Promise<ReadonlyArray<WorkspaceEntry>> => {
    const cached = dirCache.get(path);
    if (cached) return cached;
    const request = list(path === "" ? undefined : path).catch(() => [] as WorkspaceEntry[]);
    dirCache.set(path, request);
    return request;
  };
  return {
    async search(query: string): Promise<MentionCandidate[]> {
      const raw = query.trim().replaceAll("\\", "/");
      const needle = raw.toLowerCase();
      const slash = raw.lastIndexOf("/");
      if (slash !== -1) {
        const dir = raw.slice(0, slash);
        const tail = raw.slice(slash + 1).toLowerCase();
        const siblings = await listDir(dir);
        const inDir = rankEntries(siblings, tail);
        if (inDir.length > 0) return inDir.slice(0, MENTION_LIMIT);
      }
      walk ??= walkWorkspace((path) => listDir(path ?? ""));
      return rankEntries(await walk, needle).slice(0, MENTION_LIMIT);
    },
  };
}

/** Wraps the `workspace.fileTree` query as a directory lister. */
export function workspaceDirectoryLister(client: StudioClient, workspaceId: WorkspaceId): DirectoryLister {
  return async (path) => {
    const model: WorkspaceFileTreeReadModel = await client.query("workspace.fileTree", {
      workspaceId,
      ...(path === undefined || path === "" ? {} : { path }),
    });
    return model.nodes.map((node) => ({ type: node.type, name: node.name, path: node.path }));
  };
}

// ---- 预览模式演示数据 ----

const PREVIEW_AGENTS: ReadonlyArray<MentionCandidate> = [
  { kind: "agent", id: "agent:explore", label: "explore", name: "explore", detail: "快速扫仓库、定位相关文件" },
  { kind: "agent", id: "agent:code-reviewer", label: "code-reviewer", name: "code-reviewer", detail: "审阅 diff 与回归风险" },
  { kind: "agent", id: "agent:generalPurpose", label: "generalPurpose", name: "generalPurpose", detail: "通用子代理" },
];

const PREVIEW_SKILLS: ReadonlyArray<MentionCandidate> = [
  { kind: "skill", id: "skill:commit-msg", label: "commit-msg", name: "commit-msg", detail: "Conventional Commits" },
];

const PREVIEW_ENTRIES: ReadonlyArray<WorkspaceEntry> = [
  { type: "dir", name: "src", path: "apps/renderer/src" },
  { type: "dir", name: "composer", path: "apps/renderer/src/composer" },
  { type: "file", name: "App.tsx", path: "apps/renderer/src/App.tsx" },
  { type: "file", name: "ChipComposer.tsx", path: "apps/renderer/src/composer/ChipComposer.tsx" },
  { type: "file", name: "workbench.css", path: "apps/renderer/src/styles/workbench.css" },
  { type: "file", name: "package.json", path: "package.json" },
  { type: "file", name: "AGENTS.md", path: "AGENTS.md" },
];

export function previewMentions(trigger: "@" | "/", query: string): MentionCandidate[] {
  if (trigger === "/") return [];
  const agents = filterMentions(PREVIEW_AGENTS, query);
  const skills = query.trim().length === 0 ? [] : filterMentions(PREVIEW_SKILLS, query);
  const entries = rankEntries(PREVIEW_ENTRIES, query.trim().replaceAll("\\", "/").toLowerCase());
  return dedupeById([...agents, ...skills, ...entries]).slice(0, MENTION_LIMIT);
}

export async function loadMentions(
  client: StudioClient,
  trigger: "@" | "/",
  query: string,
  files?: WorkspaceFileIndex,
): Promise<MentionCandidate[]> {
  if (trigger === "/") return [];
  const needle = query.trim();
  const [agents, skills, entries] = await Promise.all([
    client
      .query("agents.definitions.get", {})
      .then((model) => filterMentions(model.agents.filter((agent) => !agent.disabled).map(agentCandidate), query))
      .catch(() => [] as MentionCandidate[]),
    needle.length === 0
      ? Promise.resolve([] as MentionCandidate[])
      : client
          .query("skills.get", {})
          .then((model) =>
            filterMentions(
              model.skills
                .filter((skill) => skill.enabled && !skill.hide && skill.error === undefined)
                .map(skillCandidate),
              query,
            ),
          )
          .catch(() => [] as MentionCandidate[]),
    files?.search(query).catch(() => [] as MentionCandidate[]) ?? Promise.resolve([] as MentionCandidate[]),
  ]);
  return dedupeById([...agents, ...skills, ...entries]).slice(0, MENTION_LIMIT);
}
