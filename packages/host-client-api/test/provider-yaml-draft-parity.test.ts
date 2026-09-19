import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  draftProviderYamlNode,
  type ModelCatalogEntry,
  type ModelOverridePatch,
  type ModelProviderUpsertInput,
  type ProviderYamlDraft,
} from "@omp-studio/client-contract";

import { toYamlProvider } from "../src/omp-models-adapter.js";
import type { YamlValue } from "../src/models-yml.js";

/**
 * Parity pin: the renderer's live models.yml card is derived with
 * `draftProviderYamlNode` (client-contract), while the save goes through the
 * Host's `toYamlProvider`. Both consume the same form draft, so they must
 * produce the same node — otherwise the card promises something the save
 * drops. The adapter below mirrors `providerUpsertFromDraft` in
 * apps/renderer/src/ModelConfigPage.tsx; if that function changes, change it
 * here too.
 */

function draft(overrides: Partial<ProviderYamlDraft> = {}): ProviderYamlDraft {
  return {
    id: "gateway",
    name: "Company Gateway",
    website: "",
    note: "",
    api: "openai-completions",
    endpointUrl: "https://gw.example.com/v1",
    local: false,
    authType: "api-key",
    apiKey: "",
    envName: "GATEWAY_API_KEY",
    command: "",
    discoveryType: "",
    headersText: "",
    disableStrictTools: false,
    transport: "",
    remoteCompactionEnabled: false,
    remoteCompactionEndpoint: "",
    remoteCompactionModel: "",
    models: [],
    modelOverrides: {},
    ...overrides,
  };
}

function parseHeaders(text: string): Record<string, string> {
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

function modelEntry(overrides: Partial<ModelCatalogEntry> & { id: string }): ModelCatalogEntry {
  return {
    name: overrides.id,
    selector: `gateway/${overrides.id}`,
    image: false,
    reasoning: false,
    tools: true,
    status: "available",
    source: "custom",
    ...overrides,
  };
}

/** Mirrors `providerUpsertFromDraft` in ModelConfigPage.tsx (explicit empties). */
function upsertFromDraft(editor: ProviderYamlDraft): ModelProviderUpsertInput {
  return {
    id: editor.id.trim(),
    name: editor.name.trim(),
    api: editor.api,
    endpointUrl: editor.endpointUrl,
    website: editor.website,
    note: editor.note,
    local: editor.local,
    enabled: true,
    auth: {
      type: editor.authType as ModelProviderUpsertInput["auth"]["type"],
      ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
      ...(editor.envName ? { envName: editor.envName } : {}),
      ...(editor.command ? { command: editor.command } : {}),
    },
    discovery: editor.discoveryType
      ? { type: editor.discoveryType, ...(editor.discoveryTimeoutMs === undefined ? {} : { timeoutMs: editor.discoveryTimeoutMs }) }
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
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      reasoning: model.reasoning,
      image: model.image,
      tools: model.tools,
      ...(model.cost ? { cost: model.cost } : {}),
      ...(model.api ? { api: model.api } : {}),
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.omitMaxOutputTokens ? { omitMaxOutputTokens: true } : {}),
      ...(model.premiumMultiplier === undefined ? {} : { premiumMultiplier: model.premiumMultiplier }),
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.contextPromotionTarget ? { contextPromotionTarget: model.contextPromotionTarget } : {}),
      ...(model.compactionModel ? { compactionModel: model.compactionModel } : {}),
      ...(model.remoteCompaction ? { remoteCompaction: model.remoteCompaction } : {}),
      ...(model.thinking && model.thinking.length > 0 ? { thinking: [...model.thinking] } : {}),
    })),
    modelOverrides: Object.keys(editor.modelOverrides).length > 0 ? editor.modelOverrides : null,
  };
}

interface ParityCase {
  readonly name: string;
  readonly draft: ProviderYamlDraft;
  readonly previous?: Record<string, YamlValue>;
  readonly hostPrevious?: Record<string, YamlValue>;
  readonly storedAuth?: string;
}

function expectParity(entry: ParityCase): void {
  const host = toYamlProvider(upsertFromDraft(entry.draft), entry.hostPrevious ?? entry.previous);
  const preview = draftProviderYamlNode(entry.draft, entry.previous, entry.storedAuth);
  assert.deepEqual(preview, host, `preview diverges from the Host writer: ${entry.name}`);
}

const BASE_PREVIOUS: Record<string, YamlValue> = {
  name: "Company Gateway",
  api: "openai-completions",
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-live",
  headers: { "X-Org-Id": "org-1" },
  futureField: "keep-me",
};

const CASES: ParityCase[] = [
  {
    name: "full field set",
    draft: draft({
      website: "https://corp.example",
      note: "primary",
      local: true,
      api: "openai-codex",
      headersText: "X-Org-Id: org-1",
      disableStrictTools: true,
      transport: "pi-native",
      discoveryType: "openai",
      discoveryTimeoutMs: 5000,
      remoteCompactionEnabled: true,
      remoteCompactionEndpoint: "https://compaction.example",
      remoteCompactionModel: "small",
    }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "clearing website/note/endpointUrl removes the keys",
    draft: draft({ website: "", note: "", endpointUrl: "" }),
    previous: { ...BASE_PREVIOUS, website: "https://corp.example", note: "keep?" },
  },
  {
    name: "auth none writes auth: none and drops the key",
    draft: draft({ authType: "none" }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "auth oauth writes auth: oauth and drops the key",
    draft: draft({ authType: "oauth" }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "api-key re-save removes a stale auth: oauth",
    draft: draft({ authType: "api-key", apiKey: "sk-new" }),
    previous: { ...BASE_PREVIOUS, auth: "oauth" },
  },
  {
    name: "api-key blank keeps a stored plaintext key",
    draft: draft(),
    previous: BASE_PREVIOUS,
  },
  {
    name: "api-key blank drops a stale command credential",
    draft: draft(),
    previous: { ...BASE_PREVIOUS, apiKey: "!op read op://key" },
  },
  {
    name: "api-key blank drops a stale env name",
    draft: draft(),
    previous: { ...BASE_PREVIOUS, apiKey: "GATEWAY_API_KEY" },
    storedAuth: "env",
  },
  {
    name: "api-key blank keeps a redacted placeholder for a stored plaintext key",
    draft: draft(),
    previous: { ...BASE_PREVIOUS, apiKey: "********" },
    storedAuth: "api-key",
  },
  {
    name: "api-key blank drops a redacted placeholder hiding an env name",
    // Host reads the real YAML while the preview sees the redacted read model.
    hostPrevious: { ...BASE_PREVIOUS, apiKey: "GATEWAY_KEY" },
    draft: draft(),
    previous: { ...BASE_PREVIOUS, apiKey: "********" },
    storedAuth: "env",
  },
  {
    name: "command typed replaces any stored credential",
    draft: draft({ authType: "command", command: "op read op://key" }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "command blank keeps a stored command",
    draft: draft({ authType: "command" }),
    previous: { ...BASE_PREVIOUS, apiKey: "!op read op://key" },
    storedAuth: "command",
  },
  {
    name: "command blank drops a stored plaintext key",
    draft: draft({ authType: "command" }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "env with a custom name",
    draft: draft({ authType: "env", envName: "CORP_GATEWAY_KEY" }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "env without a name falls back to the conventional one",
    draft: draft({ authType: "env", envName: "" }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "custom models with thinking carry the previous mode and effortMap",
    draft: draft({
      models: [
        modelEntry({ id: "kept", name: "Kept", contextWindow: 200_000, reasoning: true, image: true, tools: false, cost: { input: 1, output: 2 }, thinking: ["high"] }),
        modelEntry({ id: "catalog-only", source: "catalog" }),
      ],
    }),
    previous: {
      ...BASE_PREVIOUS,
      models: [{
        id: "kept",
        thinking: { mode: "budget", efforts: ["low"], effortMap: { low: 1000 } },
      }],
    },
  },
  {
    name: "model overrides are sparse and clearable",
    draft: draft({
      modelOverrides: {
        "glm-5": { name: "GLM-5 Override", tools: false, image: false, cost: { input: 3 }, thinking: ["low"] } satisfies ModelOverridePatch,
      },
    }),
    previous: BASE_PREVIOUS,
  },
  {
    name: "empty overrides clear the map",
    draft: draft({ modelOverrides: {} }),
    previous: { ...BASE_PREVIOUS, modelOverrides: { "glm-5": { name: "Old" } } },
  },
  {
    name: "cleared advanced fields are removed",
    draft: draft(),
    previous: {
      ...BASE_PREVIOUS,
      disableStrictTools: true,
      transport: "pi-native",
      discovery: { type: "openai" },
      remoteCompaction: { enabled: true },
      modelOverrides: { "glm-5": { name: "Old" } },
    },
  },
  {
    name: "a new provider starts from an empty node",
    draft: draft({ id: "acme", name: "Acme", endpointUrl: "https://acme.example/v1", headersText: "X-Org-Id: org-1" }),
  },
];

describe("draftProviderYamlNode parity with toYamlProvider", () => {
  for (const entry of CASES) {
    test(entry.name, () => expectParity(entry));
  }

  test("unknown keys survive on both sides", () => {
    const host = toYamlProvider(upsertFromDraft(draft({ name: "Renamed" })), BASE_PREVIOUS);
    const preview = draftProviderYamlNode(draft({ name: "Renamed" }), BASE_PREVIOUS);
    assert.equal(host.futureField, "keep-me");
    assert.equal(preview.futureField, "keep-me");
    assert.deepEqual(preview, host);
  });
});
