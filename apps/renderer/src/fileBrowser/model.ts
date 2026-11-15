/**
 * 文件浏览器（全机文件）的显示层模型。
 *
 * 这里只有 Renderer 自己的形状与纯函数：路径拆分、排序、格式化、视图分档。
 * 数据从 `FileBrowserSource` 来——预览模式是 `preview/fileBrowserPreview.ts`
 * 的演示文件系统；真实模式使用 fileBrowserSource 的 Host 服务，不伪造目录。
 */

export type FsPlatform = "win32" | "darwin" | "linux";

export interface FsEntry {
  readonly workspace?: { readonly workspaceId: string; readonly relativePath: string };
  readonly name: string;
  /** 绝对路径，按来源平台的写法（`C:\Users\demo` / `/Users/demo`）。 */
  readonly path: string;
  readonly type: "file" | "dir";
  readonly size?: number;
  /** epoch 毫秒。 */
  readonly modified?: number;
  readonly hidden?: boolean;
  /** 符号链接 / 联接点。 */
  readonly link?: boolean;
  /** 列表里看得到，但没有权限进入或读取。 */
  readonly denied?: boolean;
}

export interface FsDirectory {
  readonly workspace?: { readonly workspaceId: string; readonly relativePath: string };
  readonly path: string;
  readonly entries: readonly FsEntry[];
  /** 条目超过上限，只返回了前一部分。 */
  readonly truncated?: boolean;
  /** 这个目录落在某个已注册项目里。 */
  readonly project?: { readonly name: string; readonly root: string };
}

export type FsQuickKind = "home" | "desktop" | "downloads" | "documents" | "pictures";
export interface FsQuickPlace { readonly kind: FsQuickKind; readonly label: string; readonly path: string }
export interface FsDrive { readonly path: string; readonly label: string; readonly total?: number; readonly free?: number; readonly ready: boolean }
export interface FsProjectPlace { readonly name: string; readonly root: string; readonly current?: boolean }

export interface FsPlaces {
  readonly platform: FsPlatform;
  readonly separator: "\\" | "/";
  /** 根层（盘符 / 卷）的显示名：「此电脑」「此 Mac」或远端主机名。 */
  readonly computerLabel: string;
  readonly home: string;
  readonly quick: readonly FsQuickPlace[];
  readonly drives: readonly FsDrive[];
  readonly projects: readonly FsProjectPlace[];
}

export interface FsPeek {
  /** Release an image lease when the preview card closes or changes selection. */
  readonly release?: () => void;
  /** 文本文件的开头若干行。 */
  readonly text?: string;
  /** 可直接放进 `<img>` 的地址（预览为 data URL，真实为文件租约 URL）。 */
  readonly image?: string;
}

/**
 * 数据来源。预览与真实互斥：预览模式只用演示文件系统，真实模式只用 Host；
 * 一边为空时不回退到另一边。
 */
export interface FileBrowserSource {
  readonly kind: "preview" | "host";
  /** 来源标签：「本机」或「SSH · 名称」。 */
  readonly label: string;
  /** 本机才有的系统动作（系统程序打开、在资源管理器中定位）。 */
  readonly local: boolean;
  /** 是否支持移到回收站；远端没有回收站。 */
  readonly trash: boolean;
  places(): Promise<FsPlaces>;
  /** `""` 是根层：「此电脑」下的盘符与卷。 */
  list(path: string, showHidden?: boolean): Promise<FsDirectory>;
  peek(entry: FsEntry): Promise<FsPeek>;
  createFolder(parent: string, name: string): Promise<string>;
  rename(path: string, name: string): Promise<string>;
  trashItems(paths: readonly string[]): Promise<void>;
}

export const COMPUTER = "";

export type BrowserView = "tree" | "list" | "columns";
/** 宽度分档：0 窄（只有树）、1 中（位置栏 + 列表，可切树）、2 宽（默认分栏，三种都可选）。 */
export const VIEW_STEPS = [480, 900] as const;
export const TIER_VIEWS: readonly (readonly BrowserView[])[] = [["tree"], ["tree", "list"], ["tree", "list", "columns"]];
export const TIER_DEFAULT: readonly BrowserView[] = ["tree", "list", "columns"];

/** 显式选择优先；当前宽度放不下时临时降到这一档允许的最宽视图，宽度恢复后回到原选择。 */
export function effectiveView(tier: number, explicit: BrowserView | null): BrowserView {
  const allowed = TIER_VIEWS[tier] ?? TIER_VIEWS[0]!;
  if (explicit && allowed.includes(explicit)) return explicit;
  if (explicit) return allowed[allowed.length - 1]!;
  return TIER_DEFAULT[tier] ?? "tree";
}

/* ---------- 路径 ---------- */

const trimEnd = (path: string, sep: string) => path.length > 1 && path.endsWith(sep) && !isDriveRoot(path, sep) ? path.slice(0, -1) : path;
const isDriveRoot = (path: string, sep: string) => sep === "\\" ? /^[A-Za-z]:\\?$/.test(path) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(path) : path === "/";

export function parentPath(path: string, sep: string): string {
  if (path === COMPUTER) return COMPUTER;
  const value = trimEnd(path, sep);
  if (isDriveRoot(value, sep)) return COMPUTER;
  const index = value.lastIndexOf(sep);
  if (index < 0) return COMPUTER;
  const parent = value.slice(0, index);
  if (sep === "\\" && /^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  if (sep === "/" && parent === "") return "/";
  return parent;
}

export function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function baseName(path: string, sep: string): string {
  const value = trimEnd(path, sep);
  if (sep === "\\" && /^[A-Za-z]:\\?$/.test(value)) return value.slice(0, 2);
  if (value === "/") return "/";
  return value.slice(value.lastIndexOf(sep) + 1) || value;
}

export interface PathSegment { readonly label: string; readonly path: string }
/** 面包屑：根层 → 盘符 / 卷 → 各级目录。 */
export function pathSegments(path: string, places: Pick<FsPlaces, "separator" | "computerLabel" | "drives">): PathSegment[] {
  const sep = places.separator;
  const out: PathSegment[] = [{ label: places.computerLabel, path: COMPUTER }];
  if (path === COMPUTER) return out;
  const chain: string[] = [];
  for (let current = trimEnd(path, sep); current !== COMPUTER; current = parentPath(current, sep)) {
    chain.unshift(current);
    if (chain.length > 64) break;
  }
  for (const item of chain) {
    const drive = places.drives.find(value => samePath(value.path, item, sep));
    out.push({ label: drive ? driveShortLabel(drive, sep) : baseName(item, sep), path: item });
  }
  return out;
}

/**
 * 分栏的起点：包含当前位置的最深的「位置」（快速访问 / 项目 / 已固定 / 盘符），
 * 与 Finder 一样从侧栏所在处展开，而不是每次从「此电脑」排起。
 */
export function columnRoot(current: string, places: FsPlaces, pins: readonly string[]): string {
  if (current === COMPUTER) return COMPUTER;
  const all = [...places.quick.map(item => item.path), ...places.projects.map(item => item.root), ...pins, ...places.drives.map(item => item.path)];
  return all.filter(path => within(current, path, places.separator)).sort((a, b) => b.length - a.length)[0] ?? COMPUTER;
}

export function samePath(a: string, b: string, sep: string): boolean {
  const left = trimEnd(a, sep), right = trimEnd(b, sep);
  return sep === "\\" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** `b` 在 `a` 之内（含相等）。 */
export function within(child: string, parent: string, sep: string): boolean {
  if (parent === COMPUTER) return true;
  const c = trimEnd(child, sep), p = trimEnd(parent, sep);
  const [cc, pp] = sep === "\\" ? [c.toLowerCase(), p.toLowerCase()] : [c, p];
  return cc === pp || cc.startsWith(pp.endsWith(sep) ? pp : pp + sep);
}

export function driveShortLabel(drive: FsDrive, sep: string): string {
  return sep === "\\" ? drive.path.slice(0, 2) : drive.label;
}

/** 位置栏与根层列表里的卷名：Windows「系统 (C:)」，其余直接用卷名。 */
export function driveDisplayName(drive: FsDrive, sep: string): string {
  return sep === "\\" && drive.label !== drive.path.slice(0, 2) ? `${drive.label} (${drive.path.slice(0, 2)})` : drive.label;
}

/** 路径栏输入：`~` 展开为主目录，去掉两端引号与空白。 */
export function normalizeInput(input: string, places: Pick<FsPlaces, "home" | "separator">): string {
  let value = input.trim().replace(/^["']|["']$/g, "");
  if (value === "~") return places.home;
  if (value.startsWith("~/") || value.startsWith("~\\")) value = joinPath(places.home, value.slice(2), places.separator);
  if (places.separator === "\\") value = value.replaceAll("/", "\\");
  if (places.separator === "\\" && /^[A-Za-z]:$/.test(value)) value += "\\";
  return value;
}

/* ---------- 排序与格式 ---------- */

export type SortKey = "name" | "modified" | "type" | "size";
export interface SortState { readonly key: SortKey; readonly dir: 1 | -1 }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const extensionOf = (name: string) => { const index = name.lastIndexOf("."); return index > 0 ? name.slice(index + 1).toLowerCase() : ""; };

/** 目录永远在前；同类再按所选列排序，平手按名称。 */
export function sortEntries(entries: readonly FsEntry[], sort: SortState): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    let delta = 0;
    if (sort.key === "modified") delta = (a.modified ?? 0) - (b.modified ?? 0);
    else if (sort.key === "size") delta = (a.size ?? -1) - (b.size ?? -1);
    else if (sort.key === "type") delta = collator.compare(extensionOf(a.name), extensionOf(b.name));
    if (delta === 0) delta = collator.compare(a.name, b.name);
    return delta * sort.dir;
  });
}

export function visibleEntries(entries: readonly FsEntry[], showHidden: boolean, filter: string): FsEntry[] {
  const query = filter.trim().toLowerCase();
  return entries.filter(entry => (showHidden || !entry.hidden) && (!query || entry.name.toLowerCase().includes(query)));
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** 今天 14:02 / 昨天 09:10 / 11-12 / 2025-03-08。 */
export function formatModified(epoch: number | undefined, now = Date.now(), language: "zh" | "en" = "zh"): string {
  if (epoch === undefined) return "";
  const date = new Date(epoch), today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (epoch >= start) return `${language === "zh" ? "今天" : "Today"} ${time}`;
  if (epoch >= start - 86_400_000) return `${language === "zh" ? "昨天" : "Yesterday"} ${time}`;
  if (date.getFullYear() === today.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 容量条三级：<75% 绿、<90% 琥珀、≥90% 红。 */
export function usageTone(drive: FsDrive): "ok" | "warn" | "full" | undefined {
  if (!drive.total || drive.free === undefined) return undefined;
  const used = 1 - drive.free / drive.total;
  return used >= 0.9 ? "full" : used >= 0.75 ? "warn" : "ok";
}

/** 新建 / 重命名的名称检查，只给就地提示；真正的检查在执行操作的那一层。 */
export function nameProblem(name: string, platform: FsPlatform, language: "zh" | "en" = "zh"): string | undefined {
  const value = name.trim();
  const zh = language === "zh";
  if (!value) return zh ? "名称不能为空" : "Name is required";
  if (value === "." || value === "..") return zh ? "名称不可用" : "Name is not allowed";
  if (/[\\/]/.test(value) || platform === "win32" && /[<>:"|?*]/.test(value)) return zh ? "名称不能包含 \\ / : * ? \" < > |" : "Name can't contain \\ / : * ? \" < > |";
  if (platform === "win32" && /[. ]$/.test(value)) return zh ? "名称不能以点或空格结尾" : "Name can't end with a dot or space";
  return undefined;
}
