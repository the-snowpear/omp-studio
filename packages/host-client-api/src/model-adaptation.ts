import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MODEL_PARAMETER_FIELDS, mergeModelParameters, parseModelThinkingConfig, sameModelParameter,
  type ModelAdaptationInput, type ModelAdaptationResult, type ModelCatalogDocument,
  type ModelAdaptationCandidate,
  type ModelCatalogStatus, type ModelCatalogRefreshResult, type ModelParameterValues,
  type ModelParameterSources, type ModelParameterOrigin,
} from "@omp-studio/client-contract";
import { BUILTIN_MODEL_CATALOG } from "./model-catalog.generated.js";

export const MODEL_CATALOG_URL = "https://raw.githubusercontent.com/the-snowpear/omp-studio/main/catalog/model-catalog-v1.json";

export function normalizeModelName(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim().replace(/[\s._]+/g, "-").replace(/-+/g, "-");
}

const catalogIndexes = new WeakMap<ModelCatalogDocument, ReturnType<typeof buildCatalogIndex>>();
function buildCatalogIndex(catalog: ModelCatalogDocument) {
  const exact = new Map<string, ModelAdaptationCandidate[]>();
  const ids = new Map<string, ModelAdaptationCandidate[]>();
  const names = new Map<string, ModelAdaptationCandidate[]>();
  const apis = new Map<string, Array<{ row: ModelAdaptationCandidate; name: string }>>();
  const add = (map: Map<string, ModelAdaptationCandidate[]>, key: string, row: ModelAdaptationCandidate) => { const list = map.get(key) ?? []; list.push(row); map.set(key, list); };
  for (const row of catalog.entries) {
    add(exact, JSON.stringify([row.api, row.provider, row.id]), row);
    add(ids, JSON.stringify([row.api, row.id]), row);
    for (const name of new Set([row.id, row.name, ...(row.aliases ?? [])].map(normalizeModelName))) add(names, JSON.stringify([row.api, name]), row);
    const list = apis.get(row.api) ?? []; list.push({ row, name: normalizeModelName(row.name) }); apis.set(row.api, list);
  }
  return { exact, ids, names, apis };
}

export function resolveModelAdaptation(catalog: ModelCatalogDocument, input: ModelAdaptationInput): ModelAdaptationResult {
  let index = catalogIndexes.get(catalog);
  if (!index) { index = buildCatalogIndex(catalog); catalogIndexes.set(catalog, index); }
  const exact = index.exact.get(JSON.stringify([input.api, input.providerId, input.modelId])) ?? [];
  const sameId = index.ids.get(JSON.stringify([input.api, input.modelId])) ?? [];
  const names = new Set([input.modelId, input.name ?? ""].filter(Boolean).map(normalizeModelName));
  const named = [...new Set([...names].flatMap(name => index!.names.get(JSON.stringify([input.api, name])) ?? []))];
  const definite = exact.length ? exact : sameId.length ? sameId : named;
  const grouped = definite.filter((row, i) => definite.findIndex(other => sameModelParameter(other.values, row.values) && other.limitation === row.limitation) === i);
  const nearby = definite.length ? [] : (index.apis.get(input.api) ?? []).filter(({ name: normalized }) => [...names].some(name => name.length >= 5 && (normalized.startsWith(`${name}-`) || name.startsWith(`${normalized}-`)))).slice(0, 12).map(item => item.row);
  const candidates = grouped.length ? grouped : nearby;
  const status = grouped.length === 1 ? "matched" : candidates.length ? "ambiguous" : "none";
  const recommended = status === "matched" ? candidates[0]!.values : {};
  const values = mergeModelParameters(recommended, input.endpoint ?? {});
  const sources: Record<string, ModelParameterOrigin> = {};
  for (const field of MODEL_PARAMETER_FIELDS) {
    if (values[field] === undefined) continue;
    sources[field] = input.endpoint?.[field] !== undefined
      ? { source: "endpoint" }
      : { source: "catalog", catalogVersion: catalog.version, catalogModel: candidates[0]?.key ?? "" };
  }
  return { catalogVersion: catalog.version, status, candidates, values, sources };
}

/** The only validation boundary for downloaded catalog data. */
export function decodeModelCatalog(value: unknown): ModelCatalogDocument {
  const doc = value as ModelCatalogDocument;
  if (!doc || doc.schemaVersion !== 1 || typeof doc.version !== "string" || typeof doc.upstreamCommit !== "string" || !Array.isArray(doc.entries)) throw new Error("Unsupported model catalog format");
  for (const row of doc.entries) {
    if (![row.key, row.provider, row.id, row.name, row.api].every(v => typeof v === "string") || !row.values || (row.aliases !== undefined && (!Array.isArray(row.aliases) || !row.aliases.every((alias: unknown) => typeof alias === "string")))) throw new Error("Invalid model catalog entry");
    const values = row.values;
    for (const field of ["contextWindow", "maxContextWindow", "maxTokens"] as const) {
      if (values[field] !== undefined && (!Number.isSafeInteger(values[field]) || values[field]! <= 0)) throw new Error(`Invalid catalog ${field}`);
    }
    if (values.contextWindow !== undefined && values.maxContextWindow !== undefined && values.maxContextWindow < values.contextWindow) throw new Error("Invalid catalog extended context window");
    if (values.reasoning !== undefined && typeof values.reasoning !== "boolean") throw new Error("Invalid catalog reasoning");
    if (values.thinkingConfig !== undefined && (!values.thinkingConfig || !sameModelParameter(parseModelThinkingConfig(values.thinkingConfig), values.thinkingConfig))) throw new Error("Unsupported catalog thinking configuration");
  }
  return doc;
}

export function createModelCatalogService(options: { cachePath: string; fetch: typeof globalThis.fetch; builtin?: ModelCatalogDocument }) {
  let current = options.builtin ?? BUILTIN_MODEL_CATALOG;
  let source: ModelCatalogStatus["source"] = "builtin";
  const revisions = new Map([[current.version, current]]);
  let loaded: Promise<void> | undefined;
  const status = (): ModelCatalogStatus => ({ version: current.version, upstreamCommit: current.upstreamCommit, source });
  async function load() {
    loaded ??= (async () => {
      try {
        current = decodeModelCatalog(JSON.parse(await readFile(options.cachePath, "utf8")));
        source = "updated"; revisions.set(current.version, current);
      } catch { /* Offline/first launch uses the bundled catalog. */ }
    })();
    await loaded;
  }
  return {
    async status() { await load(); return status(); },
    async resolve(input: ModelAdaptationInput) {
      await load();
      return resolveModelAdaptation(revisions.get(input.catalogVersion ?? current.version) ?? current, input);
    },
    async refresh(): Promise<ModelCatalogRefreshResult> {
      await load();
      const response = await options.fetch(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Model catalog update failed: HTTP ${response.status}`);
      const next = decodeModelCatalog(await response.json());
      if (next.version === current.version) return { updated: false, catalog: status(), message: "模型目录已是最新版本" };
      await mkdir(dirname(options.cachePath), { recursive: true });
      await writeFile(`${options.cachePath}.tmp`, JSON.stringify(next), "utf8");
      await rename(`${options.cachePath}.tmp`, options.cachePath);
      current = next; source = "updated"; revisions.set(next.version, next);
      return { updated: true, catalog: status(), message: "模型目录已更新；已保存配置和当前草稿保持不变，可主动重新应用推荐" };
    },
  };
}

type OriginRecord = { values: ModelParameterValues; sources: ModelParameterSources };
type OriginFile = Record<string, Record<string, OriginRecord>>;

/** YAML owns values; the sidecar only remembers where an unchanged value came from. */
export function createModelOriginStore(agentDir: string) {
  const path = join(agentDir, "studio-model-origins.v1.json");
  async function read(): Promise<OriginFile> {
    try { return JSON.parse(await readFile(path, "utf8")) as OriginFile; }
    catch { return {}; }
  }
  async function reader() {
    const file = await read();
    return (provider: string, id: string, values: ModelParameterValues): ModelParameterSources => {
      const record = file[provider]?.[id];
      return Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => values[field] !== undefined).map(field => [field,
        record?.sources[field] && sameModelParameter(record.values[field], values[field]) ? record.sources[field] : { source: "manual" },
      ]));
    };
  }
  return {
    reader,
    async sources(provider: string, id: string, values: ModelParameterValues): Promise<ModelParameterSources> {
      return (await reader())(provider, id, values);
    },
    async save(provider: string, records: Record<string, OriginRecord>): Promise<void> {
      const file = await read();
      file[provider] = records;
      await mkdir(agentDir, { recursive: true });
      await writeFile(path, JSON.stringify(file, null, 2), "utf8");
    },
  };
}
