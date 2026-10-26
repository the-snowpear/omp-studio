import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MODEL_THINKING_MODES, modelParameterValues, thinkingForRoleModel, clampRoleThinking, type ModelCatalogDocument, type ModelThinkingConfig } from "@omp-studio/client-contract";
import { createModelCatalogService, resolveModelAdaptation, decodeModelCatalog, MODEL_CATALOG_URL } from "../src/model-adaptation.js";
import { BUILTIN_MODEL_CATALOG } from "../src/model-catalog.generated.js";
import { createOmpModelsService, toYamlProvider } from "../src/omp-models-adapter.js";
import { parseModelsYml } from "../src/models-yml.js";

const thinking: ModelThinkingConfig = { mode: "anthropic-adaptive", efforts: ["low", "high", "max"], defaultLevel: "high", effortMap: { max: "maximum" }, supportsDisplay: true, requiresEffort: true };
const catalog: ModelCatalogDocument = { schemaVersion: 1, version: "v1", upstreamCommit: "test", entries: [
  { key: "official/a", provider: "official", id: "model-a-2026", name: "Model A 2026", api: "anthropic-messages", aliases: ["model-a-stable"], values: { contextWindow: 200000, maxTokens: 64000, reasoning: true, thinkingConfig: thinking } },
] };

test("the published directory can be loaded through the same boundary as a remote update", () => {
  assert.equal(decodeModelCatalog(BUILTIN_MODEL_CATALOG).version, BUILTIN_MODEL_CATALOG.version);
});

test("matches names and aliases, respects the API, and lets endpoint values win", () => {
  const result = resolveModelAdaptation(catalog, { providerId: "gateway", api: "anthropic-messages", modelId: "Model_A_2026", endpoint: { contextWindow: 100000 } });
  assert.equal(result.status, "matched");
  assert.equal(result.values.contextWindow, 100000);
  assert.equal(result.sources.contextWindow?.source, "endpoint");
  assert.deepEqual(result.values.thinkingConfig, thinking);
  assert.equal(result.sources.thinkingConfig?.catalogModel, "official/a");
  assert.equal(resolveModelAdaptation(catalog, { providerId: "gateway", api: "anthropic-messages", modelId: "model-a-stable" }).status, "matched");
  assert.equal(resolveModelAdaptation(catalog, { providerId: "gateway", api: "openai-completions", modelId: "model-a-2026" }).status, "none");
});

test("different provider configurations remain ambiguous; exact providers take priority", () => {
  const conflicting: ModelCatalogDocument = { ...catalog, entries: [...catalog.entries, { ...catalog.entries[0]!, key: "other/a", provider: "other", values: { contextWindow: 64000 } }] };
  const input = { providerId: "gateway", api: "anthropic-messages", modelId: "model-a-2026" };
  const result = resolveModelAdaptation(conflicting, input);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.values, {});
  assert.equal(resolveModelAdaptation(conflicting, { ...input, providerId: "official" }).values.contextWindow, 200000);
  const identical = { ...catalog, entries: [...catalog.entries, { ...catalog.entries[0]!, provider: "other", key: "other/a" }] };
  assert.equal(resolveModelAdaptation(identical, input).status, "matched");
});

test("manual catalog refresh is offline at startup, preserves pinned drafts, and retains the cache after failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-catalog-"));
  const next: ModelCatalogDocument = { ...catalog, version: "v2", entries: [{ ...catalog.entries[0]!, values: { contextWindow: 999999 } }] };
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls += 1; assert.equal(url, MODEL_CATALOG_URL); assert.equal(init?.headers, undefined);
    if (calls > 1) throw new Error("offline");
    return Response.json(next);
  };
  const cachePath = join(directory, "cache.json");
  const service = createModelCatalogService({ cachePath, fetch, builtin: catalog });
  assert.equal((await service.status()).version, "v1"); assert.equal(calls, 0);
  assert.equal((await service.refresh()).catalog.version, "v2");
  const input = { providerId: "official", api: "anthropic-messages", modelId: "model-a-2026" };
  assert.equal((await service.resolve({ ...input, catalogVersion: "v1" })).values.contextWindow, 200000);
  assert.equal((await service.resolve(input)).values.contextWindow, 999999);
  await assert.rejects(service.refresh(), /offline/);
  assert.equal((await service.status()).version, "v2");
  assert.equal((await createModelCatalogService({ cachePath, fetch, builtin: catalog }).status()).version, "v2");
});

test("complete thinking modes survive save/read, source records survive reopening, and external edits become manual", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-model-origins-"));
  const service = createOmpModelsService({ agentDir: directory, locateOmp: async () => undefined });
  const models = MODEL_THINKING_MODES.map((mode, i) => ({ id: `model-${i}`, contextWindow: 200000, maxContextWindow: 1000000, maxTokens: 64000, reasoning: true, thinkingConfig: { ...thinking, mode }, parameterSources: { contextWindow: { source: "endpoint" as const }, thinkingConfig: { source: "catalog" as const, catalogVersion: "v1", catalogModel: "official/a" } } }));
  await service.upsertProvider({ id: "gateway", name: "Gateway", api: "anthropic-messages", auth: { type: "none" }, models });
  let snapshot = await service.get();
  const rows = snapshot.providers.find(row => row.id === "gateway")!.models;
  for (const [i, row] of rows.entries()) {
    assert.deepEqual(row.thinkingConfig, models[i]!.thinkingConfig);
    assert.equal(row.maxContextWindow, 1000000);
    assert.equal(row.parameterSources?.thinkingConfig?.source, "catalog");
    assert.equal(snapshot.availableModels.find(model => model.selector === row.selector)?.thinkingConfig?.defaultLevel, "high");
  }
  const file = join(directory, "models.yml");
  await writeFile(file, (await readFile(file, "utf8")).replace("contextWindow: 200000", "contextWindow: 100000"));
  snapshot = await createOmpModelsService({ agentDir: directory, locateOmp: async () => undefined }).get();
  const edited = snapshot.providers.find(row => row.id === "gateway")!.models[0]!;
  assert.equal(edited.parameterSources?.contextWindow?.source, "manual");
  assert.equal(edited.parameterSources?.thinkingConfig?.source, "catalog");
});

test("unknown reasoning stays absent and thinking undefined preserves while null clears", () => {
  const input = { id: "gateway", name: "Gateway", api: "openai-completions", auth: { type: "none" as const }, models: [{ id: "unknown" }] };
  const output = toYamlProvider(input, { models: [{ id: "unknown", thinking: { ...thinking, efforts: [...thinking.efforts], effortMap: { max: "maximum" } }, customNativeSetting: "kept" }] });
  const model = (output.models as Array<Record<string, unknown>>)[0]!;
  assert.equal(Object.hasOwn(model, "reasoning"), false);
  assert.deepEqual(model.thinking, thinking);
  assert.equal(model.customNativeSetting, "kept");
  const cleared = toYamlProvider({ ...input, models: [{ id: "unknown", thinkingConfig: null }] }, output);
  assert.equal(Object.hasOwn((cleared.models as Array<Record<string, unknown>>)[0]!, "thinking"), false);
});

test("the provider YAML overlay saves original sources and clears owned fields while retaining native extras", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-overlay-origins-"));
  const service = createOmpModelsService({ agentDir: directory, locateOmp: async () => undefined });
  await service.writeModelsYml({ text: "", overlay: { id: "gateway", name: "Gateway", api: "openai-completions", auth: { type: "none" }, models: [{ id: "example", contextWindow: 200000, thinkingConfig: { ...thinking, mode: "effort" }, parameterSources: { contextWindow: { source: "catalog", catalogVersion: "v1" } } }] } });
  const model = (await service.get()).providers[0]!.models[0]!;
  assert.equal(model.parameterSources?.contextWindow?.source, "catalog");
  const rewritten = toYamlProvider({ id: "gateway", name: "Gateway", api: "openai-completions", auth: { type: "none" }, models: [{ id: "example", omitMaxOutputTokens: false }] }, { models: [{ id: "example", omitMaxOutputTokens: true, contextPromotionTarget: "old/model", nativeExtra: true }] });
  const row = (rewritten.models as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.omitMaxOutputTokens, undefined);
  assert.equal(row.contextPromotionTarget, undefined);
  assert.equal(row.nativeExtra, true);
});

test("role defaults, nearest efforts with higher ties, explicit off and required effort", async () => {
  const model = { reasoning: true, thinkingConfig: { mode: "effort" as const, efforts: ["low", "high"] as const, defaultLevel: "high" as const } };
  assert.equal(thinkingForRoleModel(undefined, model), "high");
  assert.equal(clampRoleThinking("medium", model), "high");
  assert.equal(clampRoleThinking("off", model), "off");
  assert.equal(clampRoleThinking("off", { ...model, thinkingConfig: { ...model.thinkingConfig, requiresEffort: true } }), "low");
  const directory = await mkdtemp(join(tmpdir(), "omp-role-off-"));
  await writeFile(join(directory, "config.yml"), "modelRoles:\n  default: gateway/example:off\n  plan: gateway/example:medium\n  task: gateway/example\n");
  const service = createOmpModelsService({ agentDir: directory, locateOmp: async () => undefined });
  const snapshot = await service.get();
  assert.equal(snapshot.roles.find(role => role.id === "default")?.thinking, "off");
  assert.match(snapshot.generatedConfigYml, /gateway\/example:off/);
  assert.equal(snapshot.roles.find(role => role.id === "task")?.thinking, undefined);
});
