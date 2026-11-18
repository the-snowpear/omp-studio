import { useEffect, useSyncExternalStore } from "react";
import type { WorkspacePathKind, WorkspacePathResolution } from "@omp-studio/client-contract";
import { useConversationView } from "../conversationWorkspace/Context";

/**
 * Path-like text in a transcript is a guess until the Host file service says
 * otherwise. Each conversation registers a resolver here and links subscribe to
 * its verdict, so a cipher mode like `RSA/ECB/PKCS1Padding` stays plain text
 * while a real workspace directory stays clickable.
 */
export type PathResolver = (paths: readonly string[]) => Promise<readonly WorkspacePathResolution[]>;

const MAX_RESOLVE_BATCH = 64;
const FLUSH_DELAY_MS = 40;
const MAX_CLASSIFIED = 4_096;

const resolvers = new Map<string, PathResolver>();
/** Verdicts are keyed by workspace so a project switch re-probes instead of trusting stale state. */
const kinds = new Map<string, WorkspacePathKind>();
const probing = new Set<string>();
/** owner → cache key → requested path, so one Host call covers every link in a batch of rows. */
const queues = new Map<string, Map<string, string>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const watchers = new Map<string, Set<() => void>>();
const registrations = new Set<() => void>();

const kindKey = (workspaceId: string, path: string) => `${workspaceId}\u0000${path}`;

function notify(key: string): void {
  for (const listener of watchers.get(key) ?? []) listener();
}

/** Classification is session-scoped, so a long transcript must not grow it without bound. */
function trimClassified(): void {
  while (kinds.size > MAX_CLASSIFIED) {
    const oldest = kinds.keys().next();
    if (oldest.done === true) return;
    kinds.delete(oldest.value);
    probing.delete(oldest.value);
  }
}

function schedule(owner: string): void {
  if (timers.has(owner)) return;
  timers.set(owner, setTimeout(() => { timers.delete(owner); void drain(owner); }, FLUSH_DELAY_MS));
}

async function drain(owner: string): Promise<void> {
  const resolve = resolvers.get(owner), queue = queues.get(owner);
  if (!resolve || queue === undefined || queue.size === 0) { queues.delete(owner); return; }
  const batch: string[] = [], keys = new Map<string, string>();
  for (const [key, path] of queue) {
    if (batch.length >= MAX_RESOLVE_BATCH) break;
    queue.delete(key);
    batch.push(path);
    keys.set(path, key);
  }
  if (queue.size === 0) queues.delete(owner);
  let resolutions: readonly WorkspacePathResolution[];
  try {
    resolutions = await resolve(batch);
  } catch {
    // A failed probe leaves every link exactly as it was, so an offline Host never erases real paths.
    return;
  }
  for (const resolution of resolutions) {
    const key = keys.get(resolution.path);
    if (key === undefined || kinds.get(key) === resolution.kind) continue;
    kinds.set(key, resolution.kind);
    trimClassified();
    notify(key);
  }
  if ((queues.get(owner)?.size ?? 0) > 0) schedule(owner);
}

export function registerPathResolver(owner: string, resolve: PathResolver): () => void {
  resolvers.set(owner, resolve);
  for (const listener of registrations) listener();
  return () => {
    if (resolvers.get(owner) !== resolve) return;
    resolvers.delete(owner);
    queues.delete(owner);
    const timer = timers.get(owner);
    if (timer !== undefined) { clearTimeout(timer); timers.delete(owner); }
    for (const listener of registrations) listener();
  };
}

/** An uncached path is classified by its syntax alone; `resolvable` tells the caller how much to trust that. */
export function useFilePathKind(path: string | undefined): { kind?: WorkspacePathKind; resolvable: boolean } {
  const view = useConversationView();
  const owner = view?.document.id ?? "standalone";
  const workspaceId = view?.document.ref.workspaceId === undefined ? undefined : String(view.document.ref.workspaceId);
  const resolvable = useSyncExternalStore(
    listener => { registrations.add(listener); return () => { registrations.delete(listener); }; },
    () => resolvers.has(owner) && workspaceId !== undefined,
    () => false,
  );
  const key = path === undefined || !resolvable || workspaceId === undefined ? undefined : kindKey(workspaceId, path);
  useEffect(() => {
    if (key === undefined || kinds.has(key) || probing.has(key)) return;
    probing.add(key);
    const queue = queues.get(owner) ?? new Map<string, string>();
    queues.set(owner, queue);
    queue.set(key, path as string);
    schedule(owner);
  }, [key, owner, path, resolvable]);
  const kind = useSyncExternalStore(
    listener => {
      if (key === undefined) return () => {};
      const set = watchers.get(key) ?? new Set<() => void>();
      watchers.set(key, set);
      set.add(listener);
      return () => { set.delete(listener); if (set.size === 0) watchers.delete(key); };
    },
    () => (key === undefined ? undefined : kinds.get(key)),
    () => undefined,
  );
  return kind === undefined ? { resolvable } : { kind, resolvable };
}
