import type { JsonValue } from "@omp-studio/client-contract";
import { jsonRecord, jsonString, type ToolView } from "./conversationViewModel";
import { toolKind } from "./toolMeta";

export type ExplorerFileActivity = {
  readonly reading: readonly string[];
  readonly writing: readonly string[];
};

export const EMPTY_EXPLORER_FILE_ACTIVITY: ExplorerFileActivity = { reading: [], writing: [] };

export type ExplorerLiveTool = {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly status: "started" | "updated" | "completed" | "failed";
  readonly arguments?: JsonValue;
};

const READ_KINDS = new Set(["read", "inspect_image"]);
const WRITE_KINDS = new Set(["write", "edit", "ast_edit"]);

function isInFlight(status: ExplorerLiveTool["status"]): boolean {
  return status === "started" || status === "updated";
}

function asToolView(tool: ExplorerLiveTool): ToolView {
  return {
    toolCallId: tool.toolCallId,
    toolName: tool.toolName ?? "tool",
    status: "running",
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
  };
}

function normalizePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").trim();
  if (!normalized || normalized.includes(" → ")) return undefined;
  return normalized;
}

function pushPath(into: string[], value: string | undefined): void {
  if (value === undefined) return;
  const next = normalizePath(value);
  if (next !== undefined) into.push(next);
}

function collectToolPaths(args: { readonly [key: string]: JsonValue } | undefined, kind: string): string[] {
  const paths: string[] = [];
  if (args === undefined) return paths;
  pushPath(paths, jsonString(args.path));
  pushPath(paths, jsonString(args.resolvedPath));
  pushPath(paths, jsonString(args.target));
  if (kind === "ast_edit" && Array.isArray(args.changes)) {
    for (const entry of args.changes) {
      pushPath(paths, jsonString(jsonRecord(entry)?.file));
    }
  }
  return paths;
}

/** In-flight Read/Write paths from the main session live tool map. */
export function deriveExplorerFileActivity(
  liveTools: Readonly<Record<string, ExplorerLiveTool>>,
): ExplorerFileActivity {
  const reading: string[] = [];
  const writing: string[] = [];
  for (const tool of Object.values(liveTools)) {
    if (tool === undefined || !isInFlight(tool.status)) continue;
    const kind = toolKind(asToolView(tool));
    const paths = collectToolPaths(jsonRecord(tool.arguments), kind);
    if (paths.length === 0) continue;
    if (READ_KINDS.has(kind)) reading.push(...paths);
    else if (WRITE_KINDS.has(kind)) writing.push(...paths);
  }
  return {
    reading: reading.length === 0 ? EMPTY_EXPLORER_FILE_ACTIVITY.reading : reading,
    writing: writing.length === 0 ? EMPTY_EXPLORER_FILE_ACTIVITY.writing : writing,
  };
}

export function fileActivityMatches(
  treePath: string,
  activityPaths: readonly string[],
  isDir: boolean,
): boolean {
  const tree = normalizePath(treePath);
  if (tree === undefined || activityPaths.length === 0) return false;
  for (const raw of activityPaths) {
    const path = normalizePath(raw);
    if (path === undefined) continue;
    if (path === tree || path.endsWith(`/${tree}`)) return true;
    if (isDir && (path.startsWith(`${tree}/`) || path.includes(`/${tree}/`))) return true;
  }
  return false;
}

export function explorerRowActivity(
  treePath: string,
  isDir: boolean,
  activity: ExplorerFileActivity,
): { readonly reading: boolean; readonly writing: boolean } {
  return {
    reading: fileActivityMatches(treePath, activity.reading, isDir),
    writing: fileActivityMatches(treePath, activity.writing, isDir),
  };
}
