import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  WorkspaceFileMutationResult,
  WorkspaceFileNode,
  WorkspaceFileTreeReadModel,
  WorkspaceId,
  WorkspaceFileInfo, WorkspaceFileTarget,
  WorkspacePathResolveInput, WorkspacePathResolution,
} from "@omp-studio/client-contract";
import type { HostWorkspaceFileService } from "@omp-studio/host-client-api";
import type { WorkspaceRegistry } from "@omp-studio/studio-host";
import { desktopText } from "./desktop-language-shared.js";

const MAX_DIRECTORY_ENTRIES = 5_000;
const IGNORED = new Set([".git", "node_modules"]);
export { FILE_CHUNK_BYTES, EDITABLE_FILE_BYTES, fileMime as workspaceFileMime } from "./file-io.js";
import { inspectFile, readFileText, readFileChunk, writeFileText } from "./file-io.js";

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("workspace file path must be relative");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("workspace file path escapes the workspace");
  }
  return parts.join("/");
}

function resolveInside(root: string, path: string): string {
  const target = resolve(root, ...path.split("/"));
  const escaped = relative(root, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`)) throw new Error("workspace file path escapes the workspace");
  return target;
}

/**
 * `realRoot` must itself be a realpath: the stored root is standardized
 * (macOS drops `/private` from `/var`, `/tmp`, `/etc`), realpath is not.
 */
function escapedFrom(realRoot: string, canonical: string): boolean {
  const escaped = relative(realRoot, canonical);
  return isAbsolute(escaped) || escaped === ".." || escaped.startsWith(`..${sep}`);
}

async function assertMutableTarget(root: string, path: string): Promise<string> {
  const target = resolveInside(root, path);
  const parent = await realpath(dirname(target));
  if (escapedFrom(await realpath(root), parent)) throw new Error("workspace file path escapes the workspace");
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("workspace file path escapes the workspace");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export function createWorkspaceFileService({ registry }: { readonly registry: WorkspaceRegistry }): HostWorkspaceFileService {
  const storedRoot = (workspaceId: WorkspaceId): string => {
    const workspace = registry.get(workspaceId);
    if (workspace === undefined) throw new Error("unknown workspace id");
    return workspace.canonicalPath;
  };

  /** Markdown links may use `/C:/...` as well as `C:\...` on Windows. */
  function candidatePath(root: string, requested: string): string {
    let path = requested;
    if (/^file:/i.test(path)) path = fileURLToPath(path);
    if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    return isAbsolute(path) ? path : resolve(root, path);
  }

  /**
   * A missing path is an ordinary outcome for transcript probes, so a click
   * gets a readable message instead of a raw `fs` error string.
   */
  async function realTarget(candidate: string, requested: string): Promise<string> {
    try {
      return await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`${desktopText("路径不存在", "Path does not exist")}: ${requested}`);
      throw error;
    }
  }

  async function targetFor(input: WorkspaceFileTarget, writing = false): Promise<{ target: string; path: string }> {
    const root = await realpath(storedRoot(input.workspaceId));
    const candidate = candidatePath(root, input.path);
    if (writing && (await lstat(candidate)).isSymbolicLink()) throw new Error(desktopText("不能写入符号链接文件", "Cannot write through a symbolic link"));
    const target = await realTarget(candidate, input.path);
    if (escapedFrom(root, target)) throw new Error(desktopText("文件不在当前工作区内", "File is outside the current workspace"));
    if (!(await lstat(target)).isFile()) throw new Error(desktopText("此路径不是文件", "Path is not a file"));
    return { target, path: relative(root, target).split(sep).join("/") };
  }
  async function inspect(input: WorkspaceFileTarget): Promise<WorkspaceFileInfo> {
    const { target, path } = await targetFor(input);
    return { ...await inspectFile(target), workspaceId: input.workspaceId, path };
  }

  /** Classifies path-like transcript text; anything unclassifiable reports itself missing. */
  async function resolveAll(input: WorkspacePathResolveInput): Promise<readonly WorkspacePathResolution[]> {
    const root = await realpath(storedRoot(input.workspaceId));
    return Promise.all(input.paths.map(async path => {
      try {
        const target = await realTarget(candidatePath(root, path), path);
        if (escapedFrom(root, target)) return { path, kind: "missing" as const };
        return { path, kind: (await lstat(target)).isDirectory() ? "directory" as const : "file" as const };
      } catch {
        return { path, kind: "missing" as const };
      }
    }));
  }

  async function directory(root: string, requestedPath?: string): Promise<WorkspaceFileNode[]> {
    const prefix = requestedPath === undefined ? "" : normalizeRelativePath(requestedPath);
    const target = prefix ? resolveInside(root, prefix) : root;
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("workspace file tree path must be a real directory");
    const canonical = await realpath(target);
    if (escapedFrom(await realpath(root), canonical)) throw new Error("workspace file tree path escapes the workspace");
    const entries = await readdir(canonical, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const nodes: WorkspaceFileNode[] = [];
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
      if (nodes.length >= MAX_DIRECTORY_ENTRIES) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) nodes.push({ type: "dir", name: entry.name, path });
      else if (entry.isFile()) nodes.push({ type: "file", name: entry.name, path });
    }
    return nodes;
  }

  return {
    inspect,
    resolveAll,
    async writeText(input) {
      const { target } = await targetFor(input, true);
      return writeFileText(target, input, () => inspect(input));
    },
    async readText(input) {
      const { target } = await targetFor(input);
      return readFileText(target, () => inspect(input));
    },
    async readChunk(input) {
      const { target } = await targetFor(input);
      return readFileChunk(target, input);
    },
    async get(input): Promise<WorkspaceFileTreeReadModel> {
      return { workspaceId: input.workspaceId, nodes: await directory(storedRoot(input.workspaceId), input.path) };
    },
    async createFile(input): Promise<WorkspaceFileMutationResult> {
      const path = normalizeRelativePath(input.path);
      const root = storedRoot(input.workspaceId);
      const target = await assertMutableTarget(root, path);
      await writeFile(target, "", { encoding: "utf8", flag: "wx" });
      return { applied: true, kind: "file", path };
    },
    async createDirectory(input): Promise<WorkspaceFileMutationResult> {
      const path = normalizeRelativePath(input.path);
      const root = storedRoot(input.workspaceId);
      const target = await assertMutableTarget(root, path);
      await mkdir(target);
      return { applied: true, kind: "directory", path };
    },
  };
}
