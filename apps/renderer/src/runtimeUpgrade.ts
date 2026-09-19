import { useEffect, useState } from "react";
import type { StudioClient, CommandInput, UpgradeOperation, UpgradeResultMap } from "@omp-studio/client-contract";
import { waitReceipt } from "./hostError";
export async function invokeUpgrade<K extends UpgradeOperation["kind"]>(
 client: StudioClient, kind: K, input: CommandInput<K>,
): Promise<UpgradeResultMap[K]> {
 const accepted = await client.command(kind, input as never);
 const outcome = await waitReceipt<{ snapshot: unknown; result: UpgradeResultMap[K] }>(client, accepted.requestId);
 return outcome.result;
}
export function useUpgradeAvailable(client: StudioClient | null, preview: boolean, kind: UpgradeOperation["kind"]): boolean {
 const [available, setAvailable] = useState(false);
 useEffect(() => {
  let generation = 0;
  let resyncing = false;
  setAvailable(false);
  if (preview || !client) return;
  const refresh = () => {
   const current = ++generation;
   setAvailable(false);
   void client.query("capabilities.get", {}).then(manifest => {
    if (current === generation) setAvailable(manifest.capabilities.some(cap => cap.id === kind && cap.grade !== "unavailable"));
   }).catch(() => {});
  };
  const unsubscribe = client.subscribe({ scope: "all" }, event => {
   if (event.kind === "runtime.changed") {
    if (event.connection.status === "connected") { resyncing = false; refresh(); }
    else { generation++; setAvailable(false); }
   } else if (event.kind === "resync.required") {
    resyncing = true;
    generation++; setAvailable(false);
   } else if (event.kind === "snapshot" && resyncing) {
    resyncing = false;
    refresh();
   }
  });
  refresh();
  return () => { generation++; unsubscribe(); };
 }, [client, preview, kind]);
 return preview || available;
}
