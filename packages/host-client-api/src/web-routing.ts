import { migrateModelRoleConfig, MODEL_ROLE_PRIORITIES } from "./model-role-migration.js";
import type { WebSearchRouting } from "@omp-studio/client-contract";

/** Released v18.3.0 priority.json; kept separate from credential display order. */
export const WEB_PRIORITY_1830 = MODEL_ROLE_PRIORITIES.web;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
const RETIRED = ["webSearch", "webSearchOrder", "webSearchExclude", "webSearchGeminiModel"];

/** Mirrors upstream's legacy web migration without modifying a file during a read. */
export function readWebRouting(value: unknown): WebSearchRouting {
  const original = record(value);
  const root = migrateModelRoleConfig(value);
  const roles = record(root.modelRoles); const chains = record(record(root.retry).fallbackChains);
  const legacy = RETIRED.some(key => Object.hasOwn(record(original.providers), key) || Object.hasOwn(original, "providers." + key));
  return { primary: text(roles.web), fallbacks: Array.isArray(chains.web) ? list(chains.web) : null,
    defaultCandidates: [...WEB_PRIORITY_1830], migratedLegacy: legacy };
}

export function writeWebRouting(root: Record<string, unknown>, routing: Pick<WebSearchRouting, "primary" | "fallbacks">): void {
  const roles = { ...record(root.modelRoles) };
  const retry = { ...record(root.retry) }; const chains = { ...record(retry.fallbackChains) };
  if (routing.primary.trim()) roles.web = routing.primary.trim(); else delete roles.web;
  if (routing.fallbacks === null) delete chains.web; else chains.web = [...routing.fallbacks];
  root.modelRoles = roles; root.retry = { ...retry, fallbackChains: chains };
  const providers = { ...record(root.providers) };
  for (const key of RETIRED) { delete providers[key]; delete root["providers." + key]; }
  root.providers = providers;
}
