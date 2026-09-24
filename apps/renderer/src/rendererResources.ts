import type { PerformanceCounters } from "@omp-studio/studio-protocol";
type Kind = "engines" | "stores";
const resources: Record<Kind, Set<() => PerformanceCounters>> = { engines: new Set(), stores: new Set() };
export function registerRendererResource(kind: Kind, read: () => PerformanceCounters): () => void {
  resources[kind].add(read);
  return () => { resources[kind].delete(read); };
}
export function collectRendererResources(): PerformanceCounters {
  const result: Record<string, number> = {};
  for (const kind of ["engines", "stores"] as const) {
    result[`${kind}.active`] = resources[kind].size;
    for (const read of resources[kind]) {
      try {
        for (const [key, value] of Object.entries(read())) {
          if (Number.isFinite(value) && value >= 0) result[`${kind}.${key}`] = (result[`${kind}.${key}`] ?? 0) + value;
        }
      } catch { /* Diagnostics never block a live frame. */ }
    }
  }
  return result;
}
