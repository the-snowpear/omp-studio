import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionId,
  SessionHistoryReadModel,
  StudioClient,
  WorkspaceId,
} from "@omp-studio/client-contract";

export const PROJECT_HISTORY_INITIAL_LIMIT = 6;
export const PROJECT_HISTORY_PAGE_SIZE = 10;
export const PROJECT_HISTORY_QUERY_MAX = 200;

export type ProjectHistoryState = {
  readonly status: "loading" | "ready" | "error";
  readonly requestedLimit: number;
  readonly model?: SessionHistoryReadModel;
  readonly error?: string;
};

export type ProjectHistoryCache = Readonly<Record<string, ProjectHistoryState>>;

/** Stable effect key for the first streaming snapshot of one project/session.
 * Unrelated token snapshots keep the same key, so they cannot retrigger the
 * project history query until streaming stops and a later turn starts. */
export function streamingProjectHistoryRefreshKey(input: {
  readonly preview: boolean;
  readonly isStreaming: boolean | undefined;
  readonly sessionId: SessionId | undefined;
  readonly workspaceId: WorkspaceId | undefined;
}): string | undefined {
  if (input.preview || input.isStreaming !== true || input.sessionId === undefined || input.workspaceId === undefined) {
    return undefined;
  }
  return JSON.stringify([input.workspaceId, input.sessionId]);
}

export function projectHistoryOf(
  cache: ProjectHistoryCache,
  workspaceId: string,
): ProjectHistoryState | undefined {
  return cache[workspaceId];
}

export function projectHistoryEntries(
  cache: ProjectHistoryCache,
  workspaceId: string,
): ReadonlyArray<SessionHistoryReadModel["entries"][number]> {
  return cache[workspaceId]?.model?.entries ?? [];
}

type HistoryClient = Pick<StudioClient, "query">;

/**
 * Per-workspace active-history cache for the sidebar.
 *
 * A project is queried only when its row is expanded. Each request updates
 * only its own cache key, so expanding A and B concurrently cannot replace
 * either project's rows with the other's result. Preview callers never query
 * Host; the fixture branch remains entirely in AppSidebar.
 */
export function useProjectHistories({
  client,
  preview,
}: {
  readonly client: HistoryClient;
  readonly preview: boolean;
}): {
  readonly cache: ProjectHistoryCache;
  readonly load: (workspaceId: WorkspaceId, limit?: number) => Promise<SessionHistoryReadModel | undefined>;
  readonly refresh: (workspaceId: WorkspaceId) => Promise<SessionHistoryReadModel | undefined>;
  readonly loadMore: (workspaceId: WorkspaceId) => Promise<SessionHistoryReadModel | undefined>;
  readonly clear: (workspaceId?: WorkspaceId) => void;
} {
  const [cache, setCache] = useState<ProjectHistoryCache>({});
  const cacheRef = useRef<ProjectHistoryCache>({});
  const requestRef = useRef<Record<string, number>>({});
  const previousPreviewRef = useRef(preview);
  cacheRef.current = cache;

  useEffect(() => {
    if (previousPreviewRef.current === preview) return;
    previousPreviewRef.current = preview;
    cacheRef.current = {};
    requestRef.current = {};
    setCache({});
  }, [preview]);

  const load = useCallback(async (
    workspaceId: WorkspaceId,
    requestedLimit = PROJECT_HISTORY_INITIAL_LIMIT,
    force = false,
  ) => {
    if (preview) return undefined;
    const key = String(workspaceId);
    const limit = Math.min(PROJECT_HISTORY_QUERY_MAX, Math.max(1, Math.floor(requestedLimit)));
    const current = cacheRef.current[key];
    if (!force && current?.status === "ready" && current.requestedLimit >= limit && current.model !== undefined) {
      return current.model;
    }
    const requestId = (requestRef.current[key] ?? 0) + 1;
    requestRef.current = { ...requestRef.current, [key]: requestId };
    setCache((previous) => ({
      ...previous,
      [key]: {
        status: "loading",
        requestedLimit: limit,
        ...(previous[key]?.model === undefined ? {} : { model: previous[key].model }),
      },
    }));
    try {
      const model = await client.query("history.list", {
        workspaceId,
        limit,
        status: "active",
      });
      if (requestRef.current[key] !== requestId) return undefined;
      setCache((previous) => ({
        ...previous,
        [key]: { status: "ready", requestedLimit: limit, model },
      }));
      return model;
    } catch (cause) {
      if (requestRef.current[key] !== requestId) return undefined;
      const error = cause instanceof Error && cause.message ? cause.message : "history.list failed";
      setCache((previous) => ({
        ...previous,
        [key]: {
          status: "error",
          requestedLimit: limit,
          ...(previous[key]?.model === undefined ? {} : { model: previous[key].model }),
          error,
        },
      }));
      return undefined;
    }
  }, [client, preview]);

  const refresh = useCallback(async (workspaceId: WorkspaceId) => {
    if (preview) return undefined;
    const current = cacheRef.current[String(workspaceId)];
    return await load(workspaceId, current?.requestedLimit ?? PROJECT_HISTORY_INITIAL_LIMIT, true);
  }, [load, preview]);

  const loadMore = useCallback(async (workspaceId: WorkspaceId) => {
    if (preview) return undefined;
    const current = cacheRef.current[String(workspaceId)];
    const next = (current?.requestedLimit ?? PROJECT_HISTORY_INITIAL_LIMIT) + PROJECT_HISTORY_PAGE_SIZE;
    return await load(workspaceId, next);
  }, [load, preview]);

  const clear = useCallback((workspaceId?: WorkspaceId) => {
    if (workspaceId === undefined) {
      cacheRef.current = {};
      requestRef.current = {};
      setCache({});
      return;
    }
    const key = String(workspaceId);
    const next = { ...cacheRef.current };
    delete next[key];
    cacheRef.current = next;
    setCache(next);
  }, []);

  return { cache, load, refresh, loadMore, clear };
}
