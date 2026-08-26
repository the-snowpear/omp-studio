/**
 * Desktop-chrome workspace shell IPC contract.
 *
 * Shared by Main and the sandboxed preload. No Electron Main APIs — preload
 * may import this file. This is not a Host / Studio Bridge surface: the
 * Renderer sends only an opaque workspaceId and Main resolves the canonical
 * path inside the Host-owned workspace registry.
 */

export const WORKSPACE_SHELL_IPC_CHANNELS = {
  openInEditor: "omp-studio:desktop:workspace-open-in-editor",
  revealInFileManager: "omp-studio:desktop:workspace-reveal-in-file-manager",
  resolveDroppedPaths: "omp-studio:desktop:workspace-resolve-dropped-paths",
  pickPlanSavePath: "omp-studio:desktop:workspace-pick-plan-save-path",
} as const;

/** Opaque workspace ids are Host-generated base64url tokens (or test ids). */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface WorkspaceShellInput {
  readonly workspaceId: string;
}

/**
 * Result of the external-editor action. `cancelled` means the user closed
 * the system picker without choosing an app; it is not an error.
 */
export type WorkspaceShellEditorResult =
  | { readonly status: "opened"; readonly editorName?: string }
  | { readonly status: "cancelled" };

/**
 * Result of the plan save-as picker (native dialog in Main). `picked`
 * carries a workspace-relative path with forward slashes, ready for the
 * Studio Bridge `mode.plan.review.saveAndQuit` command; `outside-workspace`
 * means the operator chose a location outside the Host workspace root.
 */
export type PlanSavePathPickResult =
  | { readonly status: "picked"; readonly relativePath: string }
  | { readonly status: "cancelled" }
  | { readonly status: "outside-workspace"; readonly fileName: string };

export class WorkspaceShellIpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceShellIpcError";
  }
}

function assertPlainObject(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceShellIpcError(`${what}: expected an object`);
  }
}

export function parseWorkspaceShellInput(value: unknown): WorkspaceShellInput {
  assertPlainObject(value, "workspace shell");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "workspaceId") {
      throw new WorkspaceShellIpcError(`workspace shell: unexpected field ${key}`);
    }
  }
  if (typeof input.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(input.workspaceId)) {
    throw new WorkspaceShellIpcError("workspace shell: workspaceId must be an opaque 1–128 character token");
  }
  return { workspaceId: input.workspaceId };
}

const MAX_DROPPED_PATHS = 32;
const MAX_DROPPED_PATH_CHARS = 4_096;

export type DroppedPathKind = "file" | "dir" | "image";

/**
 * `workspace` — `path` is relative to the workspace root.
 * `absolute` — the drop came from elsewhere on the machine and `path` is the
 * canonical absolute path. Both are accepted: the Runtime resolves an absolute
 * `@mention` as-is and a relative one against the session cwd.
 */
export type DroppedPathScope = "workspace" | "absolute";

export type ResolvedDroppedPath =
  | {
      readonly ok: true;
      readonly kind: DroppedPathKind;
      readonly scope: DroppedPathScope;
      readonly path: string;
      readonly name: string;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "invalid";
    };

export interface ResolveDroppedPathsInput {
  readonly workspaceId: string;
  readonly paths: readonly string[];
}

export function parseResolveDroppedPathsInput(value: unknown): ResolveDroppedPathsInput {
  assertPlainObject(value, "workspace dropped paths");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "workspaceId" && key !== "paths") {
      throw new WorkspaceShellIpcError(`workspace dropped paths: unexpected field ${key}`);
    }
  }
  if (typeof input.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(input.workspaceId)) {
    throw new WorkspaceShellIpcError("workspace dropped paths: workspaceId must be an opaque 1–128 character token");
  }
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_DROPPED_PATHS) {
    throw new WorkspaceShellIpcError(`workspace dropped paths: paths must be a non-empty array of at most ${MAX_DROPPED_PATHS}`);
  }
  const paths: string[] = [];
  for (const path of input.paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > MAX_DROPPED_PATH_CHARS) {
      throw new WorkspaceShellIpcError("workspace dropped paths: each path must be a non-empty string");
    }
    paths.push(path);
  }
  return { workspaceId: input.workspaceId, paths };
}
