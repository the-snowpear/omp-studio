import type { AgentAccountPoolState } from "@omp-studio/studio-protocol";
import { PREVIEW_FEATURE_SETTINGS, PREVIEW_POOL_ACCOUNTS } from "./featureSettingsPreview";

export function createPreviewAccountPools(): AgentAccountPoolState {
  const pools = PREVIEW_FEATURE_SETTINGS.find(row => row.key === "task.agentAccountPools")!.value;
  return { global: structuredClone(pools), effective: structuredClone(pools) } as AgentAccountPoolState;
}

export function createPreviewPoolAccounts() {
  return structuredClone(PREVIEW_POOL_ACCOUNTS);
}
