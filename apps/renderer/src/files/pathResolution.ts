import { useCallback, useSyncExternalStore } from "react";
import type { WorkspacePathKind, WorkspacePathResolution } from "@omp-studio/client-contract";
import { useConversationView } from "../conversationWorkspace/Context";

interface PathTarget { targetId: string | null; workspaceId: string }
type PathResolver = (paths: readonly string[], target: PathTarget, explicit?: boolean) => Promise<readonly WorkspacePathResolution[]>;
type Probe = { path: string; target: PathTarget; group: string; readyAt: number; retried: boolean };

const MAX_RESOLVE_BATCH = 64;
const FLUSH_DELAY_MS = 40;
const RETRY_DELAY_MS = 500;
const MAX_CLASSIFIED = 4_096;

class PathResolutionQueue {
  private readonly kinds = new Map<string, WorkspacePathKind>();
  private readonly pending = new Map<string, Probe>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private timer?: { id: ReturnType<typeof setTimeout>; readyAt: number } | undefined;
  private draining = false;

  constructor(readonly resolve: PathResolver) {}

  kind(key: string) { return this.kinds.get(key); }

  watch(key: string, path: string, target: PathTarget, group: string, listener: () => void): () => void {
    const listeners = this.watchers.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.watchers.set(key, listeners);
    if (!this.kinds.has(key) && !this.pending.has(key)) {
      const readyAt = Date.now() + FLUSH_DELAY_MS;
      this.pending.set(key, { path, target, group, readyAt, retried: false });
      this.schedule(readyAt);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size !== 0) return;
      this.watchers.delete(key);
      this.pending.delete(key);
      // A remounted link gets a fresh chance if the file appeared while it was offscreen.
      if (this.kinds.get(key) === "missing") this.kinds.delete(key);
    };
  }

  dispose() {
    clearTimeout(this.timer?.id);
    this.timer = undefined;
    this.pending.clear();
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
      try {
        results = await this.resolve(batch.map(([, probe]) => probe.path), first.target);
      } catch {
        // A rejected query says nothing about whether its paths exist.
      } finally {
        const verdicts = new Map(results.map(result => [result.path, result.kind]));
        for (const [key, probe] of batch) {
          if (this.pending.get(key) !== probe) continue;
          this.pending.delete(key);
          const kind = verdicts.get(probe.path);
          if (kind !== undefined && kind !== this.kinds.get(key)) {
            this.kinds.set(key, kind);
            for (const listener of this.watchers.get(key) ?? []) listener();
          }
          if ((kind === undefined || kind === "missing") && !probe.retried && this.watchers.has(key)) {
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

export function useFilePathKind(path: string | undefined, { targetId, workspaceId }: PathTarget) {
  const owner = useConversationView()?.document.id ?? "standalone";
  const queue = useSyncExternalStore(subscribeRegistration, () => resolvers.get(owner), () => undefined);
  const group = JSON.stringify([targetId, workspaceId]);
  const key = path === undefined ? undefined : JSON.stringify([group, path]);
  const subscribe = useCallback((listener: () => void) => queue && path !== undefined && key !== undefined
    ? queue.watch(key, path, { targetId, workspaceId }, group, listener) : () => {},
  [queue, key, path, targetId, workspaceId, group]);
  const kind = useSyncExternalStore(subscribe, () => key === undefined ? undefined : queue?.kind(key), () => undefined);
  return { kind, resolvable: queue !== undefined };
}

export async function resolvePathOnOpen(owner: string, path: string, target: PathTarget): Promise<WorkspacePathKind | undefined> {
  try {
    const resolutions = await resolvers.get(owner)?.resolve([path], target, true);
    return resolutions?.[0]?.kind;
  } catch {
    return undefined;
  }
}
