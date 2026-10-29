import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { GitRepositoryReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { hostErrorMessage } from "../hostError";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";

type RepositorySnapshot = {
  readonly repository?: GitRepositoryReadModel;
  readonly loading: boolean;
  readonly error?: string;
};
type RepositoryHook = RepositorySnapshot & { readonly refresh: () => Promise<void> };
type RepositoryStore = {
  getSnapshot(): RepositorySnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  synchronize(revision: number): void;
};

const emptySnapshot: RepositorySnapshot = { loading: false };
const repositories = new WeakMap<StudioClient, Map<WorkspaceId, RepositoryStore>>();

function createRepositoryStore(client: StudioClient, workspaceId: WorkspaceId, release: () => void): RepositoryStore {
  let snapshot = emptySnapshot;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  let request: Promise<void> | undefined;
  let generation = 0;
  let reading = false;
  let dirty = false;
  let syncRevision: number | undefined;

  const publish = (next: RepositorySnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const read = (): Promise<void> => {
    if (request !== undefined) return request;
    // Install the shared promise before querying or notifying React. Multiple
    // consumers (including StrictMode's effect replay) join this same read.
    request = Promise.resolve().then(async () => {
      try {
        do {
          dirty = false;
          reading = true;
          const requestGeneration = generation;
          try {
            const repository = await client.query("git.repository.get", { workspaceId });
            if (requestGeneration === generation) publish({ repository, loading: false });
          } catch (cause) {
            if (requestGeneration === generation) publish({ loading: false, error: hostErrorMessage(cause, "无法读取 Git 仓库状态") });
          } finally {
            reading = false;
          }
          // A change notification only carries a revision, not a read model.
          // Discard the older read and fetch once more after it settles.
        } while (dirty && listeners.size > 0);
      } finally {
        request = undefined;
      }
    });
    publish({ ...snapshot, loading: true });
    return request;
  };
  const refresh = (): Promise<void> => {
    if (listeners.size === 0) return Promise.resolve();
    generation += 1;
    // Reads not yet started already include this refresh; running reads do not.
    if (reading) dirty = true;
    return read();
  };

  return {
    getSnapshot: () => snapshot,
    refresh,
    synchronize(revision) {
      const previous = syncRevision;
      syncRevision = revision;
      if (previous !== undefined && previous !== revision) void refresh();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (unsubscribe === undefined) {
        unsubscribe = client.subscribe({ scope: "all" }, event => {
          if (event.kind === "git.repository.changed" && event.repository.workspaceId === workspaceId) void refresh();
        });
        void read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        // React can render a replacement consumer before running its effect,
        // or replay effects in StrictMode. Keep the entry for that microtask,
        // then release the subscription, snapshot and pending read ownership.
        queueMicrotask(() => {
          if (listeners.size > 0 || unsubscribe === undefined) return;
          generation += 1;
          dirty = false;
          unsubscribe();
          unsubscribe = undefined;
          release();
        });
      };
    },
  };
}

export function useGitRepository(client: StudioClient, workspaceId?: WorkspaceId): RepositoryHook {
  const { syncRevision } = useExecutionTarget();
  const access = useMemo(() => {
    const current = () => workspaceId === undefined ? undefined : repositories.get(client)?.get(workspaceId);
    return {
      getSnapshot: () => current()?.getSnapshot() ?? emptySnapshot,
      refresh: () => current()?.refresh() ?? Promise.resolve(),
      synchronize: (revision: number) => current()?.synchronize(revision),
      subscribe: (listener: () => void) => {
        if (workspaceId === undefined) return () => {};
        let entries = repositories.get(client);
        if (entries === undefined) {
          entries = new Map();
          repositories.set(client, entries);
        }
        let store = entries.get(workspaceId);
        if (store === undefined) {
          const ownedEntries = entries;
          const created = createRepositoryStore(client, workspaceId, () => {
            if (ownedEntries.get(workspaceId) !== created) return;
            ownedEntries.delete(workspaceId);
            if (ownedEntries.size === 0) repositories.delete(client);
          });
          store = created;
          entries.set(workspaceId, store);
        }
        return store.subscribe(listener);
      },
    };
  }, [client, workspaceId]);
  // Lookups are render-safe: only a committed subscription creates an entry,
  // and callbacks look it up again rather than retaining a released store.
  const snapshot = useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
  useEffect(() => { access.synchronize(syncRevision); }, [access, syncRevision]);
  return { ...snapshot, refresh: access.refresh };
}
