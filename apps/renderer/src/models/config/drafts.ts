import { createModelParameterDraft, effectiveModelParameters, effectiveParameterSources, type ModelParameterDraft } from "../modelParameterDraft";
import { thinkingForRoleModel, sameModelParameter, modelParameterValues } from "@omp-studio/client-contract";
import type { AvailableModelRecord, ModelCatalogEntry, ModelConfigReadModel, ModelCostMeta, ModelPresetItem, ModelProviderRecord, ModelProviderRemoteCompaction, ModelProviderUpsertInput, ModelRoleRecord } from "@omp-studio/client-contract";
import { clampRoleThinking, roleThinkingControl } from "@omp-studio/client-contract";
import { MODEL_THINKING } from "../../preview/modelConfigFixtures";
import { type CustomModelForm, type Draft, type DraftOverride, type DraftOverrideForm, type ModelEditState, type ModelRoleDraft } from "./types";

export function updateModelParameterDraft(current: ModelEditState | null, update: (draft: ModelParameterDraft) => ModelParameterDraft): ModelEditState | null {
  if (!current) return null;
  const parameters = update(current.draft.parameters);
  if (current.kind === "override") return { ...current, draft: { ...current.draft, parameters } };
  return { ...current, draft: { ...current.draft, parameters } };
}

function headersTextFrom(headers?: Readonly<Record<string, string>>): string {
  return Object.entries(headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function costFromFields(costIn: string, costOut: string, cacheRead: string, cacheWrite: string): ModelCostMeta | undefined {
  const input = parseOptionalNumber(costIn);
  const output = parseOptionalNumber(costOut);
  const read = parseOptionalNumber(cacheRead);
  const write = parseOptionalNumber(cacheWrite);
  if (input === undefined && output === undefined && read === undefined && write === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(read === undefined ? {} : { cacheRead: read }),
    ...(write === undefined ? {} : { cacheWrite: write }),
  };
}

function triState(value: "" | "true" | "false"): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function rcFromParts(
  enabled: boolean | undefined,
  endpoint: string,
  model: string,
): ModelProviderRemoteCompaction | undefined {
  const ep = endpoint.trim();
  const id = model.trim();
  if (enabled === undefined && !ep && !id) return undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(ep ? { endpoint: ep } : {}),
    ...(id ? { model: id } : {}),
  };
}

export function blankOverrideForm(from?: DraftOverride): DraftOverrideForm {
  return {
    parameters: createModelParameterDraft(from),
    bedrockMessagesApi: from?.bedrockMessagesApi === undefined ? "" : from.bedrockMessagesApi ? "true" : "false",
    requiresThinkingPresence: from?.requiresThinkingPresence === undefined ? "" : from.requiresThinkingPresence ? "true" : "false",
    extendedCacheTtlBeta: from?.extendedCacheTtlBeta === undefined ? "" : from.extendedCacheTtlBeta ? "true" : "false",
    statefulResponses: from?.statefulResponses === undefined ? "" : from.statefulResponses ? "true" : "false",
    preferWebsockets: from?.preferWebsockets === undefined ? "" : from.preferWebsockets ? "true" : "false",
    name: from?.name ?? "",
    tools: from?.tools === undefined ? "" : from.tools ? "true" : "false",
    image: from?.image === undefined ? "" : from.image ? "true" : "false",
    costIn: from?.cost?.input !== undefined ? String(from.cost.input) : "",
    costOut: from?.cost?.output !== undefined ? String(from.cost.output) : "",
    costCacheR: from?.cost?.cacheRead !== undefined ? String(from.cost.cacheRead) : "",
    costCacheW: from?.cost?.cacheWrite !== undefined ? String(from.cost.cacheWrite) : "",
    omitMaxOutputTokens: from?.omitMaxOutputTokens === undefined ? "" : from.omitMaxOutputTokens ? "true" : "false",
    premiumMultiplier: from?.premiumMultiplier !== undefined ? String(from.premiumMultiplier) : "",
    imageCountBudget: from?.imageCountBudget !== undefined ? String(from.imageCountBudget) : "",
    headersText: headersTextFrom(from?.headers),
    contextPromotionTarget: from?.contextPromotionTarget ?? "",
    compactionModel: from?.compactionModel ?? "",
    rcEnabled: from?.remoteCompaction?.enabled === undefined ? "" : from.remoteCompaction.enabled ? "true" : "false",
    rcEndpoint: from?.remoteCompaction?.endpoint ?? "",
    rcModel: from?.remoteCompaction?.model ?? "",
  };
}

export function blankCustomForm(from?: ModelCatalogEntry): CustomModelForm {
  return {
    parameters: createModelParameterDraft(from),
    bedrockMessagesApi: from?.bedrockMessagesApi === undefined ? "" : from.bedrockMessagesApi ? "true" : "false",
    requiresThinkingPresence: from?.requiresThinkingPresence === undefined ? "" : from.requiresThinkingPresence ? "true" : "false",
    extendedCacheTtlBeta: from?.extendedCacheTtlBeta === undefined ? "" : from.extendedCacheTtlBeta ? "true" : "false",
    statefulResponses: from?.statefulResponses === undefined ? "" : from.statefulResponses ? "true" : "false",
    preferWebsockets: from?.preferWebsockets === undefined ? "" : from.preferWebsockets ? "true" : "false",
    id: from?.id ?? "",
    name: from?.name ?? "",
    api: from?.api ?? "inherit",
    tools: from?.tools ?? true,
    image: from?.image ?? false,
    costIn: !from?.pricing && from?.cost?.input !== undefined ? String(from.cost.input) : "",
    costOut: !from?.pricing && from?.cost?.output !== undefined ? String(from.cost.output) : "",
    costCacheR: !from?.pricing && from?.cost?.cacheRead !== undefined ? String(from.cost.cacheRead) : "",
    costCacheW: !from?.pricing && from?.cost?.cacheWrite !== undefined ? String(from.cost.cacheWrite) : "",
    omitMaxOutputTokens: from?.omitMaxOutputTokens ?? false,
    premiumMultiplier: from?.premiumMultiplier !== undefined ? String(from.premiumMultiplier) : "",
    imageCountBudget: from?.imageCountBudget !== undefined ? String(from.imageCountBudget) : "",
    headersText: headersTextFrom(from?.headers),
    contextPromotionTarget: from?.contextPromotionTarget ?? "",
    compactionModel: from?.compactionModel ?? "",
    baseUrl: from?.baseUrl ?? "",
    rcEnabled: from?.remoteCompaction?.enabled ?? false,
    rcEndpoint: from?.remoteCompaction?.endpoint ?? "",
    rcModel: from?.remoteCompaction?.model ?? "",
  };
}

function parseOptionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function overrideFromForm(form: DraftOverrideForm): DraftOverride | null {
  const next: DraftOverride = { ...effectiveModelParameters(form.parameters), parameterSources: effectiveParameterSources(form.parameters) };
  const bedrock = triState(form.bedrockMessagesApi);
  if (bedrock !== undefined) next.bedrockMessagesApi = bedrock;
  const requiresThinkingPresence = triState(form.requiresThinkingPresence);
  if (requiresThinkingPresence !== undefined) next.requiresThinkingPresence = requiresThinkingPresence;
  const extendedCacheTtlBeta = triState(form.extendedCacheTtlBeta);
  const statefulResponses = triState(form.statefulResponses);
  const preferWebsockets = triState(form.preferWebsockets);
  if (extendedCacheTtlBeta !== undefined) next.extendedCacheTtlBeta = extendedCacheTtlBeta;
  if (statefulResponses !== undefined) next.statefulResponses = statefulResponses;
  if (preferWebsockets !== undefined) next.preferWebsockets = preferWebsockets;
  if (form.name.trim()) next.name = form.name.trim();
  const tools = triState(form.tools);
  if (tools !== undefined) next.tools = tools;
  const image = triState(form.image);
  if (image !== undefined) next.image = image;
  const cost = costFromFields(form.costIn, form.costOut, form.costCacheR, form.costCacheW);
  if (cost) next.cost = cost;
  const omit = triState(form.omitMaxOutputTokens);
  if (omit !== undefined) next.omitMaxOutputTokens = omit;
  const premium = parseOptionalNumber(form.premiumMultiplier);
  if (premium !== undefined) next.premiumMultiplier = premium;
  const imageBudget = parseOptionalNumber(form.imageCountBudget);
  if (imageBudget !== undefined) next.imageCountBudget = imageBudget;
  const headers = parseHeaders(form.headersText);
  if (Object.keys(headers).length > 0) next.headers = headers;
  if (form.contextPromotionTarget.trim()) next.contextPromotionTarget = form.contextPromotionTarget.trim();
  if (form.compactionModel.trim()) next.compactionModel = form.compactionModel.trim();
  const rc = rcFromParts(triState(form.rcEnabled), form.rcEndpoint, form.rcModel);
  if (rc) next.remoteCompaction = rc;
  return Object.keys(next).length > 0 ? next : null;
}

export function applyOverrideToDraft(host: Draft, modelId: string, form: DraftOverrideForm): { next: Draft; parsed: DraftOverride | null } {
  const parsed = overrideFromForm(form);
  const modelOverrides = { ...host.modelOverrides };
  if (parsed) modelOverrides[modelId] = parsed;
  else delete modelOverrides[modelId];
  const models = host.models.map((model) => {
    if (model.id !== modelId || (model.source !== "catalog" && model.source !== "extension")) return model;
    if (!parsed) return model;
    const base = { ...model };
    if (parsed.cost !== undefined) delete base.pricing;
    return {
      ...base,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.contextWindow === undefined ? {} : { contextWindow: parsed.contextWindow }),
      ...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
      ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
      ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
      ...(parsed.image === undefined ? {} : { image: parsed.image }),
      ...(parsed.cost === undefined ? {} : { cost: parsed.cost }),
      ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
      ...(parsed.thinkingConfig === undefined ? {} : { thinkingConfig: parsed.thinkingConfig }),
      ...(parsed.maxContextWindow === undefined ? {} : { maxContextWindow: parsed.maxContextWindow }),
    };
  });
  return { next: { ...host, modelOverrides, models }, parsed };
}

export function entryFromCustomForm(providerId: string, form: CustomModelForm): ModelCatalogEntry | null {
  const id = form.id.trim();
  if (!id) return null;
  const parameters = effectiveModelParameters(form.parameters);
  const cost = costFromFields(form.costIn, form.costOut, form.costCacheR, form.costCacheW);
  const premium = parseOptionalNumber(form.premiumMultiplier);
  const imageBudget = parseOptionalNumber(form.imageCountBudget);
  const headers = parseHeaders(form.headersText);
  const rc = rcFromParts(form.rcEnabled ? true : undefined, form.rcEndpoint, form.rcModel);
  return {
    id,
    name: form.name.trim() || id,
    selector: `${providerId}/${id}`,
    ...parameters, parameters,
    parameterSources: effectiveParameterSources(form.parameters),
    reasoning: parameters.reasoning ?? false,
    tools: form.tools,
    image: form.image,
    ...(cost ? { cost } : {}),
    status: "available",
    source: "custom",
    ...(form.api && form.api !== "inherit" ? { api: form.api } : {}),
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
    ...(form.omitMaxOutputTokens ? { omitMaxOutputTokens: true } : {}),
    ...(triState(form.bedrockMessagesApi) === undefined ? {} : { bedrockMessagesApi: triState(form.bedrockMessagesApi)! }),
    ...(triState(form.requiresThinkingPresence) === undefined ? {} : { requiresThinkingPresence: triState(form.requiresThinkingPresence)! }),
    ...(triState(form.extendedCacheTtlBeta) === undefined ? {} : { extendedCacheTtlBeta: triState(form.extendedCacheTtlBeta)! }),
    ...(triState(form.statefulResponses) === undefined ? {} : { statefulResponses: triState(form.statefulResponses)! }),
    ...(triState(form.preferWebsockets) === undefined ? {} : { preferWebsockets: triState(form.preferWebsockets)! }),
    ...(premium === undefined ? {} : { premiumMultiplier: premium }),
    ...(imageBudget === undefined ? {} : { imageCountBudget: imageBudget }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(form.contextPromotionTarget.trim() ? { contextPromotionTarget: form.contextPromotionTarget.trim() } : {}),
    ...(form.compactionModel.trim() ? { compactionModel: form.compactionModel.trim() } : {}),
    ...(rc ? { remoteCompaction: rc } : {}),
    ...(parameters.thinkingConfig ? { thinking: parameters.thinkingConfig.efforts } : {}),
  };
}

export function blankDraft(): Draft {
  return {
    id: "", name: "", website: "", note: "", api: "openai-completions", endpointUrl: "",
    local: false, enabled: true, authType: "api-key", apiKey: "", envName: "", command: "",
    discoveryType: "", headersText: "", disableStrictTools: false,
    transport: "", remoteCompactionEnabled: false, remoteCompactionEndpoint: "", remoteCompactionModel: "",
    models: [], modelOverrides: {},
  };
}

export function draftFromProvider(provider: ModelProviderRecord): Draft {
  return {
    id: provider.id,
    name: provider.name,
    website: provider.website ?? "",
    note: provider.note ?? "",
    api: provider.api,
    endpointUrl: provider.endpointUrl ?? "",
    local: provider.local,
    enabled: provider.enabled,
    authType: provider.auth.type,
    apiKey: provider.auth.type === "api-key" && provider.auth.apiKey && !provider.auth.apiKey.startsWith("!")
      ? provider.auth.apiKey
      : "",
    envName: provider.auth.envName ?? `${provider.id.replace(/-/g, "_").toUpperCase()}_API_KEY`,
    command: provider.auth.type === "command" && provider.auth.apiKey ? provider.auth.apiKey : "",
    discoveryType: provider.discovery?.type ?? "",
    ...(provider.discovery?.advertisedReasoning === undefined ? {} : { advertisedReasoning: provider.discovery.advertisedReasoning }),
    ...(provider.discovery?.timeoutMs === undefined ? {} : { discoveryTimeoutMs: provider.discovery.timeoutMs }),
    headersText: headersTextFrom(provider.headers),
    disableStrictTools: provider.disableStrictTools ?? false,
    transport: provider.transport ?? "",
    remoteCompactionEnabled: provider.remoteCompaction?.enabled ?? false,
    remoteCompactionEndpoint: provider.remoteCompaction?.endpoint ?? "",
    remoteCompactionModel: provider.remoteCompaction?.model ?? "",
    models: provider.models.map((model) => ({ ...model })),
    modelOverrides: { ...(provider.modelOverrides ?? {}) },
  };
}

export function draftFromPreset(preset: ModelPresetItem): Draft {
  return {
    ...blankDraft(),
    id: preset.id,
    name: preset.name,
    api: preset.api,
    endpointUrl: preset.endpoint ?? "",
    local: Boolean(preset.local),
    authType: preset.auth[0] ?? "api-key",
    envName: `${preset.id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    discoveryType: preset.discovery ?? "",
  };
}

export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function sameStringList(left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function catalogDraftEqual(left: ModelCatalogEntry, right: ModelCatalogEntry): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.selector === right.selector
    && left.status === right.status
    && left.source === right.source
    && left.reasoning === right.reasoning
    && left.tools === right.tools
    && left.image === right.image
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && left.api === right.api
    && left.baseUrl === right.baseUrl
    && left.cost?.input === right.cost?.input
    && left.cost?.output === right.cost?.output
    && left.cost?.cacheRead === right.cost?.cacheRead
    && left.cost?.cacheWrite === right.cost?.cacheWrite
    && sameStringList(left.thinking, right.thinking)
    && sameModelParameter(left.thinkingConfig, right.thinkingConfig)
    && sameModelParameter(left.parameters, right.parameters)
    && sameModelParameter(left.parameterSources, right.parameterSources);
}

function overrideDraftEqual(left: DraftOverride | undefined, right: DraftOverride | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.name === right.name
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && left.maxContextWindow === right.maxContextWindow
    && sameModelParameter(left.thinkingConfig, right.thinkingConfig)
    && sameModelParameter(left.parameterSources, right.parameterSources)
    && left.reasoning === right.reasoning
    && left.tools === right.tools
    && left.image === right.image
    && left.bedrockMessagesApi === right.bedrockMessagesApi
    && left.requiresThinkingPresence === right.requiresThinkingPresence
    && left.extendedCacheTtlBeta === right.extendedCacheTtlBeta
    && left.statefulResponses === right.statefulResponses
    && left.preferWebsockets === right.preferWebsockets
    && left.omitMaxOutputTokens === right.omitMaxOutputTokens
    && left.premiumMultiplier === right.premiumMultiplier
    && left.imageCountBudget === right.imageCountBudget
    && left.contextPromotionTarget === right.contextPromotionTarget
    && left.compactionModel === right.compactionModel
    && sameStringList(left.thinking, right.thinking)
    && (left.cost?.input === right.cost?.input && left.cost?.output === right.cost?.output && left.cost?.cacheRead === right.cost?.cacheRead && left.cost?.cacheWrite === right.cost?.cacheWrite);
}

export function draftsEqual(left: Draft, right: Draft): boolean {
  if (left.id !== right.id
    || left.name !== right.name
    || left.website !== right.website
    || left.note !== right.note
    || left.api !== right.api
    || left.endpointUrl !== right.endpointUrl
    || left.local !== right.local
    || left.enabled !== right.enabled
    || left.authType !== right.authType
    || left.apiKey !== right.apiKey
    || left.envName !== right.envName
    || left.command !== right.command
    || left.discoveryType !== right.discoveryType
    || left.discoveryTimeoutMs !== right.discoveryTimeoutMs
    || left.advertisedReasoning !== right.advertisedReasoning
    || left.headersText !== right.headersText
    || left.disableStrictTools !== right.disableStrictTools
    || left.transport !== right.transport
    || left.remoteCompactionEnabled !== right.remoteCompactionEnabled
    || left.remoteCompactionEndpoint !== right.remoteCompactionEndpoint
    || left.remoteCompactionModel !== right.remoteCompactionModel) {
    return false;
  }
  if (left.models.length !== right.models.length) return false;
  if (!left.models.every((model, index) => {
    const other = right.models[index];
    return other !== undefined && catalogDraftEqual(model, other);
  })) return false;
  const leftKeys = Object.keys(left.modelOverrides);
  const rightKeys = Object.keys(right.modelOverrides);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => overrideDraftEqual(left.modelOverrides[key], right.modelOverrides[key]));
}

export function rolesEqual(left: ModelRoleRecord, right: ModelRoleRecord): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.desc === right.desc
    && left.primary === right.primary
    && left.thinking === right.thinking;
}

export function roleSelector(role: ModelRoleRecord): string {
  return role.thinking ? `${role.primary}:${role.thinking}` : role.primary;
}

export function withRoleModel(
  role: ModelRoleRecord,
  primary: string,
  model: AvailableModelRecord | undefined,
): ModelRoleDraft {
  const thinking = role.primary !== primary ? thinkingForRoleModel(role.thinking, model) : clampRoleThinking(role.thinking, model);
  const { issue: _ignored, thinking: _thinking, ...rest } = role;
  const thinkingAdjustment = role.thinking && thinking && role.thinking !== thinking ? `${role.thinking} → ${thinking}` : (role as ModelRoleDraft).thinkingAdjustment;
  return { ...rest, primary, ...(thinking ? { thinking } : {}), ...(thinkingAdjustment ? { thinkingAdjustment } : {}) };
}

export function roleThinkingUi(role: Pick<ModelRoleRecord, "thinking">, model: AvailableModelRecord | undefined) {
  const control = roleThinkingControl(model);
  return {
    items: MODEL_THINKING.filter((item) => control.ids.includes(item.id)),
    disabled: control.disabled,
    value: role.thinking === undefined ? "" : (clampRoleThinking(role.thinking, model) ?? "off"),
  };
}

export function providerUpsertFromDraft(editor: Draft, contentHash?: string): ModelProviderUpsertInput {
  return {
    id: editor.id.trim(),
    name: editor.name.trim(),
    api: editor.api,
    // Explicit (possibly empty) values: the Host writer deletes the YAML key
    // when the string is blank, so clearing a field really removes it — sparse
    // omission would silently keep the old value behind the card’s back.
    endpointUrl: editor.endpointUrl,
    website: editor.website,
    note: editor.note,
    local: editor.local,
    enabled: editor.enabled,
    auth: {
      type: editor.authType,
      ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
      ...(editor.envName ? { envName: editor.envName } : {}),
      ...(editor.command ? { command: editor.command } : {}),
    },
    discovery: editor.discoveryType
      ? { type: editor.discoveryType, ...(editor.discoveryTimeoutMs === undefined ? {} : { timeoutMs: editor.discoveryTimeoutMs }), ...(editor.advertisedReasoning === undefined ? {} : { advertisedReasoning: editor.advertisedReasoning }) }
      : null,
    headers: parseHeaders(editor.headersText),
    disableStrictTools: editor.disableStrictTools,
    transport: editor.transport || null,
    remoteCompaction: editor.remoteCompactionEnabled || editor.remoteCompactionEndpoint || editor.remoteCompactionModel
      ? {
          ...(editor.remoteCompactionEnabled ? { enabled: true } : {}),
          ...(editor.remoteCompactionEndpoint ? { endpoint: editor.remoteCompactionEndpoint } : {}),
          ...(editor.remoteCompactionModel ? { model: editor.remoteCompactionModel } : {}),
        }
      : null,
    models: editor.models.filter((model) => model.source === "custom").map((model) => ({
      id: model.id,
      name: model.name,
      ...modelParameterValues(model),
      ...(model.thinkingConfig === undefined ? {} : { thinkingConfig: model.thinkingConfig }),
      ...(model.parameterSources ? { parameterSources: model.parameterSources } : {}),
      image: model.image,
      tools: model.tools,
      ...(model.cost ? { cost: model.cost } : {}),
      ...(model.api ? { api: model.api } : {}),
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.omitMaxOutputTokens ? { omitMaxOutputTokens: true } : {}),
      ...(model.bedrockMessagesApi === undefined ? {} : { bedrockMessagesApi: model.bedrockMessagesApi }),
      ...(model.requiresThinkingPresence === undefined ? {} : { requiresThinkingPresence: model.requiresThinkingPresence }),
      ...(model.extendedCacheTtlBeta === undefined ? {} : { extendedCacheTtlBeta: model.extendedCacheTtlBeta }),
      ...(model.statefulResponses === undefined ? {} : { statefulResponses: model.statefulResponses }),
      ...(model.preferWebsockets === undefined ? {} : { preferWebsockets: model.preferWebsockets }),
      ...(model.premiumMultiplier === undefined ? {} : { premiumMultiplier: model.premiumMultiplier }),
      ...(model.imageCountBudget === undefined ? {} : { imageCountBudget: model.imageCountBudget }),
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.contextPromotionTarget ? { contextPromotionTarget: model.contextPromotionTarget } : {}),
      ...(model.compactionModel ? { compactionModel: model.compactionModel } : {}),
      ...(model.remoteCompaction ? { remoteCompaction: model.remoteCompaction } : {}),
      ...(model.thinking && model.thinking.length > 0 ? { thinking: [...model.thinking] } : {}),
    })),
    modelOverrides: Object.keys(editor.modelOverrides).length > 0 ? editor.modelOverrides : null,
    ...(contentHash ? { expectedHash: contentHash } : {}),
  };
}

export function editorTestSecret(editor: Draft): string | undefined {
  if (editor.authType === "api-key") return editor.apiKey.trim() || undefined;
  if (editor.authType === "env") return editor.envName.trim() || undefined;
  if (editor.authType === "command") return editor.command.trim() || undefined;
  return undefined;
}

export function withPreviewLogin(record: ModelProviderRecord, current: ModelConfigReadModel): ModelProviderRecord {
  if (record.auth.type !== "oauth") return record;
  const login = current.loginProviders.find((item) => item.id === record.id);
  const existing = current.providers.find((item) => item.id === record.id);
  if (!login?.authenticated && !existing?.auth.hasSecret) return record;
  return {
    ...record,
    status: record.enabled ? "available" : record.status,
    statusDetail: "Logged in · Demo Account",
    auth: {
      ...record.auth,
      hasSecret: true,
      account: existing?.auth.account ?? "demo@local",
    },
  };
}

export function previewProviderFromDraft(editor: Draft): ModelProviderRecord {
  return {
    id: editor.id.trim(),
    name: editor.name.trim(),
    source: "custom",
    status: editor.enabled ? "available" : "disabled",
    statusDetail: "Demo · Not written to Host",
    api: editor.api,
    ...(editor.endpointUrl ? { endpointUrl: editor.endpointUrl } : {}),
    local: editor.local,
    enabled: editor.enabled,
    ...(editor.website ? { website: editor.website } : {}),
    ...(editor.note ? { note: editor.note } : {}),
    auth: {
      type: editor.authType,
      hasSecret: editor.authType === "none"
        ? false
        : editor.authType === "env"
          ? Boolean(editor.envName.trim())
          : Boolean(editor.apiKey || editor.command),
      ...(editor.authType === "api-key" && editor.apiKey ? { apiKey: editor.apiKey } : {}),
      ...(editor.authType === "command" && editor.command
        ? { apiKey: editor.command.startsWith("!") ? editor.command : `!${editor.command}` }
        : {}),
      ...(editor.authType === "env" && editor.envName.trim() ? { envName: editor.envName.trim() } : {}),
    },
    ...(editor.discoveryType ? { discovery: { type: editor.discoveryType } } : {}),
    ...(Object.keys(parseHeaders(editor.headersText)).length > 0 ? { headers: parseHeaders(editor.headersText) } : {}),
    ...(editor.disableStrictTools ? { disableStrictTools: true } : {}),
    ...(editor.transport ? { transport: editor.transport } : {}),
    ...(editor.remoteCompactionEnabled || editor.remoteCompactionEndpoint || editor.remoteCompactionModel
      ? {
          remoteCompaction: {
            ...(editor.remoteCompactionEnabled ? { enabled: true } : {}),
            ...(editor.remoteCompactionEndpoint ? { endpoint: editor.remoteCompactionEndpoint } : {}),
            ...(editor.remoteCompactionModel ? { model: editor.remoteCompactionModel } : {}),
          },
        }
      : {}),
    models: editor.models,
    ...(Object.keys(editor.modelOverrides).length > 0 ? { modelOverrides: editor.modelOverrides } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readModelRoles(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainRecord(value) || !isPlainRecord(value.modelRoles)) return out;
  for (const [key, item] of Object.entries(value.modelRoles)) {
    if (typeof item === "string" && item.trim()) out[key] = item.trim();
  }
  return out;
}

function parseRoleSelector(selector: string): { primary: string; thinking?: string } {
  const idx = selector.lastIndexOf(":");
  if (idx > 0) {
    const suffix = selector.slice(idx + 1);
    if (MODEL_THINKING.some((item) => item.id === suffix)) {
      return { primary: selector.slice(0, idx), thinking: suffix };
    }
  }
  return { primary: selector };
}

export function applyRoleSelector(role: ModelRoleRecord, selector: string): ModelRoleRecord {
  const parsed = parseRoleSelector(selector);
  const { issue: _ignored, thinking: _thinking, ...rest } = role;
  return parsed.thinking
    ? { ...rest, primary: parsed.primary, thinking: parsed.thinking }
    : { ...rest, primary: parsed.primary };
}

export function assignedRoleIds(roles: ReadonlyArray<ModelRoleRecord>, selector: string): string[] {
  return roles.filter((role) => role.primary === selector).map((role) => role.id);
}

export function roleAssignDiff(picked: ReadonlyArray<string>, baseline: ReadonlyArray<string>): { added: string[]; removed: string[] } {
  const base = new Set(baseline);
  return {
    added: picked.filter((id) => !base.has(id)),
    removed: baseline.filter((id) => !picked.includes(id)),
  };
}

export function roleAssignModCount(
  picked: ReadonlyArray<string> | undefined,
  roles: ReadonlyArray<ModelRoleRecord>,
  selector: string,
): number {
  if (!picked) return 0;
  const { added, removed } = roleAssignDiff(picked, assignedRoleIds(roles, selector));
  return added.length + removed.length;
}

function nextRolePrimaries(
  roles: ReadonlyArray<ModelRoleRecord>,
  drafts: Record<string, ReadonlyArray<string>>,
): Map<string, string> {
  const current = new Map<string, string>();
  for (const role of roles) {
    if (role.primary) current.set(role.id, role.primary);
  }
  const next = new Map(current);
  for (const [selector, picked] of Object.entries(drafts)) {
    const pickedSet = new Set(picked);
    for (const [roleId, sel] of current) {
      if (sel === selector && !pickedSet.has(roleId) && next.get(roleId) === selector) next.delete(roleId);
    }
    for (const roleId of picked) next.set(roleId, selector);
  }
  return next;
}

export function rolePrimaryUpdates(
  roles: ReadonlyArray<ModelRoleRecord>,
  drafts: Record<string, ReadonlyArray<string>>,
): Array<{ role: ModelRoleRecord; selector: string }> {
  const next = nextRolePrimaries(roles, drafts);
  const out: Array<{ role: ModelRoleRecord; selector: string }> = [];
  for (const role of roles) {
    const selector = next.get(role.id) ?? "";
    if (selector !== (role.primary ?? "")) out.push({ role, selector });
  }
  return out;
}

export function withRolePrimaryUpdates(
  current: ModelConfigReadModel,
  updates: ReadonlyArray<{ role: ModelRoleRecord; selector: string }>,
): ModelConfigReadModel {
  const byId = new Map(updates.map((item) => [item.role.id, item.selector]));
  const models = current.availableModels;
  const nextRoles = current.roles.map((role) => {
    if (!byId.has(role.id)) return role;
    const selector = byId.get(role.id) ?? "";
    if (!selector) {
      const { issue: _ignored, thinking: _thinking, ...rest } = role;
      return { ...rest, primary: "" };
    }
    const model = models.find((item) => item.selector === selector);
    return withRoleModel(role, selector, model);
  });
  const generatedConfigYml = `modelRoles:\n${nextRoles
    .filter((role) => role.primary)
    .map((role) => `  ${role.id}: ${roleSelector(role)}`)
    .join("\n")}${nextRoles.some((role) => role.primary) ? "\n" : ""}`;
  return { ...current, roles: nextRoles, generatedConfigYml };
}
