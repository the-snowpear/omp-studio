import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  SessionHistoryEntry,
  SessionId,
  SessionHistoryReadModel,
  StudioClient,
  WorkspaceId,
} from "@omp-studio/client-contract";
import { invalidateProjectHistoryReads } from "../conversationWorkspace/projectReads";

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

export function withoutDeletedSessions(model: SessionHistoryReadModel, deleted: ReadonlySet<string>): SessionHistoryReadModel {
  const entries = model.entries.filter(entry => !deleted.has(entry.historyId) && !deleted.has(entry.sessionId ?? ""));
  return entries.length === model.entries.length ? model : { entries, total: Math.max(0, model.total - (model.entries.length - entries.length)) };
}

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

export class ProjectHistoryStore {
  cache: ProjectHistoryCache = {};
  deletedSessions: ReadonlySet<string> = new Set();
  requests: Record<string, number> = {};
  epoch = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.cache;
  setCache = (action: ProjectHistoryCache | ((previous: ProjectHistoryCache) => ProjectHistoryCache)) => {
    const next = typeof action === "function" ? action(this.cache) : action;
    if (next === this.cache) return;
    this.cache = next;
    for (const listener of this.listeners) listener();
  };
  applySessionTitle = (sessionId: SessionId, title: string): void => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    this.setCache((previous) => {
      let next: Record<string, ProjectHistoryState> | undefined;
      for (const [workspaceKey, state] of Object.entries(previous)) {
        const entries = state.model?.entries;
        if (!entries) continue;
        let changed = false;
        const nextEntries = entries.map((entry) => {
          if (entry.sessionId !== sessionId || entry.title === trimmed) return entry;
          changed = true;
          return { ...entry, title: trimmed };
        });
        if (!changed) continue;
        next ??= { ...previous };
        next[workspaceKey] = {
          ...state,
          model: { ...state.model!, entries: nextEntries },
        };
      }
      return next ?? previous;
    });
  };
  removeSessions = (entries: readonly SessionHistoryEntry[]): void => {
    const deleted = new Set(this.deletedSessions);
    for (const entry of entries) {
      deleted.add(entry.historyId);
      if (entry.sessionId) deleted.add(entry.sessionId);
    }
    this.deletedSessions = deleted;
    this.setCache(previous => Object.fromEntries(Object.entries(previous).map(([key, state]) => [
      key, state.model ? { ...state, model: withoutDeletedSessions(state.model, deleted) } : state,
    ])));
  };
}

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
  shared,
}: {
  readonly client: HistoryClient;
  readonly preview: boolean;
  readonly shared?: ProjectHistoryStore | undefined;
}): {
  readonly cache: ProjectHistoryCache;
  readonly load: (workspaceId: WorkspaceId, limit?: number) => Promise<SessionHistoryReadModel | undefined>;
  readonly refresh: (workspaceId: WorkspaceId) => Promise<SessionHistoryReadModel | undefined>;
  readonly loadMore: (workspaceId: WorkspaceId) => Promise<SessionHistoryReadModel | undefined>;
  readonly applySessionTitle: (sessionId: SessionId, title: string) => void;
  readonly deletedSessions: ReadonlySet<string>;
  readonly removeSessions: (entries: readonly SessionHistoryEntry[]) => void;
  readonly clear: (workspaceId?: WorkspaceId) => void;
} {
  const [own] = useState(() => new ProjectHistoryStore());
  const store = shared ?? own;
  const cache = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const setCache = store.setCache;
  const cacheRef = useMemo(() => ({ get current() { return store.cache; }, set current(value: ProjectHistoryCache) { store.cache = value; } }), [store]);
  const requestRef = useMemo(() => ({ get current() { return store.requests; }, set current(value: Record<string, number>) { store.requests = value; } }), [store]);
  const previousPreviewRef = useRef(preview);

  useEffect(() => {
    if (previousPreviewRef.current === preview) return;
    previousPreviewRef.current = preview;
    store.epoch += 1;
    cacheRef.current = {};
    requestRef.current = {};
    setCache({});
  }, [preview, store]);

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
    if (force) {
      invalidateProjectHistoryReads(client as Pick<StudioClient, "query" | "subscribe">, workspaceId);
    }
    const requestEpoch = store.epoch;
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
      const result = await client.query("history.list", {
        workspaceId,
        limit,
        status: "active",
      });
      if (store.epoch !== requestEpoch || requestRef.current[key] !== requestId) return undefined;
      const model = withoutDeletedSessions(result, store.deletedSessions);
      setCache((previous) => ({
        ...previous,
        [key]: { status: "ready", requestedLimit: limit, model },
      }));
      return model;
    } catch (cause) {
      if (store.epoch !== requestEpoch || requestRef.current[key] !== requestId) return undefined;
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
  }, [client, preview, store]);

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
      store.epoch += 1;
      cacheRef.current = {};
      requestRef.current = {};
      setCache({});
      return;
    }
    const key = String(workspaceId);
    requestRef.current = { ...requestRef.current, [key]: (requestRef.current[key] ?? 0) + 1 };
    const next = { ...cacheRef.current };
    delete next[key];
    cacheRef.current = next;
    setCache(next);
  }, [store]);

  return { cache, load, refresh, loadMore, applySessionTitle: store.applySessionTitle, deletedSessions: store.deletedSessions, removeSessions: store.removeSessions, clear };
}
