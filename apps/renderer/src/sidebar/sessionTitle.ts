import type { SessionId, WorkspaceId } from "@omp-studio/client-contract";
import type { ProjectHistoryCache } from "./useProjectHistories";

/**
 * Resolve the workspace that owns a session mutation.  Resident identity is
 * authoritative for the live session; cache membership handles a selected
 * history row; the selected/active project values are only fallbacks.
 */
export function workspaceForSession(input: {
  readonly sessionId?: SessionId;
  readonly residentWorkspaceId?: WorkspaceId;
  readonly projectHistoryCache: ProjectHistoryCache;
  readonly selectedWorkspaceId?: WorkspaceId;
  readonly activeWorkspaceId?: WorkspaceId;
}): WorkspaceId | undefined {
  if (input.residentWorkspaceId !== undefined) return input.residentWorkspaceId;
  if (input.sessionId !== undefined) {
    for (const [workspaceId, history] of Object.entries(input.projectHistoryCache)) {
      if (history.model?.entries.some((entry) => entry.sessionId === input.sessionId)) {
        return workspaceId as WorkspaceId;
      }
    }
  }
  return input.selectedWorkspaceId ?? input.activeWorkspaceId;
}

/** A history row is only a view until its Runtime is selected. Mutations must
 * resume that viewed session instead of falling through to another live one. */
export function renameNeedsSessionResume(input: {
  readonly hasViewedHistory: boolean;
  readonly viewedSessionId?: SessionId;
  readonly liveSessionId?: SessionId;
}): boolean {
  return input.hasViewedHistory
    && (input.viewedSessionId === undefined || input.viewedSessionId !== input.liveSessionId);
}
