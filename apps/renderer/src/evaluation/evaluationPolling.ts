import type { StudioClient } from "@omp-studio/client-contract";

/** One read at a time; events received during it request one fresh read afterwards. */
export function startEvaluationPolling({ client, load, intervalMs }: {
  client: StudioClient;
  load(): Promise<void>;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let running = false;
  let invalidated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    running = true;
    invalidated = false;
    try {
      await load();
    } finally {
      running = false;
      if (!stopped && !document.hidden && (invalidated || intervalMs !== undefined)) {
        timer = setTimeout(refresh, invalidated ? 0 : intervalMs);
      }
    }
  };
  const refresh = () => {
    clearTimeout(timer);
    if (stopped || document.hidden) return;
    invalidated = true;
    if (!running) void read();
  };
  const unsubscribe = client.subscribe({ scope: "all" }, event => {
    if (event.kind === "evaluations.changed") refresh();
  });
  document.addEventListener("visibilitychange", refresh);
  refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    document.removeEventListener("visibilitychange", refresh);
  };
}
