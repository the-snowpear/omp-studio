/**
 * 侧栏「项目 / 会话列表」与 Explorer 文件树展开状态的本地记忆。
 *
 * localStorage 级 Renderer UI 记忆（与 appSettings 同介质），不进 Host。
 * 读写全容错：存储被阻塞或内容损坏时静默退回「无记忆」。
 * 预览模式不写入，避免演示 fixture 污染真实工作区记忆。
 */

const EXPANDED_PROJECTS_KEY = "omp.sidebar.expandedProjects";
const EXPLORER_EXPANSION_KEY = "omp.sidebar.explorerExpansion";

/* 上限只防存储无限膨胀；正常使用远达不到。 */
const MAX_PROJECTS = 256;
const MAX_PATHS_PER_WORKSPACE = 512;
const MAX_WORKSPACES = 64;

export type ExpandedProjectsMemory =
  | { readonly restored: false }
  | { readonly restored: true; readonly ids: ReadonlySet<string> };

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 存储被阻塞时记忆只活在本次会话内存里。 */
  }
}

function stringArray(value: unknown, cap: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > cap) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 512) return undefined;
    items.push(item);
  }
  return items;
}

/**
 * 读取侧栏项目展开记忆。键不存在（从未写过）返回 `{ restored: false }`，
 * 调用方据此保留「首启默认展开活动项目」的旧行为；键存在（哪怕为空数组，
 * 即用户收起了所有项目）返回 `{ restored: true }`，启动时按记忆恢复。
 */
export function readExpandedProjects(): ExpandedProjectsMemory {
  const raw = readStorage(EXPANDED_PROJECTS_KEY);
  if (raw === null) return { restored: false };
  try {
    const ids = stringArray((JSON.parse(raw) as Record<string, unknown>).expandedProjects, MAX_PROJECTS);
    if (ids === undefined) return { restored: false };
    return { restored: true, ids: new Set(ids) };
  } catch {
    return { restored: false };
  }
}

export function writeExpandedProjects(ids: ReadonlySet<string>): void {
  const expandedProjects = [...ids].slice(0, MAX_PROJECTS);
  writeStorage(EXPANDED_PROJECTS_KEY, JSON.stringify({ expandedProjects }));
}

/** 读取一个工作区记忆的 Explorer 展开目录路径（工作区相对路径）。 */
export function readExplorerExpansion(workspaceId: string): ReadonlySet<string> {
  const raw = readStorage(EXPLORER_EXPANSION_KEY);
  if (raw === null) return new Set();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const paths = stringArray(value[workspaceId], MAX_PATHS_PER_WORKSPACE);
    return new Set(paths ?? []);
  } catch {
    return new Set();
  }
}

/** 写入一个工作区的展开路径；空集合删除该工作区条目。 */
export function writeExplorerExpansion(workspaceId: string, paths: ReadonlySet<string>): void {
  let stored: Record<string, unknown> = {};
  try {
    const raw = readStorage(EXPLORER_EXPANSION_KEY);
    if (raw !== null) stored = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* 损坏内容从空重建。 */
  }
  if (paths.size === 0) delete stored[workspaceId];
  else stored[workspaceId] = [...paths].slice(0, MAX_PATHS_PER_WORKSPACE);
  const keys = Object.keys(stored);
  if (keys.length > MAX_WORKSPACES) {
    for (const key of keys.slice(0, keys.length - MAX_WORKSPACES)) delete stored[key];
  }
  writeStorage(EXPLORER_EXPANSION_KEY, JSON.stringify(stored));
}

/** 测试辅助：清空本模块全部存储，保证用例间互不泄漏。 */
export function __resetExpandMemoryForTests(): void {
  try {
    globalThis.localStorage?.removeItem(EXPANDED_PROJECTS_KEY);
    globalThis.localStorage?.removeItem(EXPLORER_EXPANSION_KEY);
  } catch {
    /* ignore */
  }
}
