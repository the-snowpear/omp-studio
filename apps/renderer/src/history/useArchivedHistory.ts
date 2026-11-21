import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionHistoryReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";

const PAGE_SIZE = 50;

export function useArchivedHistory(
  client: StudioClient | undefined,
  workspaceId: WorkspaceId | undefined,
  enabled: boolean,
  revision: number,
) {
  const scope = useMemo(() => ({ client, workspaceId }), [client, workspaceId]);
  const [read, setRead] = useState<{
    scope: typeof scope;
    model?: SessionHistoryReadModel | undefined;
    loading: boolean;
    error?: unknown;
  }>();
  const current = read?.scope === scope ? read : undefined;
  const latest = useRef(current?.model);
  latest.current = current?.model;
  const generation = useRef(0);

  const load = useCallback(async (more: boolean) => {
    if (!client) return;
    const request = ++generation.current;
    const previous = latest.current;
    const entries = more ? [...(previous?.entries ?? [])] : [];
    const count = more ? entries.length + PAGE_SIZE : Math.max(PAGE_SIZE, previous?.entries.length ?? 0);
    setRead({ scope, model: previous, loading: true });
    try {
      let total = count;
      let offset = entries.length;
      while (offset < Math.min(count, total)) {
        const page = await client.query("history.list", {
          status: "archived",
          limit: Math.min(PAGE_SIZE, count - offset),
          offset,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        });
        if (request !== generation.current) return;
        entries.push(...page.entries);
        total = page.total;
        if (!page.entries.length) break;
        offset += page.entries.length;
      }
      setRead({ scope, model: { entries: [...new Map(entries.map(entry => [entry.threadId, entry])).values()], total }, loading: false });
    } catch (error) {
      if (request === generation.current) setRead({ scope, model: previous, loading: false, error });
    }
  }, [scope, client, workspaceId]);

  useEffect(() => {
    if (!enabled || !client) return;
    void load(false);
    return () => { generation.current++; };
  }, [client, enabled, load, revision]);

  return {
    model: current?.model,
    loading: current?.loading ?? (enabled && client !== undefined),
    error: current?.error,
    loadMore: () => { void load(true); },
    refresh: () => { void load(false); },
  };
}
