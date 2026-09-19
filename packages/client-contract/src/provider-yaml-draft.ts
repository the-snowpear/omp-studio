/**
 * Provider editor draft → `models.yml` node mapping.
 *
 * This is the single source of truth for "what node does this form produce".
 * The renderer derives its live YAML card from it, and the Host writer
 * (`toYamlProvider` in `@omp-studio/host-client-api`) is pinned to it by the
 * parity test `provider-yaml-draft-parity.test.ts` — a change here fails that
 * test until the Host writer matches, so the card can never silently promise
 * something a save would drop.
 *
 * Two deliberate properties:
 * - Unknown keys already present on the node survive. The mapping only takes
 *   over the fields the form owns; anything a newer OMP wrote stays untouched.
 * - A secret the form does not carry is never invented. The generated document
 *   redacts a stored key to `"********"` (but leaves `!command` in clear), and
 *   the editor leaves its field empty in that case, so the placeholder — and
 *   after the Host's `restoreRedactedApiKeys`, the real credential — survives.
 */

import { parseModelThinkingEfforts } from "./model-thinking.js";
import type {
  ModelAuthType,
  ModelCatalogEntry,
  ModelCostMeta,
  ModelOverridePatch,
  ModelProviderRemoteCompaction,
} from "./read-models.js";
import { isModelEnvConfigName } from "./read-models.js";

/** OMP's wire names for the same provider API. Mirrors the Host alias table. */
const API_ALIASES: Record<string, string> = {
  "openai-codex": "openai-codex-responses",
  "azure-responses": "azure-openai-responses",
  "bedrock-converse": "bedrock-converse-stream",
  "google-generative": "google-generative-ai",
  "gemini-cli": "google-gemini-cli",
};

export type YamlNode = { [key: string]: unknown };

/** The subset of the provider editor draft the YAML node is derived from. */
export interface ProviderYamlDraft {
  id: string;
  name: string;
  website: string;
  note: string;
  api: string;
  endpointUrl: string;
  local: boolean;
  authType: string;
  apiKey: string;
  envName: string;
  command: string;
  discoveryType: string;
  discoveryTimeoutMs?: number | undefined;
  headersText: string;
  disableStrictTools: boolean;
  transport: "" | "pi-native";
  remoteCompactionEnabled: boolean;
  remoteCompactionEndpoint: string;
  remoteCompactionModel: string;
  models: ReadonlyArray<ModelCatalogEntry>;
  modelOverrides: Readonly<Record<string, ModelOverridePatch>>;
}

export function mapApiAlias(api: string | undefined): string {
  if (!api) return "openai-completions";
  return API_ALIASES[api] ?? api;
}

/** The provider's node already in `models.yml`, or `undefined` for a new one. */
export function nestedProviderYamlNode(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

export function envNameForProviderId(id: string): string {
  return `${id.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Shallow copy so callers can hand in a parsed document node without mutation. */
function copyNode(value: Record<string, unknown> | undefined): YamlNode {
  return { ...(value ?? {}) };
}

function nestedNode(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function parseHeaderLines(text: string): Record<string, string> {
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

function costNode(cost: ModelCostMeta | undefined, complete: boolean): Record<string, unknown> | undefined {
  if (!cost) return undefined;
  if (cost.input === undefined && cost.output === undefined && cost.cacheRead === undefined && cost.cacheWrite === undefined) {
    return undefined;
  }
  if (complete) {
    return {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    };
  }
  return {
    ...(cost.input === undefined ? {} : { input: cost.input }),
    ...(cost.output === undefined ? {} : { output: cost.output }),
    ...(cost.cacheRead === undefined ? {} : { cacheRead: cost.cacheRead }),
    ...(cost.cacheWrite === undefined ? {} : { cacheWrite: cost.cacheWrite }),
  };
}

function remoteCompactionNode(rc: ModelProviderRemoteCompaction | undefined): Record<string, unknown> | undefined {
  if (!rc) return undefined;
  const row: Record<string, unknown> = {};
  if (rc.enabled !== undefined) row.enabled = rc.enabled;
  if (rc.endpoint) row.endpoint = rc.endpoint;
  if (rc.model) row.model = rc.model;
  return Object.keys(row).length > 0 ? row : undefined;
}

function thinkingNode(
  efforts: ReadonlyArray<string> | undefined,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const parsed = parseModelThinkingEfforts(efforts);
  if (parsed.length === 0) return undefined;
  const out: Record<string, unknown> = {
    mode: typeof previous?.mode === "string" ? previous.mode : "effort",
    efforts: [...parsed],
  };
  if (previous?.defaultLevel !== undefined) out.defaultLevel = previous.defaultLevel;
  if (previous?.effortMap !== undefined) out.effortMap = previous.effortMap;
  if (previous?.supportsDisplay !== undefined) out.supportsDisplay = previous.supportsDisplay;
  return out;
}

/** One `models:` row. Only `custom` rows are written, matching the save path. */
function modelNode(model: ModelCatalogEntry, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = { id: model.id };
  if (model.name) row.name = model.name;
  if (model.api) row.api = mapApiAlias(model.api);
  if (model.baseUrl) row.baseUrl = model.baseUrl;
  if (model.contextWindow) row.contextWindow = model.contextWindow;
  if (model.maxTokens) row.maxTokens = model.maxTokens;
  if (model.reasoning !== undefined) row.reasoning = model.reasoning;
  if (model.image) row.input = ["text", "image"];
  if (model.tools === false) row.supportsTools = false;
  const cost = costNode(model.cost, true);
  if (cost) row.cost = cost;
  if (model.omitMaxOutputTokens) row.omitMaxOutputTokens = true;
  if (model.premiumMultiplier !== undefined) row.premiumMultiplier = model.premiumMultiplier;
  if (model.headers && Object.keys(model.headers).length > 0) row.headers = { ...model.headers };
  if (model.contextPromotionTarget) row.contextPromotionTarget = model.contextPromotionTarget;
  if (model.compactionModel) row.compactionModel = model.compactionModel;
  const rc = remoteCompactionNode(model.remoteCompaction);
  if (rc) row.remoteCompaction = rc;
  const thinking = thinkingNode(model.thinking, nestedNode(previous?.thinking));
  if (thinking) row.thinking = thinking;
  return row;
}

/** One `modelOverrides:` row, sparse like the Host writer. */
function overrideNode(override: ModelOverridePatch, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (override.name !== undefined) row.name = override.name;
  if (override.contextWindow !== undefined) row.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) row.maxTokens = override.maxTokens;
  if (override.reasoning !== undefined) row.reasoning = override.reasoning;
  if (override.tools !== undefined) row.supportsTools = override.tools;
  if (override.image === true) row.input = ["text", "image"];
  else if (override.image === false) row.input = ["text"];
  const cost = costNode(override.cost, false);
  if (cost) row.cost = cost;
  if (override.omitMaxOutputTokens !== undefined) row.omitMaxOutputTokens = override.omitMaxOutputTokens;
  if (override.premiumMultiplier !== undefined) row.premiumMultiplier = override.premiumMultiplier;
  if (override.headers && Object.keys(override.headers).length > 0) row.headers = { ...override.headers };
  if (override.contextPromotionTarget) row.contextPromotionTarget = override.contextPromotionTarget;
  if (override.compactionModel) row.compactionModel = override.compactionModel;
  const rc = remoteCompactionNode(override.remoteCompaction);
  if (rc) row.remoteCompaction = rc;
  const thinking = thinkingNode(override.thinking, nestedNode(previous?.thinking));
  if (thinking) row.thinking = thinking;
  return row;
}

function discoveryNode(draft: ProviderYamlDraft): Record<string, unknown> | undefined {
  const type = draft.discoveryType.trim();
  if (!type) return undefined;
  return {
    type,
    ...(draft.discoveryTimeoutMs === undefined ? {} : { timeoutMs: draft.discoveryTimeoutMs }),
  };
}

function remoteCompactionFromDraft(draft: ProviderYamlDraft): Record<string, unknown> | undefined {
  const endpoint = draft.remoteCompactionEndpoint.trim();
  const model = draft.remoteCompactionModel.trim();
  if (!draft.remoteCompactionEnabled && !endpoint && !model) return undefined;
  return {
    ...(draft.remoteCompactionEnabled ? { enabled: true } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
  };
}

/** True for the `"********"` redaction placeholder the generated document carries. */
function isRedactedApiKey(value: string): boolean {
  return /^\*{6,}$/.test(value);
}

/**
 * The provider's own credential, as the save path would write it. `previous` is
 * the node already in the file: a stored secret the form does not carry (the
 * editor shows an empty field for it) is left as is rather than blanked or
 * invented.
 *
 * `storedAuth` is the auth type the provider was loaded with. The generated
 * document redacts a stored key to `"********"` — except `!command` values,
 * which stay in clear — so the placeholder alone cannot tell a stored env name
 * from a plaintext key; `storedAuth` resolves that so the mapping can drop a
 * stale env name exactly like the Host writer does. Without it the placeholder
 * is kept, which matches a stored plaintext key (the common case).
 */
function apiKeyFromDraft(
  draft: ProviderYamlDraft,
  previous: string | undefined,
  storedAuth: ModelAuthType | string | undefined,
): { value?: string; remove?: boolean } {
  const secret = draft.apiKey.trim();
  const prior = previous?.trim() ? previous : undefined;
  const redacted = prior !== undefined && isRedactedApiKey(prior);
  const priorIsCommand = prior !== undefined && (prior.startsWith("!") || (redacted && storedAuth === "command"));
  const priorIsEnv =
    prior !== undefined &&
    !prior.startsWith("!") &&
    (isModelEnvConfigName(prior) || (redacted && storedAuth === "env"));
  switch (draft.authType) {
    case "none":
    case "oauth":
      return { remove: true };
    case "command": {
      const command = draft.command.trim();
      // A stored `!command` stays until a new one is typed; a credential
      // belonging to another auth mode is dropped so it is not re-read as a
      // command under this mode.
      if (!command) return priorIsCommand ? { remove: false } : { remove: true };
      return { value: command.startsWith("!") ? command : `!${command}` };
    }
    case "env": {
      const name = draft.envName.trim();
      return { value: name && isModelEnvConfigName(name) ? name : envNameForProviderId(draft.id.trim()) };
    }
    default: {
      if (secret) return { value: secret };
      // A leftover `!command` or env name would shadow a typed key later, so a
      // blank re-save drops it; a plain stored key (or its placeholder) stays.
      return priorIsCommand || priorIsEnv ? { remove: true } : { remove: false };
    }
  }
}

/**
 * Derive the `providers.<id>` node the save would write.
 *
 * `previous` is the node currently in `models.yml` (or `undefined` for a new
 * provider) and is treated as immutable — it is only read and shallow-copied.
 * Fields the form does not own are carried over untouched. `storedAuth` is the
 * provider's loaded auth type; see `apiKeyFromDraft`.
 */
export function draftProviderYamlNode(
  draft: ProviderYamlDraft,
  previous: Record<string, unknown> | undefined,
  storedAuth?: ModelAuthType | string,
): YamlNode {
  const next = copyNode(previous);

  if (draft.name) next.name = draft.name;
  if (draft.website) next.website = draft.website;
  else delete next.website;
  if (draft.note) next.note = draft.note;
  else delete next.note;
  if (draft.endpointUrl) next.baseUrl = draft.endpointUrl;
  else delete next.baseUrl;
  next.api = mapApiAlias(draft.api);
  delete next.enabled;
  if (draft.local) next.local = true;
  else delete next.local;

  const discovery = discoveryNode(draft);
  if (discovery) next.discovery = discovery;
  else delete next.discovery;

  // `auth: none|oauth` is written explicitly and removed under the credential
  // modes, so a stale `auth` never survives a mode switch.
  if (draft.authType === "none" || draft.authType === "oauth") next.auth = draft.authType;
  else delete next.auth;

  const previousKey = typeof next.apiKey === "string" ? next.apiKey : undefined;
  // Keep the credential the file already has when the form has nothing new to
  // say. After a successful save the provider list is re-read and the field
  // shows `"********"`, so blanking it here would misreport the written file.
  const key = apiKeyFromDraft(draft, previousKey, storedAuth);
  if (key.remove) delete next.apiKey;
  else if (key.value !== undefined) next.apiKey = key.value;

  const headers = parseHeaderLines(draft.headersText);
  if (Object.keys(headers).length > 0) next.headers = headers;
  else delete next.headers;

  if (draft.disableStrictTools) next.disableStrictTools = true;
  else delete next.disableStrictTools;

  if (draft.transport === "pi-native") next.transport = "pi-native";
  else delete next.transport;

  const rc = remoteCompactionFromDraft(draft);
  if (rc) next.remoteCompaction = rc;
  else delete next.remoteCompaction;

  const previousModels = Array.isArray(previous?.models) ? previous.models : [];
  next.models = draft.models
    .filter((model) => model.source === "custom")
    .map((model) => modelNode(model, previousModels.find((item): item is Record<string, unknown> => (
      isPlainRecord(item) && item.id === model.id
    ))));

  const overrides = draft.modelOverrides;
  if (!overrides || Object.keys(overrides).length === 0) {
    delete next.modelOverrides;
  } else {
    const previousOverrides = nestedNode(previous?.modelOverrides);
    const mapped: Record<string, unknown> = {};
    for (const [modelId, override] of Object.entries(overrides)) {
      const row = overrideNode(override, nestedNode(previousOverrides?.[modelId]));
      if (row) mapped[modelId] = row;
    }
    if (Object.keys(mapped).length > 0) next.modelOverrides = mapped;
    else delete next.modelOverrides;
  }

  return next;
}
