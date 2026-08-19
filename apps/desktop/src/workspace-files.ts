import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type {
  WorkspaceFileMutationResult,
  WorkspaceFileNode,
  WorkspaceFileTreeReadModel,
  WorkspaceId,
} from "@omp-studio/client-contract";
import type { HostWorkspaceFileService } from "@omp-studio/host-client-api";
import type { WorkspaceRegistry } from "@omp-studio/studio-host";

const MAX_DIRECTORY_ENTRIES = 5_000;
const IGNORED = new Set([".git", "node_modules"]);

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

function escapedFrom(root: string, canonical: string): boolean {
  const escaped = relative(root, canonical);
  return escaped === ".." || escaped.startsWith(`..${sep}`);
}

async function assertMutableTarget(root: string, path: string): Promise<string> {
  const target = resolveInside(root, path);
  const parent = await realpath(dirname(target));
  if (escapedFrom(root, parent)) throw new Error("workspace file path escapes the workspace");
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

  async function directory(root: string, requestedPath?: string): Promise<WorkspaceFileNode[]> {
    const prefix = requestedPath === undefined ? "" : normalizeRelativePath(requestedPath);
    const target = prefix ? resolveInside(root, prefix) : root;
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("workspace file tree path must be a real directory");
    const canonical = await realpath(target);
    const escaped = relative(root, canonical);
    if (escaped === ".." || escaped.startsWith(`..${sep}`)) throw new Error("workspace file tree path escapes the workspace");
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
