import type { WorkspaceListReadModel, WorkspaceRecord } from "@omp-studio/client-contract";

/**
 * Sidebar project-tree order.
 *
 * `projects.list` arrives sorted by `lastOpenedAt` descending, which is the
 * right order for the home page's "recently opened" cards but wrong for a
 * navigation tree: opening a project refreshes its timestamp, so every switch
 * would reshuffle the rows under the pointer. The tree sorts by display name
 * instead — a key the act of switching never changes — with the opaque
 * workspace id as the tiebreaker so equal names still land in a fixed order.
 *
 * Returns a new array; the input model is never mutated.
 */
export function sidebarProjectOrder(
  model: WorkspaceListReadModel | undefined,
): ReadonlyArray<WorkspaceRecord> {
  if (model === undefined) return [];
  return [...model.workspaces].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.workspaceId.localeCompare(right.workspaceId),
  );
}
