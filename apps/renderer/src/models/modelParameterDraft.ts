import {
  MODEL_PARAMETER_FIELDS, mergeModelParameters, modelParameterValues,
  type ModelParameterValues, type ModelParameterSources, type ModelParameterField,
  type ModelAdaptationResult, type ModelCatalogEntry, type ModelOverridePatch,
} from "@omp-studio/client-contract";

export interface ModelParameterDraft {
  readonly values: ModelParameterValues;
  readonly sources: ModelParameterSources;
  readonly recommendation?: ModelAdaptationResult;
  readonly catalogVersion?: string;
  readonly identity?: string;
  readonly pending?: boolean;
}

export function createModelParameterDraft(model?: ModelCatalogEntry | ModelOverridePatch): ModelParameterDraft {
  const values = model ? modelParameterValues(model) : {};
  const sources = Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => values[field] !== undefined).map(field => [field, model?.parameterSources?.[field] ?? { source: "manual" }]));
  return { values, sources };
}

export function effectiveModelParameters(draft: ModelParameterDraft): ModelParameterValues {
  return mergeModelParameters(draft.recommendation?.values ?? {}, draft.values);
}

export function effectiveParameterSources(draft: ModelParameterDraft): ModelParameterSources {
  return { ...draft.recommendation?.sources, ...draft.sources };
}

export function setManualModelParameter(draft: ModelParameterDraft, field: ModelParameterField, value: unknown): ModelParameterDraft {
  const values = { ...draft.values }, sources = { ...draft.sources };
  if (value === undefined) { delete values[field]; delete sources[field]; }
  else { Object.assign(values, { [field]: value }); sources[field] = { source: "manual" }; }
  return { ...draft, values, sources };
}

/** Reapplying recommendations retains deliberate user overrides. */
export function retainManualModelParameters(draft: ModelParameterDraft): ModelParameterDraft {
  const fields = MODEL_PARAMETER_FIELDS.filter(field => draft.sources[field]?.source === "manual");
  return {
    ...draft,
    values: Object.fromEntries(fields.filter(field => draft.values[field] !== undefined).map(field => [field, draft.values[field]])),
    sources: Object.fromEntries(fields.map(field => [field, draft.sources[field]!])),
  };
}

export function modelParameterDraftError(draft: ModelParameterDraft): string | undefined {
  const values = effectiveModelParameters(draft);
  for (const field of ["contextWindow", "maxContextWindow", "maxTokens"] as const) {
    const value = values[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) return "positiveInteger";
  }
  if (values.contextWindow && values.maxContextWindow && values.maxContextWindow < values.contextWindow) return "extendedWindowError";
  const thinking = values.thinkingConfig;
  if (thinking && (!thinking.efforts.length || (thinking.defaultLevel && !thinking.efforts.includes(thinking.defaultLevel)))) return "effortsError";
  return undefined;
}
