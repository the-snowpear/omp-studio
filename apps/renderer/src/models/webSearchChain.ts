import type { AvailableModelRecord, WebSearchRouting } from "@omp-studio/client-contract";
export function searchChain(routing: WebSearchRouting, models: readonly AvailableModelRecord[]): string[] {
  const defaults = routing.defaultCandidates.filter(selector => selector !== "web/public" && models.some(model => model.selector === selector));
  const primary = routing.primary || defaults[0];
  return [...new Set([...(primary ? [primary] : []), ...(routing.fallbacks ?? defaults)])];
}
export function explicitSearchChain(routing: WebSearchRouting, chain: readonly string[]): WebSearchRouting {
  return { ...routing, primary: chain[0] ?? "", fallbacks: chain.slice(1), migratedLegacy: false };
}
