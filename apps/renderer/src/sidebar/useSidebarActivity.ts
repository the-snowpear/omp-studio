import { useEffect, useRef, useState } from "react";
import type { ResidentSessionRow, SessionHistoryEntry, SessionId, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import type { ProjectHistoryCache } from "./useProjectHistories";

const RECENT_TURN_MS = 10 * 60_000;
type Ended = { workspaceId: WorkspaceId; expires: number };
type Located = { workspaceId: WorkspaceId; entry: SessionHistoryEntry };

export function useSidebarActivity(client: StudioClient, residents: readonly ResidentSessionRow[] | undefined,
  histories: ProjectHistoryCache | undefined, expanded: ReadonlySet<string>, preview: boolean) {
  const previous = useRef(new Map<SessionId, ResidentSessionRow["phase"]>());
  const [ended, setEnded] = useState(() => new Map<SessionId, Ended>());
  useEffect(() => {
    previous.current.clear();
    setEnded(new Map());
  }, [client, preview]);
  useEffect(() => {
    if (preview || !residents) return;
    const before = previous.current;
    previous.current = new Map(residents.map(row => [row.sessionId, row.phase]));
    const now = Date.now();
    setEnded(current => {
      let next = current;
      for (const row of residents) {
        const last = before.get(row.sessionId);
        if (row.phase === "idle" && last && last !== "idle") {
          if (current === next) next = new Map(current);
          next.set(row.sessionId, { workspaceId: row.workspaceId, expires: now + RECENT_TURN_MS });
        } else if (row.phase !== "idle" && next.has(row.sessionId)) {
          if (current === next) next = new Map(current);
          next.delete(row.sessionId);
        }
      }
      return next;
    });
  }, [client, residents, preview]);
  useEffect(() => {
    if (!ended.size) return;
    const until = Math.min(...Array.from(ended.values(), row => row.expires));
    const timer = setTimeout(() => setEnded(current => new Map([...current].filter(([, row]) => row.expires > Date.now()))), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [ended]);

  // A resident can be much older than the current catalog page. Resolve only
  // missing priority rows, using the same workspace-bound Host identities as normal history.
  const wanted = new Map<SessionId, WorkspaceId>();
  if (!preview) {
    for (const [id, row] of ended) wanted.set(id, row.workspaceId);
    for (const row of residents ?? []) if (row.phase === "running" || row.phase === "compacting") wanted.set(row.sessionId, row.workspaceId);
  }
  const missing = [...wanted].filter(([id, workspace]) => expanded.has(workspace) && histories?.[workspace]?.status === "ready" &&
    !histories[workspace]?.model?.entries.some(entry => entry.sessionId === id));
  const missingKey = JSON.stringify(missing.sort(([a], [b]) => a.localeCompare(b)));
  const [located, setLocated] = useState<{ owner: StudioClient; rows: Located[] }>();
  useEffect(() => {
    let live = true;
    const requests: [SessionId, WorkspaceId][] = JSON.parse(missingKey);
    if (requests.length) void Promise.all(requests.map(async ([sessionId, workspaceId]) => {
      try {
        const model = await client.query("history.list", { workspaceId, sessionId, status: "active", limit: 1 });
        const entry = model.entries.find(row => row.sessionId === sessionId);
        return entry && { workspaceId, entry };
      } catch { return undefined; }
    })).then(rows => { if (live) setLocated({ owner: client, rows: rows.filter((row): row is Located => !!row) }); });
    else setLocated(undefined);
    return () => { live = false; };
  }, [client, missingKey]);
  return { ended, extra: located?.owner === client ? located.rows.filter(row => row.entry.sessionId && wanted.get(row.entry.sessionId) === row.workspaceId) : [] };
}
