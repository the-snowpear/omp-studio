/**
 * Candidate list for the provider editor's "auto-fetch models" button.
 *
 * Pure display/merge logic over what `models.provider.probe` returned, the
 * draft's existing model rows, and the local `models.db` catalog. Nothing here
 * talks to the Host, and nothing invents metadata: a field the endpoint did not
 * report and the local catalog does not know stays absent so OMP's own bundled
 * catalog and defaults (128k / 16k) keep filling the gap at load time.
 */

import type {
  AvailableModelRecord,
  ModelCatalogEntry,
  ModelDiscoveryModel,
} from "@omp-studio/client-contract";

export type FetchedModelCandidate = {
  readonly id: string;
  readonly name: string;
  /** Already present under this provider (any source), so importing would duplicate. */
  readonly existing: boolean;
  readonly picked: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly image?: boolean;
  readonly thinking?: ReadonlyArray<string>;
  /** Some metadata came from the local `models.db` catalog, not the endpoint. */
  readonly enriched: boolean;
};

/**
 * Merge probe output with the draft's models and the local catalog.
 *
 * Endpoint-reported values win; the local `models.db` record for the same model
 * id fills the rest; anything still unknown is left off. `picked` defaults to
 * every new model and leaves existing ones out.
 */
export function toCandidates(
  fetched: ReadonlyArray<ModelDiscoveryModel>,
  draftModels: ReadonlyArray<ModelCatalogEntry>,
  available: ReadonlyArray<AvailableModelRecord>,
): FetchedModelCandidate[] {
  const existingIds = new Set(draftModels.map((model) => model.id));
  const catalog = new Map<string, AvailableModelRecord>();
  for (const model of available) {
    if (!catalog.has(model.id)) catalog.set(model.id, model);
  }
  const out: FetchedModelCandidate[] = [];
  const seen = new Set<string>();
  for (const model of fetched) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = catalog.get(id);
    const contextWindow = model.contextWindow ?? known?.contextWindow;
    const maxTokens = model.maxTokens ?? known?.maxTokens;
    const reasoning = model.reasoning ?? known?.reasoning;
    const image = model.image ?? known?.image;
    const thinking = known?.thinking && known.thinking.length > 0 ? known.thinking : undefined;
    const enriched = known !== undefined && (
      (model.contextWindow === undefined && contextWindow !== undefined)
      || (model.maxTokens === undefined && maxTokens !== undefined)
      || (model.reasoning === undefined && reasoning !== undefined)
      || (model.image === undefined && image !== undefined)
      || thinking !== undefined
    );
    const existing = existingIds.has(id);
    out.push({
      id,
      name: model.name.trim() || id,
      existing,
      picked: !existing,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(image === undefined ? {} : { image }),
      ...(thinking === undefined ? {} : { thinking }),
      enriched,
    });
  }
  return out;
}

/** Flip one candidate's checkbox. Existing rows can be re-picked deliberately. */
export function togglePicked(
  candidates: ReadonlyArray<FetchedModelCandidate>,
  id: string,
): FetchedModelCandidate[] {
  return candidates.map((item) => (item.id === id ? { ...item, picked: !item.picked } : item));
}

/** Select or clear every candidate at once. */
export function setAllPicked(
  candidates: ReadonlyArray<FetchedModelCandidate>,
  picked: boolean,
): FetchedModelCandidate[] {
  return candidates.map((item) => ({ ...item, picked }));
}

export function pickedCount(candidates: ReadonlyArray<FetchedModelCandidate>): number {
  return candidates.reduce((total, item) => (item.picked ? total + 1 : total), 0);
}

/**
 * Build the custom-model rows to append to the draft. Unknown metadata produces
 * no key at all, so `models.yml` gets just `id` + `name` for those models.
 * `reasoning` / `tools` / `image` are required by `ModelCatalogEntry`; only the
 * numeric limits and thinking efforts can be omitted.
 */
export function candidatesToEntries(
  providerId: string,
  candidates: ReadonlyArray<FetchedModelCandidate>,
): ModelCatalogEntry[] {
  return candidates.filter((item) => item.picked).map((item) => ({
    id: item.id,
    name: item.name,
    selector: `${providerId}/${item.id}`,
    ...(item.contextWindow === undefined ? {} : { contextWindow: item.contextWindow }),
    ...(item.maxTokens === undefined ? {} : { maxTokens: item.maxTokens }),
    image: item.image === true,
    reasoning: item.reasoning === true,
    tools: true,
    status: "available" as const,
    source: "custom" as const,
    ...(item.reasoning === true && item.thinking && item.thinking.length > 0
      ? { thinking: [...item.thinking] }
      : {}),
  }));
}

/**
 * Append imported rows to the draft, replacing any custom row with the same id
 * so a re-import updates in place instead of creating a duplicate. Catalog rows
 * are left alone — those are read-only projections of `models.db`.
 */
export function mergeImportedModels(
  current: ReadonlyArray<ModelCatalogEntry>,
  imported: ReadonlyArray<ModelCatalogEntry>,
): ModelCatalogEntry[] {
  const importedIds = new Set(imported.map((model) => model.id));
  const kept = current.filter((model) => !(model.source === "custom" && importedIds.has(model.id)));
  return [...kept, ...imported];
}
