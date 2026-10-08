import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  SessionTitleRow,
  SessionTitlesResult,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { waitReceipt, hostErrorMessage } from "../hostError";
import type { NativeHistoryContext } from "./NativeArchivePane";
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
    const refresh = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const handle = await client!.command("session.titles.inspect", {
          sessionId: context!.sessionId!,
          targetSessionIds: ids,
        });
        const result = (
          await waitReceipt<{ result: SessionTitlesResult }>(
            client!,
            handle.requestId,
          )
        ).result;
        if (current) {
          setRows(
            new Map(
              result.rows
                .filter((row) => ids.includes(row.sessionId))
                .map((row) => [row.sessionId, row]),
            ),
          );
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
    void refresh();
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, context?.sessionId, enabled, key, visible, preview]);
  return { rows, error };
}
