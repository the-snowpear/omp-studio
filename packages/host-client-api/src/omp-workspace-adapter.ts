/**
 * OMP workspace adapter: thin sanitizing seam over the Host-owned
 * {@link WorkspaceRegistry}.
 *
 * The registry is the only place workspace paths are resolved. This adapter
 * maps stored records to `WorkspaceListReadModel`: `workspaceId / name /
 * lastOpenedAt / active` plus `root` — the canonical folder the operator
 * picked, published for display only (the workbench shows it as the project
 * address). Nothing in the Host ever reads that field back: every file, tree
 * and mutation path stays workspace-relative and is resolved here.
 *
 * `pickDirectory` is injected (the Desktop composition root supplies the
 * Electron dialog); returning `undefined` means the user cancelled and the
 * adapter throws a code-carrying error the facade maps to a non-completed
 * receipt.
 */

import type { WorkspaceId, WorkspaceListReadModel, WorkspaceRecord } from "@omp-studio/client-contract";
import type { StoredWorkspace, WorkspaceRegistry } from "@omp-studio/studio-host";

import { sanitizeDisplayText } from "./read-models.js";
import type { HostWorkspaceService } from "./services.js";

/** Thrown when the user cancels the directory picker. */
export class WorkspacePickCancelledError extends Error {
  readonly code = "UNAVAILABLE" as const;

  constructor() {
    super("directory picker cancelled");
    this.name = "WorkspacePickCancelledError";
  }
}

export interface OmpWorkspaceAdapterOptions {
  readonly registry: WorkspaceRegistry;
  /** Open the system directory picker; `undefined` = user cancelled. */
  readonly pickDirectory: () => Promise<string | undefined>;
  /** Desktop uses this to restart the Runtime under the new workspace cwd. */
  readonly onActivated?: (workspace: StoredWorkspace) => Promise<void>;
  readonly now?: () => string;
}

const NAME_MAX = 80;

/** Map a stored record to its public row (`root` is display-only, see the header). */
function toRecord(stored: StoredWorkspace, activeId: string | undefined): WorkspaceRecord {
  const name = sanitizeDisplayText(stored.name, NAME_MAX) ?? "Untitled project";
  return {
    workspaceId: stored.workspaceId as WorkspaceId,
    name,
    root: stored.canonicalPath,
    lastOpenedAt: stored.lastOpenedAt,
    active: stored.workspaceId === activeId,
  };
}

function toModel(registry: WorkspaceRegistry): WorkspaceListReadModel {
  const activeId = registry.activeWorkspaceId;
  return {
    workspaces: registry.list().map((entry) => toRecord(entry, activeId)),
    ...(activeId === undefined ? {} : { activeWorkspaceId: activeId as WorkspaceId }),
  };
}

export function createOmpWorkspaceService(options: OmpWorkspaceAdapterOptions): HostWorkspaceService {
  const now = options.now ?? (() => new Date().toISOString());
  const activate = async (stored: StoredWorkspace): Promise<void> => {
    if (options.onActivated === undefined) return;
    await options.onActivated(stored);
  };

  return {
    list(): WorkspaceListReadModel {
      return toModel(options.registry);
    },

    async open(input: { readonly workspaceId: WorkspaceId }): Promise<WorkspaceListReadModel> {
      // Re-opening the already-active workspace just refreshes the
      // timestamp; it must not restart the Runtime (the desktop wires
      // onActivated to a stop+start rebind).
      const wasActive = options.registry.activeWorkspaceId === input.workspaceId;
      const stored = await options.registry.touch(input.workspaceId, now());
      if (!wasActive) {
        await activate(stored);
      }
      return toModel(options.registry);
    },

    async pick(input?: { readonly name?: string }): Promise<WorkspaceListReadModel> {
      const dir = await options.pickDirectory();
      if (dir === undefined) {
        throw new WorkspacePickCancelledError();
      }
      const displayName = input?.name === undefined ? undefined : sanitizeDisplayText(input.name, NAME_MAX);
      const stored = await options.registry.upsertByPath(dir, now(), displayName);
      await activate(stored);
      return toModel(options.registry);
    },
  };
}
