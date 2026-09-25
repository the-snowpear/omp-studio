import { parseModelKind, type AvailableModelRecord, type StudioClient } from "@omp-studio/client-contract";
import type { WorkbenchResultMap } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";

/** Runtime includes local and keyless runners absent from models.db discovery caches. */
export async function loadRuntimeModels(client: StudioClient, isCurrent: () => boolean): Promise<AvailableModelRecord[]> {
  const rows: AvailableModelRecord[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    if (!isCurrent()) return [];
    const handle = await client.command("runtime.models.list", { ...(cursor ? { cursor } : {}), limit: 200 });
    const { result } = await waitReceipt<{ result: WorkbenchResultMap["runtime.models.list"] }>(client, handle.requestId, 15000);
    for (const model of result.models) {
      const kind = parseModelKind(model.kind); if (!kind) continue;
      rows.push({ ...model, kind, id: model.selector.slice(model.provider.length + 1) });
    }
    cursor = result.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 99)) throw new Error("Runtime model catalog exceeds the display limit");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
