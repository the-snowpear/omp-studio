import { lstat, mkdir, opendir, readdir, realpath, stat, statfs } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { SystemDirectory, SystemEntry, SystemFileTarget, SystemListInput, SystemPlaces, SystemQuickKind, WorkspaceId } from "@omp-studio/client-contract";
import type { HostSystemFileService } from "@omp-studio/host-client-api";
import type { WorkspaceRegistry } from "@omp-studio/studio-host";
import { inspectFile, readFileChunk, readFileText, writeFileText } from "./file-io.js";
import { renameWithoutOverwrite } from "./platform/file-rename.js";

const DIRECTORY_LIMIT = 5_000;
const WINDOWS_HIDDEN = new Set(["$recycle.bin", "system volume information", "pagefile.sys", "swapfile.sys", "hiberfil.sys", "dumpstack.log.tmp", "desktop.ini"]);
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const inside = (root: string, path: string) => { const suffix = relative(root, path); return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`); };

/** Shared by the executing file service and the local shell actions, never by forwarding layers. */
export function normalizeSystemPath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("文件路径无效：不能包含 NUL");
  const expanded = value === "~" ? homedir() : /^~[\\/]/.test(value) ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error("文件路径必须是绝对路径");
  if (process.platform === "win32") {
    const windows = expanded.replaceAll("/", "\\");
    if (/^\\\\[?.]\\|^\\\?\?\\/.test(windows)) throw new Error("不能访问 Windows 设备路径");
    if (!/^[a-z]:\\|^\\\\[^\\]+\\[^\\]+/i.test(windows)) throw new Error("文件路径必须包含盘符或 UNC 共享名");
    const parts = windows.slice(parse(windows).root.length).split("\\");
    if (parts.some(part => DEVICE_NAME.test(part.replace(/[ .]+$/, "")) || part.includes(":"))) throw new Error("不能访问 Windows 保留设备名或数据流");
  }
  return resolve(expanded);
}

function entryName(name: string): string {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw new Error("名称不能为空或包含路径分隔符");
  if (process.platform === "win32" && (DEVICE_NAME.test(name) || /[<>:"|?*\x01-\x1f]/.test(name) || /[ .]$/.test(name))) throw new Error("名称不能使用 Windows 保留名、特殊字符或以点和空格结尾");
  return name;
}

export interface SystemFileServiceOptions {
  readonly registry: WorkspaceRegistry;
  readonly knownFolders?: Partial<Record<SystemQuickKind, string>>;
  readonly trash?: (path: string) => Promise<void>;
}

export async function resolveSystemShellTarget(value: string) {
  const path = await realpath(normalizeSystemPath(value));
  const info = await lstat(path);
  if (!info.isDirectory() && !info.isFile()) throw new Error("此路径不是文件或目录");
  return { path, kind: info.isDirectory() ? "dir" as const : "file" as const };
}

export function createSystemFileService({ registry, knownFolders, trash }: SystemFileServiceOptions): HostSystemFileService {
  const platform = process.platform as SystemPlaces["platform"];
  const hidden = (name: string) => name.startsWith(".") || platform === "win32" && WINDOWS_HIDDEN.has(name.toLowerCase());

  async function fileTarget(input: SystemFileTarget, writing = false) {
    const requested = normalizeSystemPath(input.path);
    if (writing && (await lstat(requested)).isSymbolicLink()) throw new Error("不能写入符号链接文件");
    const target = await realpath(requested);
    if (!(await lstat(target)).isFile()) throw new Error("此路径不是文件");
    return target;
  }
  const inspect = async (input: SystemFileTarget) => {
    const path = normalizeSystemPath(input.path), file = await inspectFile(await fileTarget(input));
    return { ...file, path, writable: file.writable && !(await lstat(path)).isSymbolicLink() };
  };

  async function volume(path: string): Promise<SystemPlaces["volumes"][number] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const label = platform === "win32" ? path.slice(0, 2) : path === "/" ? "/" : basename(path);
    try {
      const info = await Promise.race([statfs(path), new Promise<undefined>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(undefined), 400); })]);
      return info ? { path, label, totalBytes: info.blocks * info.bsize, freeBytes: info.bavail * info.bsize, ready: true } : { path, label, ready: false };
    } catch (error) {
      return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? undefined : { path, label, ready: false };
    } finally { clearTimeout(timer); }
  }
  async function mountFolders(parent: string) {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    return entries.filter(entry => entry.isDirectory()).map(entry => join(parent, entry.name));
  }
  async function places(): Promise<SystemPlaces> {
    const home = homedir();
    const quick = (await Promise.all((["home", "desktop", "downloads", "documents", "pictures"] as const).map(async kind => {
      const label = kind[0]!.toUpperCase() + kind.slice(1);
      const path = knownFolders?.[kind] ?? (kind === "home" ? home : join(home, label));
      return await stat(path).then(info => info.isDirectory() ? { kind, label, path } : undefined, () => undefined);
    }))).filter(item => item !== undefined);
    const paths = platform === "win32" ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
      : platform === "darwin" ? ["/", "/Applications", ...await mountFolders("/Volumes")]
      : ["/", ...await mountFolders("/mnt"), ...await mountFolders(join("/media", userInfo().username))];
    const volumes = (await Promise.all(paths.map(volume))).filter(item => item !== undefined);
    return { platform, separator: platform === "win32" ? "\\" : "/", home, quick, volumes, trash: !!trash };
  }

  async function directoryPath(input: SystemListInput): Promise<string> {
    if (input.workspaceId !== undefined) {
      const workspace = registry.get(input.workspaceId);
      if (!workspace) throw new Error("unknown workspace id");
      const root = await realpath(workspace.canonicalPath);
      const requested = input.path ?? "";
      if (requested.includes("\0") || isAbsolute(requested)) throw new Error("workspace file path must be relative");
      const candidate = resolve(root, requested);
      if (!inside(root, candidate)) throw new Error("workspace file path escapes the workspace");
      const target = await realpath(candidate);
      if (!inside(root, target)) throw new Error("workspace file path escapes the workspace");
      return target;
    }
    return realpath(normalizeSystemPath(input.path));
  }

  async function workspaceFor(path: string): Promise<SystemDirectory["workspace"]> {
    const roots = await Promise.all(registry.list().map(async workspace => ({ workspace, root: await realpath(workspace.canonicalPath).catch(() => workspace.canonicalPath) })));
    const match = roots.filter(item => inside(item.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
    return match ? { workspaceId: match.workspace.workspaceId as WorkspaceId, relativePath: relative(match.root, path).split(sep).join("/") } : undefined;
  }

  async function list(input: SystemListInput): Promise<SystemDirectory> {
    const path = await directoryPath(input);
    const pending = [];
    let truncated = false;
    for await (const entry of await opendir(path)) {
      if (!input.showHidden && hidden(entry.name)) continue;
      if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (pending.length === DIRECTORY_LIMIT) { truncated = true; break; }
      pending.push(entry);
    }
    const entries: SystemEntry[] = [];
    for (let start = 0; start < pending.length; start += 32) {
      const batch = await Promise.all(pending.slice(start, start + 32).map(async (entry): Promise<SystemEntry | undefined> => {
        const target = join(path, entry.name);
        const base = { path: target, name: entry.name, hidden: hidden(entry.name) };
        try {
          const linkInfo = await lstat(target), link = linkInfo.isSymbolicLink();
          const info = link ? await stat(target) : linkInfo;
          if (!info.isFile() && !info.isDirectory()) return undefined;
          return { ...base, type: info.isDirectory() ? "dir" : "file", link, size: info.size, mtimeMs: info.mtimeMs };
        } catch (error) {
          if (errorCode(error) === "ENOENT" && !entry.isSymbolicLink()) return undefined;
          if (!["EACCES", "EPERM", "ENOENT", "ELOOP"].includes(errorCode(error) ?? "")) throw error;
          return { ...base, type: entry.isDirectory() ? "dir" : "file", link: entry.isSymbolicLink(), denied: true };
        }
      }));
      entries.push(...batch.filter(item => item !== undefined));
    }
    entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const segments = [];
    for (let current = path; ; current = dirname(current)) {
      segments.unshift({ path: current, label: basename(current) || current });
      if (dirname(current) === current) break;
    }
    const workspace = await workspaceFor(path);
    return { path, parent: dirname(path) === path ? null : dirname(path), segments, entries, truncated, ...(workspace ? { workspace } : {}) };
  }

  async function mutableEntry(value: string): Promise<string> {
    const target = normalizeSystemPath(value);
    if (dirname(target) === target) throw new Error("不能修改磁盘或卷的根目录");
    // Resolve the parent, leaving the entry itself intact: rename/trash act on a link, never its target.
    const path = join(await realpath(dirname(target)), basename(target));
    const info = await lstat(path);
    if (info.isDirectory() && info.dev !== (await stat(dirname(path))).dev) throw new Error("不能修改磁盘或卷的根目录");
    return path;
  }
  return {
    places, list, inspect,
    async readText(input) { return readFileText(await fileTarget(input), () => inspect(input)); },
    async readChunk(input) { return readFileChunk(await fileTarget(input), input); },
    async writeText(input) { return writeFileText(await fileTarget(input, true), input, () => inspect(input)); },
    async createDirectory(input) {
      const name = entryName(input.name), parent = await realpath(normalizeSystemPath(input.parent));
      const path = join(parent, name);
      await mkdir(path);
      return { path };
    },
    async rename(input) {
      const name = entryName(input.name), source = await mutableEntry(input.path), path = join(dirname(source), name);
      if (source !== path) await renameWithoutOverwrite(source, path);
      return { path };
    },
    ...(trash ? { async trash(input: { readonly paths: readonly string[] }) {
      const paths = await Promise.all(input.paths.map(mutableEntry));
      for (const path of paths) await trash(path);
      return { paths };
    } } : {}),
  };
}
