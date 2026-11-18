import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  SessionTitleRow,
  SessionTitlesResult,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { waitReceipt, hostErrorMessage } from "../hostError";
import type { NativeHistoryContext } from "./NativeArchivePane";

const TITLE_BATCH_LIMIT = 32;
const TITLE_CACHE_TTL_MS = 5_000;
const TITLE_CACHE_LIMIT = 4 * TITLE_BATCH_LIMIT;
type CachedTitleEntry = { readonly row: SessionTitleRow | undefined; readonly expiresAt: number };
type PendingTitle = ReturnType<typeof Promise.withResolvers<SessionTitleRow | undefined>> & { readonly key: string };
type TitleBatchState = {
  sessionId: string;
  entries: Map<string, CachedTitleEntry>;
  pending: Map<string, Promise<SessionTitleRow | undefined>>;
  queued: Map<string, PendingTitle[]>;
};
const sharedTitleCaches = new WeakMap<StudioClient, TitleBatchState>();

function stateForClient(client: StudioClient, sessionId: string): TitleBatchState {
  let state = sharedTitleCaches.get(client);
  if (!state || state.sessionId !== sessionId) {
    state = { sessionId, entries: new Map(), pending: new Map(), queued: new Map() };
    sharedTitleCaches.set(client, state);
  }
  return state;
}

async function flushTitleBatch(client: StudioClient, state: TitleBatchState) {
  const queued = state.queued;
  state.queued = new Map();
  const ids = [...queued.keys()];
  for (let offset = 0; offset < ids.length; offset += TITLE_BATCH_LIMIT) {
    const batch = ids.slice(offset, offset + TITLE_BATCH_LIMIT);
    try {
      const handle = await client.command("session.titles.inspect", { sessionId: state.sessionId, targetSessionIds: batch });
      const { result } = await waitReceipt<{ result: SessionTitlesResult }>(client, handle.requestId);
      const rows = new Map(result.rows.map(row => [row.sessionId, row]));
      const now = Date.now();
      for (const id of batch) {
        const row = rows.get(id);
        // Do not hold an untitled inspection in cache for the full 5s TTL when
        // the caller already has a non-empty title or the session is still being named.
        const expiresAt = row?.title ? now + TITLE_CACHE_TTL_MS : now + 400;
        for (const request of queued.get(id)!) {
          state.entries.delete(request.key);
          state.entries.set(request.key, { row, expiresAt });
          request.resolve(row);
        }
      }
      while (state.entries.size > TITLE_CACHE_LIMIT) state.entries.delete(state.entries.keys().next().value!);
    } catch (cause) {
      for (const id of batch) for (const request of queued.get(id)!) request.reject(cause);
    } finally {
      for (const id of batch) for (const request of queued.get(id)!) state.pending.delete(request.key);
    }
  }
}

async function inspectSharedTitles(client: StudioClient, sessionId: string, pairs: readonly [string, string | undefined][], force: boolean): Promise<ReadonlyMap<string, SessionTitleRow>> {
  const state = stateForClient(client, sessionId);
  const now = Date.now();
  const entries = new Map(pairs.filter(([id]) => id));
  const rows = await Promise.all([...entries].map(async ([id, title]) => {
    const key = JSON.stringify([id, title]);
    const entry = state.entries.get(key);
    if (!force && entry && entry.expiresAt > now) return entry.row;
    const inFlight = state.pending.get(key);
    if (inFlight) return inFlight;
    const request = { key, ...Promise.withResolvers<SessionTitleRow | undefined>() };
    if (state.queued.size === 0) queueMicrotask(() => { void flushTitleBatch(client, state); });
    const waiting = state.queued.get(id) ?? [];
    waiting.push(request);
    state.queued.set(id, waiting);
    state.pending.set(key, request.promise);
    return request.promise;
  }));
  return new Map(rows.flatMap(row => row ? [[row.sessionId, row] as const] : []));
}

export function useSessionTitles(
  client: StudioClient | undefined,
  context: NativeHistoryContext | undefined,
  targets: readonly { id: string; title?: string | undefined }[],
  visible = true,
) {
  const { preview } = usePreviewMode();
  const [rows, setRows] = useState<ReadonlyMap<string, SessionTitleRow>>(
      new Map(),
    ),
    [error, setError] = useState("");
  const key = JSON.stringify(
    targets.slice(0, TITLE_BATCH_LIMIT).map((row) => [row.id, row.title]),
  );
  const enabled = !!(
    client &&
    context?.available &&
    context.sessionId &&
    context.capabilities?.capabilities.some(
      (row) =>
        row.id === "session.titles.inspect" && row.grade !== "unavailable",
    )
  );
  useEffect(() => {
    let current = true;
    setError("");
    if (preview || !enabled) {
      setRows(new Map());
      return;
    }
    if (!visible) return;
    const pairs = JSON.parse(key) as [string, string | undefined][];
    if (!pairs.some(([id]) => id)) {
      setRows(new Map());
      return;
    }
    let inFlight = false;
    const refresh = async (force = false) => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const resolved = await inspectSharedTitles(client!, context!.sessionId!, pairs, force);
        if (current) {
          setRows(resolved);
          setError("");
        }
      } catch (cause) {
        if (current) {
          setRows(new Map());
          setError(hostErrorMessage(cause, "Title metadata unavailable"));
        }
      } finally {
        inFlight = false;
      }
    };
    void refresh(false);
    const onVisible = () => {
      if (!document.hidden) void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void refresh(true), 15000);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, context?.sessionId, enabled, key, visible, preview]);
  return { rows, error };
}
