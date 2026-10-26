import type { ModelThinkingConfig } from "./model-thinking.js";

export const MODEL_PARAMETER_FIELDS = ["contextWindow", "maxContextWindow", "maxTokens", "reasoning", "thinkingConfig"] as const;
export type ModelParameterField = (typeof MODEL_PARAMETER_FIELDS)[number];

/** Only fields that models.yml can express. Missing means unknown/inherited. */
export interface ModelParameterValues {
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly thinkingConfig?: ModelThinkingConfig | null;
}

export interface ModelParameterOrigin {
  readonly source: "catalog" | "endpoint" | "manual";
  readonly catalogVersion?: string;
  readonly catalogModel?: string;
}
export type ModelParameterSources = Readonly<Partial<Record<ModelParameterField, ModelParameterOrigin>>>;

export interface ModelAdaptationCandidate {
  readonly key: string;
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly aliases?: readonly string[];
  readonly values: ModelParameterValues;
  /** Native routing/budget data cannot be transplanted to a gateway YAML row. */
  readonly limitation?: string;
}

export interface ModelAdaptationInput {
  readonly providerId: string;
  readonly api: string;
  readonly modelId: string;
  readonly name?: string;
  readonly endpoint?: ModelParameterValues;
  readonly catalogVersion?: string;
}

export interface ModelAdaptationResult {
  readonly catalogVersion: string;
  readonly status: "matched" | "ambiguous" | "none";
  readonly candidates: readonly ModelAdaptationCandidate[];
  readonly values: ModelParameterValues;
  readonly sources: ModelParameterSources;
}

export interface ModelCatalogStatus {
  readonly version: string;
  readonly upstreamCommit: string;
  readonly source: "builtin" | "updated";
}

export interface ModelCatalogDocument {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly upstreamCommit: string;
  readonly entries: readonly ModelAdaptationCandidate[];
}

export interface ModelCatalogRefreshResult {
  readonly updated: boolean;
  readonly catalog: ModelCatalogStatus;
  readonly message: string;
}

/** Merge by presence, including explicit false/null, never by truthiness. */
export function mergeModelParameters(
  recommended: ModelParameterValues,
  overrides: ModelParameterValues,
): ModelParameterValues {
  const out: Record<string, unknown> = { ...recommended };
  for (const field of MODEL_PARAMETER_FIELDS) {
    if (overrides[field] !== undefined) out[field] = overrides[field];
  }
  if (out.reasoning === false) out.thinkingConfig = null;
  return out as ModelParameterValues;
}

export function modelParameterValues(value: ModelParameterValues & { readonly parameters?: ModelParameterValues }): ModelParameterValues {
  if (value.parameters) return value.parameters;
  return Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
}

/** Stable field comparison for provenance, independent of YAML map key order. */
export function sameModelParameter(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((v, i) => sameModelParameter(v, right[i]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && sameModelParameter(a[k], b[k]));
  }
  return false;
}
