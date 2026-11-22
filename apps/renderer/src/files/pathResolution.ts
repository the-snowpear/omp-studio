import { useCallback, useSyncExternalStore } from "react";
import type { WorkspacePathKind, WorkspacePathResolution } from "@omp-studio/client-contract";
import { useConversationView } from "../conversationWorkspace/Context";

interface PathTarget { targetId: string | null; workspaceId: string }
type PathResolver = (paths: readonly string[], target: PathTarget, explicit?: boolean) => Promise<readonly WorkspacePathResolution[]>;
type FilePathKind = WorkspacePathKind | "deferred";
type Probe = { path: string; target: PathTarget; group: string; readyAt: number; retried: boolean };

const MAX_RESOLVE_BATCH = 64;
const FLUSH_DELAY_MS = 40;
const RETRY_DELAY_MS = 500;
const MAX_CLASSIFIED = 4_096;
const pathGroup = (target: PathTarget) => JSON.stringify([target.targetId, target.workspaceId]);
const pathKey = (path: string, target: PathTarget) => JSON.stringify([pathGroup(target), path]);

class PathResolutionQueue {
  private readonly kinds = new Map<string, FilePathKind>();
  private readonly pending = new Map<string, Probe>();
  private readonly watched = new Map<string, Probe>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private timer?: { id: ReturnType<typeof setTimeout>; readyAt: number } | undefined;
  private draining = false;

  constructor(readonly resolve: PathResolver) {}

  kind(key: string) { return this.kinds.get(key); }

  watch(key: string, path: string, target: PathTarget, group: string, listener: () => void): () => void {
    const listeners = this.watchers.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.watchers.set(key, listeners);
    if (!this.watched.has(key)) {
      this.watched.set(key, { path, target, group, readyAt: 0, retried: false });
      this.refresh(key);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size !== 0) return;
      this.watchers.delete(key);
      this.watched.delete(key);
      this.pending.delete(key);
      // A remounted link gets a fresh chance if the file appeared while it was offscreen.
      if (this.kinds.get(key) === "missing") this.kinds.delete(key);
    };
  }

  refresh(key: string, immediate = false) {
    const probe = this.watched.get(key);
    if (!probe || !immediate && this.pending.has(key)) return;
    const readyAt = Date.now() + FLUSH_DELAY_MS;
    this.pending.set(key, { ...probe, readyAt, retried: false });
    this.schedule(readyAt);
  }

  invalidate(targetId: string | null, workspaceId?: string) {
    for (const [key, probe] of this.watched) {
      if (probe.target.targetId !== targetId || workspaceId !== undefined && probe.target.workspaceId !== workspaceId && probe.target.workspaceId !== "") continue;
      this.kinds.delete(key);
      this.pending.delete(key);
      this.refresh(key);
      for (const listener of this.watchers.get(key) ?? []) listener();
    }
  }

  private publish(key: string, kind: FilePathKind) {
    if (this.kinds.get(key) === kind) return;
    this.kinds.set(key, kind);
    for (const listener of this.watchers.get(key) ?? []) listener();
  }

  async onOpen(path: string, target: PathTarget): Promise<WorkspacePathKind | undefined> {
    const key = pathKey(path, target);
    this.pending.delete(key);
    const results = await this.resolve([path], target, true);
    const kind = results[0]?.kind;
    if (this.watchers.has(key) && kind !== undefined) this.publish(key, kind);
    return kind;
  }

  dispose() {
    clearTimeout(this.timer?.id);
    this.timer = undefined;
    this.pending.clear();
    this.watched.clear();
    this.kinds.clear();
    this.watchers.clear();
  }

  private schedule(readyAt: number) {
    if (this.draining || (this.timer && this.timer.readyAt <= readyAt)) return;
    clearTimeout(this.timer?.id);
    this.timer = { readyAt, id: setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, Math.max(0, readyAt - Date.now())) };
  }

  private async drain() {
    const batch: [string, Probe][] = [], now = Date.now();
    for (const entry of this.pending) {
      const probe = entry[1];
      if (probe.readyAt > now || (batch.length && probe.group !== batch[0]![1].group)) continue;
      batch.push(entry);
      if (batch.length === MAX_RESOLVE_BATCH) break;
    }
    const first = batch[0]?.[1];
    if (first) {
      this.draining = true;
      let results: readonly WorkspacePathResolution[] = [];
      let fulfilled = false;
      try {
        results = await this.resolve(batch.map(([, probe]) => probe.path), first.target);
        fulfilled = true;
      } catch {
        // A rejected query says nothing about whether its paths exist.
      } finally {
        const verdicts = new Map(results.map(result => [result.path, result.kind]));
        for (const [key, probe] of batch) {
          if (this.pending.get(key) !== probe) continue;
          this.pending.delete(key);
          const reported = verdicts.get(probe.path);
          // Successful omissions defer classification to a user activation;
          // a rejected query leaves the path unknown.
          const kind = reported ?? (fulfilled ? "deferred" : undefined);
          if (kind !== undefined) this.publish(key, kind);
          if ((reported === undefined || kind === "missing") && !probe.retried && this.watchers.has(key)) {
            this.pending.set(key, { ...probe, retried: true, readyAt: Date.now() + RETRY_DELAY_MS });
          }
        }
        while (this.kinds.size > MAX_CLASSIFIED) this.kinds.delete(this.kinds.keys().next().value!);
        this.draining = false;
      }
    }
    let next = Infinity;
    for (const probe of this.pending.values()) next = Math.min(next, probe.readyAt);
    if (next < Infinity) this.schedule(next);
  }
}

const resolvers = new Map<string, PathResolutionQueue>();
const registrations = new Set<() => void>();
const subscribeRegistration = (listener: () => void) => {
  registrations.add(listener);
  return () => { registrations.delete(listener); };
};

export function registerPathResolver(owner: string, resolve: PathResolver): () => void {
  resolvers.get(owner)?.dispose();
  const queue = new PathResolutionQueue(resolve);
  resolvers.set(owner, queue);
  for (const listener of registrations) listener();
  return () => {
    if (resolvers.get(owner) !== queue) return;
    resolvers.delete(owner);
    queue.dispose();
    for (const listener of registrations) listener();
  };
}

/** File changes invalidate only the active references on that Host/workspace. */
export function invalidateFilePathKinds(targetId: string | null, workspaceId?: string) {
  for (const queue of resolvers.values()) queue.invalidate(targetId, workspaceId);
}

export function useFilePathKind(path: string | undefined, { targetId, workspaceId }: PathTarget) {
  const owner = useConversationView()?.document.id ?? "standalone";
  const queue = useSyncExternalStore(subscribeRegistration, () => resolvers.get(owner), () => undefined);
  const group = pathGroup({ targetId, workspaceId });
  const key = path === undefined ? undefined : pathKey(path, { targetId, workspaceId });
  const subscribe = useCallback((listener: () => void) => queue && path !== undefined && key !== undefined
    ? queue.watch(key, path, { targetId, workspaceId }, group, listener) : () => {},
  [queue, key, path, targetId, workspaceId, group]);
  const kind = useSyncExternalStore(subscribe, () => key === undefined ? undefined : queue?.kind(key), () => undefined);
  const refresh = useCallback(() => { if (key !== undefined) queue?.refresh(key, true); }, [queue, key]);
  return { kind, refresh };
}

export async function resolvePathOnOpen(owner: string, path: string, target: PathTarget): Promise<WorkspacePathKind | undefined> {
  try {
    return await resolvers.get(owner)?.onOpen(path, target);
  } catch {
    return undefined;
  }
}
