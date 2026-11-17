import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  SessionTitleRow,
  SessionTitlesResult,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { waitReceipt, hostErrorMessage } from "../hostError";
import type { NativeHistoryContext } from "./NativeArchivePane";
const TITLE_CACHE_TTL_MS = 5_000;
type CachedTitleEntry = { readonly title: string | undefined; readonly row: SessionTitleRow | undefined; readonly expiresAt: number };
type TitleBatchState = {
  sessionId: string;
  entries: Map<string, CachedTitleEntry>;
  queuedIds: Set<string>;
  queuedTitles: Map<string, string | undefined>;
  waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }>;
  scheduled: boolean;
};
const sharedTitleCaches = new WeakMap<StudioClient, TitleBatchState>();

function stateForClient(client: StudioClient, sessionId: string): TitleBatchState {
  let state = sharedTitleCaches.get(client);
  if (!state || state.sessionId !== sessionId) {
    state = { sessionId, entries: new Map(), queuedIds: new Set(), queuedTitles: new Map(), waiters: [], scheduled: false };
    sharedTitleCaches.set(client, state);
  }
  return state;
}

function inspectSharedTitles(client: StudioClient, sessionId: string, pairs: readonly [string, string | undefined][], force = false): Promise<ReadonlyMap<string, SessionTitleRow>> {
  const state = stateForClient(client, sessionId);
  const now = Date.now();
  const ids: string[] = [];
  const seen = new Set<string>();
  let missing = false;
  for (const [id, title] of pairs) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    const cached = state.entries.get(id);
    if (force || !cached || cached.expiresAt <= now || cached.title !== title) {
      missing = true;
      state.queuedIds.add(id);
      state.queuedTitles.set(id, title);
    }
  }
  const collect = (): ReadonlyMap<string, SessionTitleRow> => {
    const out = new Map<string, SessionTitleRow>();
    for (const id of ids) {
      const row = state.entries.get(id)?.row;
      if (row) out.set(id, row);
    }
    return out;
  };
  if (!missing) return Promise.resolve(collect());
  const gate = Promise.withResolvers<void>();
  state.waiters.push(gate);
  if (!state.scheduled) {
    state.scheduled = true;
    queueMicrotask(async () => {
      state.scheduled = false;
      const batchIds = [...state.queuedIds];
      const batchTitles = new Map(state.queuedTitles);
      const waiters = state.waiters.splice(0);
      state.queuedIds.clear();
      state.queuedTitles.clear();
      if (!batchIds.length) {
        for (const waiter of waiters) waiter.resolve();
        return;
      }
      try {
        const handle = await client.command("session.titles.inspect", {
          sessionId,
          targetSessionIds: batchIds,
        });
        const result = (await waitReceipt<{ result: SessionTitlesResult }>(client, handle.requestId)).result;
        const byId = new Map(result.rows.map((row) => [row.sessionId, row]));
        const expiresAt = Date.now() + TITLE_CACHE_TTL_MS;
        for (const id of batchIds) {
          state.entries.set(id, { title: batchTitles.get(id), row: byId.get(id), expiresAt });
        }
        for (const waiter of waiters) waiter.resolve();
      } catch (cause) {
        for (const waiter of waiters) waiter.reject(cause);
      }
    });
  }
  return gate.promise.then(collect);
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
    targets.slice(0, 32).map((row) => [row.id, row.title]),
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
    const ids = [...new Set(pairs.map((row) => row[0]).filter(Boolean))];
    if (!ids.length) {
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
