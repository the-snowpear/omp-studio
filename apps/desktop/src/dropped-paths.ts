/**
 * Map OS paths from a renderer drop/paste onto `@mention` capsules.
 *
 * Paths under the workspace root become workspace-relative; anything else on
 * the machine keeps its canonical absolute path. The Runtime accepts both —
 * `resolveToCwd` honours an absolute mention and resolves a relative one
 * against the session cwd — so a drop from the Desktop or another drive is a
 * capsule like any other.
 */

import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { DroppedPathKind, DroppedPathScope, ResolvedDroppedPath } from "./workspace-shell-shared.js";

export type { DroppedPathKind, DroppedPathScope, ResolvedDroppedPath } from "./workspace-shell-shared.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".svgz"]);

function extnameLower(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function toForward(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Workspace-relative path, or `null` when the target sits outside the root.
 * On Windows `relative()` across drives yields an absolute path rather than a
 * `..` prefix, so both shapes count as outside.
 */
function insideWorkspace(root: string, canonical: string): string | null {
  const escaped = relative(root, canonical);
  if (escaped === "..") return null;
  if (escaped.startsWith(`..${sep}`) || escaped.startsWith("../")) return null;
  if (isAbsolute(escaped)) return null;
  return escaped === "" ? "." : toForward(escaped);
}

export async function resolveDroppedPath(cwd: string, absolutePath: string): Promise<ResolvedDroppedPath> {
  if (typeof absolutePath !== "string" || absolutePath.length === 0 || absolutePath.length > 4_096) {
    return { ok: false, reason: "invalid" };
  }
  const root = resolve(cwd);
  const resolved = resolve(absolutePath);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (metadata.isSymbolicLink()) return { ok: false, reason: "invalid" };
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const inside = insideWorkspace(root, canonical);
  const scope: DroppedPathScope = inside === null ? "absolute" : "workspace";
  const path = inside ?? toForward(canonical);
  const name = basename(canonical);
  if (metadata.isDirectory()) {
    return { ok: true, kind: "dir", scope, path, name: name || path };
  }
  if (!metadata.isFile()) return { ok: false, reason: "invalid" };
  const kind: DroppedPathKind = IMAGE_EXTENSIONS.has(extnameLower(name)) ? "image" : "file";
  return { ok: true, kind, scope, path, name };
}

export async function resolveDroppedPaths(cwd: string, paths: readonly string[]): Promise<ResolvedDroppedPath[]> {
  const out: ResolvedDroppedPath[] = [];
  for (const path of paths) out.push(await resolveDroppedPath(cwd, path));
  return out;
}
