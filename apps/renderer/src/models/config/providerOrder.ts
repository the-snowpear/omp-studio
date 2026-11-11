import type { ModelProviderRecord } from "@omp-studio/client-contract";

const PROVIDER_ORDER_KEY = "omp.providerDisplayOrder";

export function readProviderOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROVIDER_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function writeProviderOrder(order: ReadonlyArray<string>): void {
  try {
    localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* localStorage may be blocked; UI order stays in-memory. */
  }
}

export function sameOrder(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function mergeProviderOrder(ids: ReadonlyArray<string>, saved: ReadonlyArray<string>): string[] {
  const known = new Set(ids);
  const fromSaved = saved.filter((id) => known.has(id));
  const seen = new Set(fromSaved);
  return [...fromSaved, ...ids.filter((id) => !seen.has(id))];
}

export function sortProviders(
  providers: ReadonlyArray<ModelProviderRecord>,
  order: ReadonlyArray<string>,
): ModelProviderRecord[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const ai = rank.get(a.provider.id) ?? Number.POSITIVE_INFINITY;
      const bi = rank.get(b.provider.id) ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.index - b.index;
    })
    .map((item) => item.provider);
}

export function permuteVisible(
  full: ReadonlyArray<string>,
  visible: ReadonlyArray<string>,
  nextVisible: ReadonlyArray<string>,
): string[] {
  const known = new Set(visible);
  const queue = nextVisible.slice();
  return full.map((id) => (known.has(id) ? queue.shift() ?? id : id));
}
