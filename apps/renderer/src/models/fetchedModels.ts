import { MODEL_PARAMETER_FIELDS, mergeModelParameters, modelParameterValues, type ModelAdaptationCandidate, type ModelAdaptationResult, type ModelParameterValues, type ModelParameterSources } from "@omp-studio/client-contract";
/**
 * Candidate list for the provider editor's "auto-fetch models" button.
 *
 * Pure display/merge logic over what `models.provider.probe` returned, the
 * draft's existing model rows, and typed adaptation results. Unknown metadata
 * stays absent. In particular, a same-id row from another provider's runtime
 * cache is never used as an arbitrary source of gateway thinking controls.
 */

import type {
  AvailableModelRecord,
  ModelCatalogEntry,
  ModelDiscoveryModel,
} from "@omp-studio/client-contract";

export type FetchedModelCandidate = {
  readonly parameters?: ModelParameterValues;
  readonly parameterSources?: ModelParameterSources;
  readonly adaptation?: ModelAdaptationResult;
  readonly kind?: import("@omp-studio/client-contract").ModelKind;
  readonly webSearch?: string;
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
 * Endpoint-reported values win; a confirmed compatible catalog match fills
 * the rest; anything still unknown is left off. `picked` defaults to
 * every new model and leaves existing ones out.
 */
export function toCandidates(
  fetched: ReadonlyArray<ModelDiscoveryModel>,
  draftModels: ReadonlyArray<ModelCatalogEntry>,
  _available: ReadonlyArray<AvailableModelRecord>,
  adaptations: ReadonlyMap<string, ModelAdaptationResult> = new Map(),
): FetchedModelCandidate[] {
  const existingIds = new Set(draftModels.map((model) => model.id));
  const out: FetchedModelCandidate[] = [];
  const seen = new Set<string>();
  for (const model of fetched) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const adaptation = adaptations.get(id);
    const known = adaptation?.values;
    const contextWindow = model.contextWindow ?? known?.contextWindow;
    const maxTokens = model.maxTokens ?? known?.maxTokens;
    const reasoning = model.reasoning ?? known?.reasoning;
    const image = model.image;
    const kind = model.kind;
    const webSearch = model.webSearch;
    const thinking = known?.thinkingConfig?.efforts;
    const enriched = known !== undefined && (
      (model.contextWindow === undefined && contextWindow !== undefined)
      || (model.maxTokens === undefined && maxTokens !== undefined)
      || (model.reasoning === undefined && reasoning !== undefined)
      || thinking !== undefined
    );
    const parameters: ModelParameterValues = known ?? {
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    };
    const parameterSources = adaptation?.sources ?? Object.fromEntries(Object.keys(parameters).map(field => [field, { source: "endpoint" as const }]));
    const existing = existingIds.has(id);
    out.push({
      id, parameters, parameterSources,
      ...(adaptation ? { adaptation } : {}),
      name: model.name.trim() || id,
      existing,
      picked: !existing,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(image === undefined ? {} : { image }),
      ...(kind === undefined ? {} : { kind }),
      ...(webSearch === undefined ? {} : { webSearch }),
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
    ...(item.kind === undefined ? {} : { kind: item.kind }),
    ...(item.webSearch === undefined ? {} : { webSearch: item.webSearch }),
    name: item.name,
    selector: `${providerId}/${item.id}`,
    ...(item.contextWindow === undefined ? {} : { contextWindow: item.contextWindow }),
    ...(item.maxTokens === undefined ? {} : { maxTokens: item.maxTokens }),
    ...(item.parameters ?? {}),
    ...(item.parameters ? { parameters: item.parameters } : {}),
    ...(item.parameterSources ? { parameterSources: item.parameterSources } : {}),
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
  return [...kept, ...imported.map(model => {
    const previous = current.find(row => row.id === model.id && row.source === "custom");
    if (!previous) return model;
    const prior = modelParameterValues(previous);
    const manualFields = MODEL_PARAMETER_FIELDS.filter(field => prior[field] !== undefined && (!previous.parameterSources?.[field] || previous.parameterSources[field]?.source === "manual"));
    const parameters = mergeModelParameters(model.parameters ?? modelParameterValues(model), Object.fromEntries(manualFields.map(field => [field, prior[field]])));
    const parameterSources = { ...model.parameterSources, ...Object.fromEntries(manualFields.map(field => [field, { source: "manual" as const }])) };
    return { ...previous, ...model, ...parameters, parameters, parameterSources, reasoning: parameters.reasoning ?? false, thinking: parameters.thinkingConfig?.efforts ?? [] };
  })];
}

export function chooseFetchedModelCandidate(candidate: FetchedModelCandidate, selected: ModelAdaptationCandidate): FetchedModelCandidate {
  const adaptation = candidate.adaptation!;
  const endpoint = Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => candidate.parameterSources?.[field]?.source === "endpoint").map(field => [field, candidate.parameters?.[field]]));
  const values = mergeModelParameters(selected.values, endpoint);
  const sources: ModelParameterSources = Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => values[field] !== undefined).map(field => [field, endpoint[field] !== undefined ? { source: "endpoint" } : { source: "catalog", catalogVersion: adaptation.catalogVersion, catalogModel: selected.key }]));
  const { contextWindow: _ctx, maxTokens: _max, reasoning: _reasoning, thinking: _thinking, ...rest } = candidate;
  return { ...rest, ...values, ...(values.thinkingConfig ? { thinking: values.thinkingConfig.efforts } : {}), parameters: values, parameterSources: sources, enriched: true, adaptation: { ...adaptation, status: "matched", candidates: [selected], values, sources } };
}
