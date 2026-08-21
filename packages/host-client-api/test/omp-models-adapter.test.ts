import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clampRoleThinking,
  parseCacheThinkingEfforts,
  roleThinkingControl,
} from "@omp-studio/client-contract";
import {
  authProbeUrl,
  availableFromCacheModel,
  availableFromCatalogEntry,
  catalogEntryFromAvailable,
  createOmpModelsService,
  envNameForProvider,
  isEnvConfigName,
  isRetryableTestFailure,
  modelListRequest,
  networkErrorDetail,
  ollamaTagsUrl,
  parseDiscoveryModels,
  toYamlProvider,
  upsertYamlRecordEntry,
  upsertYamlStringList,
} from "../src/omp-models-adapter.js";
import { restoreRedactedApiKeys } from "../src/models-yml.js";

describe("upsertYamlRecordEntry", () => {
  test("updates an existing entry in block form", () => {
    const source = "modelRoles:\n  default: a/b\n  smol: c/d\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "x/y");
    assert.equal(out, "modelRoles:\n  default: x/y\n  smol: c/d\n");
  });

  test("inserts a missing entry in block form without rewriting siblings", () => {
    const source = "modelRoles:\n  default: a/b\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "smol", "c/d");
    assert.equal(out, "modelRoles:\n  default: a/b\n  smol: c/d\n");
  });

  test("updates an existing entry in inline map form", () => {
    const source = "modelRoles: { default: a/b, smol: c/d }\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "x/y");
    assert.equal(out, "modelRoles: { default: x/y, smol: c/d }\n");
  });

  test("inserts a missing entry in inline map form without duplicating the key", () => {
    const source = "modelRoles: { default: a/b }\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "smol", "c/d");
    assert.equal(out, "modelRoles: { default: a/b, smol: c/d }\n");
  });

  test("quotes an inline value that contains a colon (thinking selector)", () => {
    const source = "modelRoles: { default: a/b }\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "slow", "x/y:high");
    assert.equal(out, 'modelRoles: { default: a/b, slow: "x/y:high" }\n');
  });

  test("appends block form when the record is absent", () => {
    const source = "otherKey: true\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "a/b");
    assert.equal(out, "otherKey: true\nmodelRoles:\n  default: a/b\n");
  });

  test("preserves CRLF line endings", () => {
    const source = "modelRoles:\r\n  default: a/b\r\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "x/y");
    assert.equal(out, "modelRoles:\r\n  default: x/y\r\n");
  });
});

describe("toYamlProvider auth boundary", () => {
  test("drops a stale command credential when switching command -> api-key with a blank key", () => {
    const previous = { apiKey: "!op read op://dev/openai/api-key", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal("apiKey" in out, false);
  });

  test("drops a stale command credential when switching command -> oauth", () => {
    const previous = { apiKey: "!op read op://dev/openai/api-key", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "oauth" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal("apiKey" in out, false);
    assert.equal(out.auth, "oauth");
  });

  test("oauth save drops a leftover bearer so OAuth is not shadowed", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const out = toYamlProvider({ id: "p", name: "p", api: "openai-completions", auth: { type: "oauth" as const } }, previous);
    assert.equal("apiKey" in out, false);
    assert.equal(out.auth, "oauth");
  });

  test("writes env auth as an environment variable name, not a secret", () => {
    const out = toYamlProvider(
      { id: "openai", name: "OpenAI", api: "openai-completions", auth: { type: "env" as const, envName: "OPENAI_API_KEY" } },
      { apiKey: "sk-123" },
    );
    assert.equal(out.apiKey, "OPENAI_API_KEY");
    assert.equal("auth" in out, false);
  });

  test("env save falls back to the conventional name when envName is omitted", () => {
    const out = toYamlProvider(
      { id: "open-ai", name: "OpenAI", api: "openai-completions", auth: { type: "env" as const } },
      undefined,
    );
    assert.equal(out.apiKey, "OPEN_AI_API_KEY");
  });

  test("drops a stale env name when switching env -> api-key with a blank key", () => {
    const previous = { apiKey: "OPENAI_API_KEY", api: "openai-completions" };
    const out = toYamlProvider({ id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const } }, previous);
    assert.equal("apiKey" in out, false);
  });

  test("keeps a custom env name when re-saving env with the same envName", () => {
    const previous = { apiKey: "CUSTOM_PROVIDER_KEY", api: "openai-completions" };
    const out = toYamlProvider(
      { id: "openai", name: "OpenAI", api: "openai-completions", auth: { type: "env" as const, envName: "CUSTOM_PROVIDER_KEY" } },
      previous,
    );
    assert.equal(out.apiKey, "CUSTOM_PROVIDER_KEY");
  });

  test("none auth writes auth: none and drops credentials", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const out = toYamlProvider({ id: "ollama", name: "Ollama", api: "openai-completions", auth: { type: "none" as const } }, previous);
    assert.equal(out.auth, "none");
    assert.equal("apiKey" in out, false);
  });

  test("keeps the command credential when re-saving command without re-entering it", () => {
    const previous = { apiKey: "!op read op://dev/openai/api-key", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "command" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal(out.apiKey, "!op read op://dev/openai/api-key");
  });

  test("keeps an existing api key when re-saving api-key with a blank key", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal(out.apiKey, "sk-123");
  });

  test("clearSecret removes the stored key", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const, clearSecret: true } };
    const out = toYamlProvider(input, previous);
    assert.equal("apiKey" in out, false);
  });

  test("persists enabled: false and drops it when re-enabled", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const off = toYamlProvider({ id: "p", name: "p", api: "openai-completions", enabled: false, auth: { type: "api-key" } }, previous);
    assert.equal("enabled" in off, false);
    const on = toYamlProvider({ id: "p", name: "p", api: "openai-completions", enabled: true, auth: { type: "api-key" } }, off);
    assert.equal("enabled" in on, false);
  });

  test("serializes advanced fields (headers/disableStrictTools/transport/remoteCompaction)", () => {
    const input = {
      id: "p",
      name: "p",
      api: "openai-completions",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      headers: { "X-Org-Id": "org-1" },
      disableStrictTools: true,
      transport: "pi-native" as const,
      remoteCompaction: { enabled: true, model: "gpt-5-mini" },
    };
    const out = toYamlProvider(input, undefined);
    assert.deepEqual(out.headers, { "X-Org-Id": "org-1" });
    assert.equal(out.disableStrictTools, true);
    assert.equal(out.transport, "pi-native");
    assert.deepEqual(out.remoteCompaction, { enabled: true, model: "gpt-5-mini" });
  });

  test("serializes modelOverrides and custom model tools/cost", () => {
    const input = {
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      models: [
        {
          id: "custom-1",
          name: "Custom One",
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: true,
          image: true,
          tools: false,
          cost: { input: 1, output: 2 },
        },
      ],
      modelOverrides: {
        "claude-sonnet-4.5": {
          name: "Sonnet Corp",
          image: true,
          tools: true,
          cost: { input: 3, output: 15 },
        },
      },
    };
    const out = toYamlProvider(input, undefined);
    assert.deepEqual(out.models, [
      {
        id: "custom-1",
        name: "Custom One",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        input: ["text", "image"],
        supportsTools: false,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    assert.deepEqual(out.modelOverrides, {
      "claude-sonnet-4.5": {
        name: "Sonnet Corp",
        supportsTools: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15 },
      },
    });
  });

  test("serializes custom and override thinking.efforts", () => {
    const input = {
      id: "gateway",
      name: "Gateway",
      api: "openai-completions",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      models: [
        {
          id: "custom-reasoner",
          name: "Custom Reasoner",
          reasoning: true,
          thinking: ["max", "off", "low", "minimal"],
        },
      ],
      modelOverrides: {
        "catalog-1": {
          reasoning: true,
          thinking: ["high", "xhigh"],
        },
      },
    };
    const out = toYamlProvider(input, undefined);
    assert.deepEqual((out.models as Array<Record<string, unknown>>)[0]?.thinking, {
      mode: "effort",
      efforts: ["minimal", "low", "max"],
    });
    assert.deepEqual((out.modelOverrides as Record<string, Record<string, unknown>>)["catalog-1"]?.thinking, {
      mode: "effort",
      efforts: ["high", "xhigh"],
    });
  });

  test("clears modelOverrides when null", () => {
    const previous = {
      modelOverrides: { "claude-sonnet-4.5": { name: "Old" } },
      api: "anthropic-messages",
    };
    const input = {
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      auth: { type: "oauth" as const },
      modelOverrides: null,
    };
    const out = toYamlProvider(input, previous);
    assert.equal("modelOverrides" in out, false);
  });

  test("serializes custom model extras and override cache/headers", () => {
    const input = {
      id: "gateway",
      name: "Gateway",
      api: "openai-completions",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      models: [
        {
          id: "gpt-example",
          name: "GPT Example",
          api: "openai-responses",
          baseUrl: "https://example.internal/v1",
          omitMaxOutputTokens: true,
          premiumMultiplier: 1.5,
          headers: { "X-Model": "example" },
          contextPromotionTarget: "gateway/big",
          compactionModel: "gateway/small",
          remoteCompaction: { enabled: true, model: "gateway/small" },
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.4 },
        },
      ],
      modelOverrides: {
        "catalog-1": {
          omitMaxOutputTokens: false,
          cost: { cacheRead: 0.2, cacheWrite: 0.8 },
          headers: { "X-Team": "ops" },
        },
      },
    };
    const out = toYamlProvider(input, undefined);
    assert.equal((out.models as Array<Record<string, unknown>>)[0]?.omitMaxOutputTokens, true);
    assert.equal((out.models as Array<Record<string, unknown>>)[0]?.api, "openai-responses");
    assert.equal((out.models as Array<Record<string, unknown>>)[0]?.baseUrl, "https://example.internal/v1");
    assert.deepEqual((out.modelOverrides as Record<string, Record<string, unknown>>)["catalog-1"]?.cost, {
      cacheRead: 0.2,
      cacheWrite: 0.8,
    });
    assert.equal((out.modelOverrides as Record<string, Record<string, unknown>>)["catalog-1"]?.omitMaxOutputTokens, false);
  });

  test("writes name and drops empty baseUrl", () => {
    const named = toYamlProvider({
      id: "acme",
      name: "Acme Corp",
      website: "https://acme.example",
      note: "corp",
      api: "openai-completions",
      endpointUrl: "https://api.acme.test/v1",
      auth: { type: "api-key" as const },
    }, undefined);
    assert.equal(named.name, "Acme Corp");
    assert.equal(named.website, "https://acme.example");
    assert.equal(named.note, "corp");
    assert.equal(named.baseUrl, "https://api.acme.test/v1");
    const cleared = toYamlProvider({
      id: "acme",
      name: "Acme Corp",
      api: "openai-completions",
      endpointUrl: "",
      auth: { type: "api-key" as const },
    }, named);
    assert.equal("baseUrl" in cleared, false);
  });

  test("clears advanced fields when disabled/emptied", () => {
    const previous = {
      headers: { "X-Org-Id": "org-1" },
      disableStrictTools: true,
      transport: "pi-native",
      remoteCompaction: { enabled: true, model: "gpt-5-mini" },
    };
    const input = {
      id: "p",
      name: "p",
      api: "openai-completions",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      headers: {},
      disableStrictTools: false,
      transport: null,
      remoteCompaction: null,
    };
    const out = toYamlProvider(input, previous);
    assert.equal("headers" in out, false);
    assert.equal("disableStrictTools" in out, false);
    assert.equal("transport" in out, false);
    assert.equal("remoteCompaction" in out, false);
  });
});

describe("upsertYamlStringList", () => {
  test("replaces an existing block list", () => {
    const source = "cycleOrder:\n  - smol\n  - default\n  - slow\n";
    const out = upsertYamlStringList(source, "cycleOrder", ["default", "slow"]);
    assert.equal(out, "cycleOrder:\n  - default\n  - slow\n");
  });

  test("appends a missing list as block form", () => {
    const source = "modelRoles:\n  default: a/b\n";
    const out = upsertYamlStringList(source, "cycleOrder", ["smol", "slow"]);
    assert.equal(out, "modelRoles:\n  default: a/b\ncycleOrder:\n  - smol\n  - slow\n");
  });

  test("replaces an inline list with block form", () => {
    const source = "cycleOrder: [smol, default]\n";
    const out = upsertYamlStringList(source, "cycleOrder", ["slow"]);
    assert.equal(out, "cycleOrder:\n  - slow\n");
  });
});

describe("restoreRedactedApiKeys", () => {
  test("puts the previous apiKey back when the new document still has the placeholder", () => {
    const next = { providers: { acme: { api: "openai-completions", apiKey: "********" } } };
    const previous = { providers: { acme: { api: "openai-completions", apiKey: "sk-live" } } };
    restoreRedactedApiKeys(next, previous);
    assert.equal((next.providers.acme as { apiKey: string }).apiKey, "sk-live");
  });

  test("leaves an explicit new apiKey alone", () => {
    const next = { providers: { acme: { apiKey: "sk-new" } } };
    const previous = { providers: { acme: { apiKey: "sk-live" } } };
    restoreRedactedApiKeys(next, previous);
    assert.equal((next.providers.acme as { apiKey: string }).apiKey, "sk-new");
  });
});

// ---------- 测试连接（testProvider） ----------

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response> | never;

function stubFetch(handler: FetchHandler): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key] = value;
    }
    calls.push({ url, headers });
    return await handler(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function networkError(code: string | undefined, name = "fetch failed"): TypeError {
  const error = new TypeError(name);
  if (code !== undefined) {
    const cause = new Error(`network error ${code}`) as NodeJS.ErrnoException;
    cause.code = code;
    (error as { cause?: unknown }).cause = cause;
  }
  return error;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

describe("testProvider", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "omp-models-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function serviceWith(handler: FetchHandler) {
    const { fetch, calls } = stubFetch(handler);
    const service = createOmpModelsService({ fetch, agentDir: dir });
    return { service, calls };
  }

  test("no credentials: any HTTP response counts as reachable", async () => {
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 401 }));
    const result = await service.testProvider({ endpointUrl: "https://example.com/v1" });
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://example.com/v1");
    assert.equal(calls[0]?.headers.Accept, "*/*");
  });

  test("no credentials: network-level errors fail with classification", async () => {
    const { service, calls } = await serviceWith(async () => {
      throw networkError("ECONNREFUSED");
    });
    const result = await service.testProvider({ endpointUrl: "https://example.com" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /连接被拒绝/);
    assert.equal(calls.length, 1); // definitive errors are not retried
  });

  test("no credentials: DNS failure is classified", async () => {
    const { service } = await serviceWith(async () => {
      throw networkError("ENOTFOUND");
    });
    const result = await service.testProvider({ endpointUrl: "https://nope.invalid" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /域名无法解析/);
  });

  test("no credentials: timeout-class failure retries once", async () => {
    const { service, calls } = await serviceWith(async () => {
      throw abortError();
    });
    const result = await service.testProvider({ endpointUrl: "https://example.com" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /超时/);
    assert.equal(result.retryCount, 1);
    assert.equal(calls.length, 2);
  });

  test("with key: 2xx means credentials valid", async () => {
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    const result = await service.testProvider({
      endpointUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
      apiKey: "sk-123",
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /凭据有效/);
    assert.equal(result.httpStatus, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/models");
    assert.equal(calls[0]?.headers.Authorization, "Bearer sk-123");
  });

  test("with key: 401 means invalid credentials but endpoint reachable", async () => {
    const { service } = await serviceWith(async () => new Response(null, { status: 401 }));
    const result = await service.testProvider({
      endpointUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: "bad",
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /凭据无效/);
    assert.equal(result.httpStatus, 401);
  });

  test("with key: missing model-list endpoint degrades to reachability", async () => {
    let phase = 0;
    const { service, calls } = await serviceWith(async () => {
      phase += 1;
      return phase === 1 ? new Response(null, { status: 404 }) : new Response(null, { status: 200 });
    });
    const result = await service.testProvider({
      endpointUrl: "https://example.com",
      api: "openai-completions",
      apiKey: "sk",
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /模型列表接口不可用/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.url, "https://example.com");
  });

  test("anthropic probes /v1/models when base lacks /v1", async () => {
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    const result = await service.testProvider({
      endpointUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      apiKey: "sk",
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/models");
    assert.equal(calls[0]?.headers["x-api-key"], "sk");
  });

  test("anthropic keeps /models when base already ends with /v1", async () => {
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    await service.testProvider({
      endpointUrl: "https://api.anthropic.com/v1",
      api: "anthropic-messages",
      apiKey: "sk",
    });
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/models");
  });

  test("apis without a model-list endpoint fall back to reachability", async () => {
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    const result = await service.testProvider({
      endpointUrl: "https://bedrock.example.com",
      api: "bedrock-converse-stream",
      apiKey: "sk",
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, "https://bedrock.example.com");
  });

  test("providerId resolves saved config from models.yml", async () => {
    await writeFile(
      join(dir, "models.yml"),
      "providers:\n  p1:\n    api: openai-completions\n    baseUrl: https://example.com/v1\n    apiKey: sk-123\n",
      "utf8",
    );
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    const result = await service.testProvider({ providerId: "p1" });
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, "https://example.com/v1/models");
    assert.equal(calls[0]?.headers.Authorization, "Bearer sk-123");
  });

  test("external command credentials are not auto-tested", async () => {
    await writeFile(
      join(dir, "models.yml"),
      "providers:\n  p2:\n    api: openai-completions\n    baseUrl: https://example.com/v1\n    apiKey: \"!op read op://vault/item/key\"\n",
      "utf8",
    );
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    const result = await service.testProvider({ providerId: "p2" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /外部命令/);
    assert.equal(calls.length, 0);
  });

  test("missing base URL fails closed", async () => {
    const { service, calls } = await serviceWith(async () => new Response(null, { status: 200 }));
    const result = await service.testProvider({ api: "openai-completions" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /Base URL/);
    assert.equal(calls.length, 0);
  });
});

describe("authProbeUrl", () => {
  test("shapes model-list URL per wire api", () => {
    assert.equal(authProbeUrl("https://api.deepseek.com/v1", "openai-completions"), "https://api.deepseek.com/v1/models");
    assert.equal(authProbeUrl("https://x.ai/v1/", "openai-completions"), "https://x.ai/v1/models");
    assert.equal(authProbeUrl("https://api.anthropic.com", "anthropic-messages"), "https://api.anthropic.com/v1/models");
    assert.equal(authProbeUrl("https://api.anthropic.com/v1", "anthropic-messages"), "https://api.anthropic.com/v1/models");
    assert.equal(authProbeUrl("https://api.openai.com/v1", "openai-responses"), "https://api.openai.com/v1/models");
    assert.equal(authProbeUrl("https://bedrock.example.com", "bedrock-converse-stream"), undefined);
    assert.equal(authProbeUrl("https://gemini.example.com", "google-gemini-cli"), undefined);
  });
});

describe("networkErrorDetail", () => {
  test("classifies each failure class", () => {
    assert.equal(networkErrorDetail(abortError()), "连接失败：请求超时");
    assert.equal(networkErrorDetail(networkError("ENOTFOUND")), "连接失败：域名无法解析");
    assert.equal(networkErrorDetail(networkError("EAI_AGAIN")), "连接失败：域名无法解析");
    assert.equal(networkErrorDetail(networkError("ECONNREFUSED")), "连接失败：连接被拒绝");
    assert.equal(networkErrorDetail(networkError("ECONNRESET")), "连接失败：连接被重置");
    assert.equal(networkErrorDetail(networkError("CERT_HAS_EXPIRED")), "连接失败：TLS 证书错误");
    assert.equal(networkErrorDetail(networkError(undefined)), "连接失败：网络不可达");
  });
});

describe("isRetryableTestFailure", () => {
  test("only timeout-class jitter is retried", () => {
    assert.equal(isRetryableTestFailure(abortError()), true);
    assert.equal(isRetryableTestFailure(networkError(undefined)), true);
    assert.equal(isRetryableTestFailure(networkError("ECONNRESET")), true);
    assert.equal(isRetryableTestFailure(networkError("ENOTFOUND")), false);
    assert.equal(isRetryableTestFailure(networkError("ECONNREFUSED")), false);
  });
});

describe("parseCacheThinkingEfforts", () => {
  test("reads catalog thinking.efforts objects, not a string array", () => {
    assert.deepEqual(parseCacheThinkingEfforts({ efforts: ["low", "high", "max"] }), ["low", "high", "max"]);
    assert.deepEqual(parseCacheThinkingEfforts(["minimal", "low"]), ["minimal", "low"]);
    assert.deepEqual(parseCacheThinkingEfforts({ efforts: ["high", "nope", "off"] }), ["high"]);
    assert.deepEqual(parseCacheThinkingEfforts({ mode: "effort" }), []);
    assert.deepEqual(parseCacheThinkingEfforts(undefined), []);
  });
});

describe("availableFromCacheModel", () => {
  test("hydrates context window, reasoning, image and thinking from a catalog cache row", () => {
    const record = availableFromCacheModel({
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 64000,
      supportsTools: true,
      thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"] },
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    }, "anthropic");
    assert.equal(record?.selector, "anthropic/claude-sonnet-4.5");
    assert.equal(record?.contextWindow, 200000);
    assert.equal(record?.maxTokens, 64000);
    assert.equal(record?.reasoning, true);
    assert.equal(record?.image, true);
    assert.deepEqual(record?.thinking, ["low", "medium", "high", "max"]);
    const entry = catalogEntryFromAvailable(record!);
    assert.equal(entry.contextWindow, 200000);
    assert.equal(entry.source, "catalog");
    assert.equal(entry.reasoning, true);
  });

  test("skips null context windows and empty thinking objects", () => {
    const record = availableFromCacheModel({
      id: "local-chat",
      reasoning: false,
      input: ["text"],
      contextWindow: null,
      thinking: { mode: "effort" },
    }, "ollama");
    assert.equal(record?.selector, "ollama/local-chat");
    assert.equal(record?.contextWindow, undefined);
    assert.equal(record?.reasoning, false);
    assert.equal(record?.thinking, undefined);
  });
});

describe("role thinking control", () => {
  test("disables Off-only when the model does not reason", () => {
    const control = roleThinkingControl({ reasoning: false });
    assert.deepEqual(control.ids, ["off"]);
    assert.equal(control.disabled, true);
    assert.equal(clampRoleThinking("high", { reasoning: false }), undefined);
  });

  test("keeps the full ladder when reasoning has no controllable efforts", () => {
    const control = roleThinkingControl({ reasoning: true });
    assert.equal(control.disabled, false);
    assert.equal(control.ids.includes("xhigh"), true);
    assert.equal(clampRoleThinking("xhigh", { reasoning: true }), "xhigh");
  });

  test("clamps to the nearest legal effort on a sparse ladder", () => {
    const model = { reasoning: true, thinking: ["low", "high"] };
    assert.deepEqual(roleThinkingControl(model).ids, ["off", "low", "high"]);
    assert.equal(clampRoleThinking("xhigh", model), "high");
    assert.equal(clampRoleThinking("medium", model), "low");
    assert.equal(clampRoleThinking("minimal", model), "low");
    assert.equal(clampRoleThinking("off", model), undefined);
    assert.equal(clampRoleThinking("high", model), "high");
  });
});

describe("upsertProvider enabled / disabledProviders", () => {
  test("writes disabledProviders in config.yml and get() reflects the switch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-enabled-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers:\n  acme:\n    api: openai-completions\n    apiKey: sk-test\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const service = createOmpModelsService({ agentDir: dir });
      const before = await service.get();
      assert.equal(before.providers.find((item) => item.id === "acme")?.enabled, true);

      await service.upsertProvider({
        id: "acme",
        name: "Acme",
        api: "openai-completions",
        enabled: false,
        auth: { type: "api-key" },
        ...(before.contentHash ? { expectedHash: before.contentHash } : {}),
      });
      const config = await readFile(join(dir, "config.yml"), "utf8");
      assert.match(config, /disabledProviders:\n  - acme/);
      const models = await readFile(join(dir, "models.yml"), "utf8");
      assert.doesNotMatch(models, /enabled: false/);
      const disabled = await service.get();
      assert.equal(disabled.providers.find((item) => item.id === "acme")?.enabled, false);
      assert.equal(disabled.providers.find((item) => item.id === "acme")?.status, "disabled");

      await service.upsertProvider({
        id: "acme",
        name: "Acme",
        api: "openai-completions",
        enabled: true,
        auth: { type: "api-key" },
        ...(disabled.contentHash ? { expectedHash: disabled.contentHash } : {}),
      });
      const enabled = await service.get();
      assert.equal(enabled.providers.find((item) => item.id === "acme")?.enabled, true);
      const configAfter = await readFile(join(dir, "config.yml"), "utf8");
      assert.match(configAfter, /disabledProviders: \[\]/);
      const modelsAfter = await readFile(join(dir, "models.yml"), "utf8");
      assert.doesNotMatch(modelsAfter, /enabled: false/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("disables against a real-shaped config.yml with trailing spaces and no disabledProviders yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-enabled-real-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers:\n  sub2api-go:\n    api: openai-completions\n    apiKey: sk-test\n", "utf8");
      await writeFile(
        join(dir, "config.yml"),
        [
          "shellPath: D:\\Program Files\\Git\\bin\\bash.exe",
          "defaultProvider: sub2api-go",
          "modelRoles: ",
          "  default: sub2api-go/grok-4.6:xhigh",
          "task: ",
          "  agentModelOverrides: ",
          "    task: sub2api-go/deepseek-v4-flash:max",
          "theme: ",
          "  dark: titanium",
          "dev: ",
          "  autoqaConsent: granted",
        ].join("\n"),
        "utf8",
      );
      const service = createOmpModelsService({ agentDir: dir });
      const before = await service.get();
      await service.upsertProvider({
        id: "sub2api-go",
        name: "sub2api-go",
        api: "openai-completions",
        enabled: false,
        auth: { type: "api-key" },
        ...(before.contentHash ? { expectedHash: before.contentHash } : {}),
      });
      const after = await service.get();
      assert.equal(after.providers.find((item) => item.id === "sub2api-go")?.enabled, false);
      const config = await readFile(join(dir, "config.yml"), "utf8");
      assert.match(config, /disabledProviders:\n  - sub2api-go/);
      assert.match(config, /defaultProvider: sub2api-go/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("models.get availableModels thinking", () => {
  test("keeps models.yml thinking.efforts on the selector used by role rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-role-thinking-"));
    try {
      await writeFile(
        join(dir, "models.yml"),
        [
          "providers:",
          "  gateway:",
          "    api: openai-completions",
          "    models:",
          "    - id: flash",
          "      reasoning: true",
          "      thinking:",
          "        mode: effort",
          "        efforts:",
          "        - high",
          "        - max",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(dir, "config.yml"), "modelRoles:\n  default: gateway/flash:high\n", "utf8");
      const snapshot = await createOmpModelsService({ agentDir: dir }).get();
      const available = snapshot.availableModels.find((model) => model.selector === "gateway/flash");
      assert.equal(available?.reasoning, true);
      assert.deepEqual(available?.thinking, ["high", "max"]);
      const catalog = snapshot.providers[0]?.models.find((model) => model.id === "flash");
      assert.deepEqual(catalog?.thinking, ["high", "max"]);
      const roundTrip = availableFromCatalogEntry("gateway", catalog!);
      assert.deepEqual(roundTrip.thinking, ["high", "max"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseDiscoveryModels", () => {
  test("reads Ollama tags and OpenAI data lists", () => {
    assert.deepEqual(
      parseDiscoveryModels({ models: [{ name: "qwen2.5:latest" }, { name: "llama3.2" }] }).map((item) => item.id),
      ["qwen2.5:latest", "llama3.2"],
    );
    assert.deepEqual(
      parseDiscoveryModels({ data: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }] }).map((item) => item.id),
      ["gpt-4.1", "gpt-4.1-mini"],
    );
  });

  test("keeps metadata absent when the endpoint reports none", () => {
    assert.deepEqual(parseDiscoveryModels({ data: [{ id: "gpt-4.1" }] }), [{ id: "gpt-4.1", name: "gpt-4.1" }]);
  });

  test("extracts OpenAI-compatible context and output limits", () => {
    const [model] = parseDiscoveryModels({
      data: [{
        id: "acme/big",
        context_length: 1_000_000,
        top_provider: { max_completion_tokens: 64_000 },
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["reasoning", "tools"],
      }],
    });
    assert.equal(model?.contextWindow, 1_000_000);
    assert.equal(model?.maxTokens, 64_000);
    assert.equal(model?.image, true);
    assert.equal(model?.reasoning, true);
  });

  test("reads vLLM max_model_len and text-only modality", () => {
    const [model] = parseDiscoveryModels({ data: [{ id: "local", max_model_len: "32768", input_modalities: ["text"] }] });
    assert.equal(model?.contextWindow, 32_768);
    assert.equal(model?.image, false);
    assert.equal(model?.maxTokens, undefined);
  });

  test("uses the Anthropic display_name as the label", () => {
    const [model] = parseDiscoveryModels({ data: [{ id: "claude-opus-4-5", display_name: "Claude Opus 4.5" }] });
    assert.equal(model?.id, "claude-opus-4-5");
    assert.equal(model?.name, "Claude Opus 4.5");
  });

  test("strips the Google models/ prefix and maps token limits", () => {
    const [model] = parseDiscoveryModels({
      models: [{ name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }],
    });
    assert.equal(model?.id, "gemini-3-pro");
    assert.equal(model?.name, "Gemini 3 Pro");
    assert.equal(model?.contextWindow, 1_048_576);
    assert.equal(model?.maxTokens, 65_536);
  });

  test("reads Ollama thinking capability", () => {
    const [model] = parseDiscoveryModels({ models: [{ name: "qwen3:32b", capabilities: ["completion", "thinking"] }] });
    assert.equal(model?.reasoning, true);
  });

  test("ignores non-positive and unparsable limits", () => {
    const [model] = parseDiscoveryModels({ data: [{ id: "x", context_length: 0, max_output_tokens: "n/a" }] });
    assert.equal(model?.contextWindow, undefined);
    assert.equal(model?.maxTokens, undefined);
  });
});

describe("modelListRequest", () => {
  test("openai-compatible bases try /models then the /v1 variant", () => {
    assert.deepEqual(modelListRequest("https://acme.test", "openai-completions").urls, [
      "https://acme.test/models",
      "https://acme.test/v1/models",
    ]);
    assert.deepEqual(modelListRequest("https://acme.test/v1", "openai-completions").urls, [
      "https://acme.test/v1/models",
    ]);
  });

  test("anthropic uses x-api-key with an explicit api version", () => {
    const request = modelListRequest("https://api.anthropic.com", "anthropic-messages", "sk");
    assert.deepEqual(request.urls, ["https://api.anthropic.com/v1/models"]);
    assert.equal(request.headers["x-api-key"], "sk");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers.Authorization, undefined);
  });

  test("google apis use x-goog-api-key", () => {
    const request = modelListRequest("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai", "key");
    assert.equal(request.headers["x-goog-api-key"], "key");
    assert.equal(request.headers.Authorization, undefined);
  });

  test("apis without a model-list surface yield no urls", () => {
    assert.deepEqual(modelListRequest("https://bedrock.test", "bedrock-converse-stream", "sk").urls, []);
    assert.deepEqual(modelListRequest("https://gemini.test", "google-gemini-cli").urls, []);
  });
});

describe("envNameForProvider", () => {
  test("maps provider id to conventional API key env", () => {
    assert.equal(envNameForProvider("open-ai"), "OPEN_AI_API_KEY");
    assert.equal(envNameForProvider("ollama"), "OLLAMA_API_KEY");
  });

  test("classifies env names vs literal keys", () => {
    assert.equal(isEnvConfigName("OPENAI_API_KEY"), true);
    assert.equal(isEnvConfigName("ACME_TOKEN"), true);
    assert.equal(isEnvConfigName("sk-proj-abc"), false);
    assert.equal(isEnvConfigName("!op read op://vault/key"), false);
  });
});

describe("P1/P2 model-config adapter surfaces", () => {
  async function withAgentDir<T>(run: (dir: string, service: ReturnType<typeof createOmpModelsService>) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-p1p2-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers: {}\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      return await run(dir, createOmpModelsService({ agentDir: dir }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("env auth stays authenticated when the conventional env var is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-env-"));
    const key = envNameForProvider("acme");
    const previous = process.env[key];
    try {
      process.env[key] = "sk-from-env";
      await writeFile(join(dir, "models.yml"), "providers:\n  acme:\n    api: openai-completions\n    name: Acme\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const snapshot = await createOmpModelsService({ agentDir: dir }).get();
      const acme = snapshot.providers.find((item) => item.id === "acme");
      assert.equal(acme?.auth.type, "env");
      assert.equal(acme?.auth.hasSecret, true);
      assert.equal(acme?.auth.envName, key);
      assert.notEqual(acme?.status, "not-authenticated");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit env name round-trips through upsert and get", async () => {
    await withAgentDir(async (dir, service) => {
      await service.upsertProvider({
        id: "acme",
        name: "Acme",
        api: "openai-completions",
        auth: { type: "env", envName: "ACME_TOKEN" },
      });
      const yaml = await readFile(join(dir, "models.yml"), "utf8");
      assert.match(yaml, /apiKey: ACME_TOKEN/);
      assert.doesNotMatch(yaml, /auth:/);
      const snapshot = await service.get();
      const acme = snapshot.providers.find((item) => item.id === "acme");
      assert.equal(acme?.auth.type, "env");
      assert.equal(acme?.auth.envName, "ACME_TOKEN");
      assert.equal(acme?.auth.apiKey, undefined);
    });
  });

  test("name round-trips and empty baseUrl is omitted from yaml", async () => {
    await withAgentDir(async (dir, service) => {
      await service.upsertProvider({
        id: "acme",
        name: "Acme Corp",
        api: "openai-completions",
        endpointUrl: "https://api.acme.test/v1",
        auth: { type: "api-key", apiKey: "sk-test" },
      });
      const named = await service.get();
      assert.equal(named.providers.find((item) => item.id === "acme")?.name, "Acme Corp");
      await service.upsertProvider({
        id: "acme",
        name: "Acme Corp",
        api: "openai-completions",
        endpointUrl: "",
        auth: { type: "api-key" },
        ...(named.contentHash ? { expectedHash: named.contentHash } : {}),
      });
      const yaml = await readFile(join(dir, "models.yml"), "utf8");
      assert.doesNotMatch(yaml, /baseUrl:/);
      assert.match(yaml, /name: Acme Corp/);
    });
  });

  test("setEnabled only touches disabledProviders", async () => {
    await withAgentDir(async (dir, service) => {
      await service.upsertProvider({
        id: "acme",
        name: "Acme",
        api: "openai-completions",
        auth: { type: "api-key", apiKey: "sk-test" },
      });
      const before = await readFile(join(dir, "models.yml"), "utf8");
      await service.setProviderEnabled({ id: "acme", enabled: false });
      const after = await readFile(join(dir, "models.yml"), "utf8");
      assert.equal(after, before);
      const config = await readFile(join(dir, "config.yml"), "utf8");
      assert.match(config, /disabledProviders:\n  - acme/);
      const snapshot = await service.get();
      assert.equal(snapshot.providers.find((item) => item.id === "acme")?.enabled, false);
    });
  });

  test("thinking from models.db does not leak across providers with the same model id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-think-"));
    try {
      await writeFile(
        join(dir, "models.yml"),
        [
          "providers:",
          "  openai:",
          "    api: openai-completions",
          "    models:",
          "    - id: shared",
          "      name: Shared",
          "  anthropic:",
          "    api: anthropic-messages",
          "    models:",
          "    - id: shared",
          "      name: Shared",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(dir, "models.db"));
      db.exec("CREATE TABLE model_cache (provider_id TEXT, models TEXT, authoritative INTEGER)");
      db.prepare("INSERT INTO model_cache (provider_id, models, authoritative) VALUES (?, ?, 1)").run(
        "openai",
        JSON.stringify([{ id: "shared", provider: "openai", reasoning: true, thinking: { efforts: ["low"] } }]),
      );
      db.prepare("INSERT INTO model_cache (provider_id, models, authoritative) VALUES (?, ?, 1)").run(
        "anthropic",
        JSON.stringify([{ id: "shared", provider: "anthropic", reasoning: true, thinking: { efforts: ["max"] } }]),
      );
      db.close();
      const snapshot = await createOmpModelsService({ agentDir: dir }).get();
      assert.deepEqual(snapshot.availableModels.find((item) => item.selector === "openai/shared")?.thinking, ["low"]);
      assert.deepEqual(snapshot.availableModels.find((item) => item.selector === "anthropic/shared")?.thinking, ["max"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not surface cache-only catalog providers that are absent from models.yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-cache-only-"));
    try {
      await writeFile(
        join(dir, "models.yml"),
        [
          "providers:",
          "  gateway:",
          "    api: openai-completions",
          "    models:",
          "    - id: flash",
          "      name: Flash",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(dir, "models.db"));
      db.exec("CREATE TABLE model_cache (provider_id TEXT, models TEXT, authoritative INTEGER)");
      db.prepare("INSERT INTO model_cache (provider_id, models, authoritative) VALUES (?, ?, 1)").run(
        "gateway",
        JSON.stringify([
          { id: "flash", provider: "gateway", name: "Flash", reasoning: true, thinking: { efforts: ["high"] } },
          { id: "pro", provider: "gateway", name: "Pro" },
        ]),
      );
      db.prepare("INSERT INTO model_cache (provider_id, models, authoritative) VALUES (?, ?, 1)").run(
        "zenmux",
        JSON.stringify([{ id: "claude-sonnet-4", provider: "zenmux", name: "Claude Sonnet 4" }]),
      );
      db.close();
      const snapshot = await createOmpModelsService({ agentDir: dir }).get();
      assert.deepEqual(
        snapshot.providers.map((item) => item.id),
        ["gateway"],
      );
      assert.equal(
        snapshot.availableModels.some((item) => item.provider === "zenmux" || item.selector.startsWith("zenmux/")),
        false,
      );
      assert.equal(snapshot.availableModels.some((item) => item.selector === "gateway/flash"), true);
      assert.equal(snapshot.availableModels.some((item) => item.selector === "gateway/pro"), true);
      assert.deepEqual(snapshot.availableModels.find((item) => item.selector === "gateway/flash")?.thinking, ["high"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps OAuth-authenticated cache providers that are absent from models.yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-authed-cache-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers:\n  gateway:\n    api: openai-completions\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const { DatabaseSync } = await import("node:sqlite");
      const modelsDb = new DatabaseSync(join(dir, "models.db"));
      modelsDb.exec("CREATE TABLE model_cache (provider_id TEXT, models TEXT, authoritative INTEGER)");
      modelsDb.prepare("INSERT INTO model_cache (provider_id, models, authoritative) VALUES (?, ?, 1)").run(
        "zenmux",
        JSON.stringify([{ id: "claude-sonnet-4", provider: "zenmux", name: "Claude Sonnet 4" }]),
      );
      modelsDb.prepare("INSERT INTO model_cache (provider_id, models, authoritative) VALUES (?, ?, 1)").run(
        "opencode-go:models-v1:testfp",
        JSON.stringify([{ id: "glm-5", provider: "opencode-go", name: "GLM 5" }]),
      );
      modelsDb.close();
      const authDb = new DatabaseSync(join(dir, "agent.db"));
      authDb.exec("CREATE TABLE auth_credentials (provider TEXT, disabled_cause TEXT, updated_at INTEGER)");
      authDb.prepare("INSERT INTO auth_credentials (provider, disabled_cause) VALUES (?, NULL)").run("opencode-go");
      authDb.close();
      const snapshot = await createOmpModelsService({ agentDir: dir }).get();
      assert.deepEqual(
        snapshot.providers.map((item) => item.id).sort(),
        ["gateway", "opencode-go"],
      );
      assert.equal(snapshot.availableModels.some((item) => item.selector === "opencode-go/glm-5"), true);
      assert.equal(
        snapshot.availableModels.some((item) => item.provider === "zenmux" || item.selector.startsWith("zenmux/")),
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("probe parses Ollama tags and does not write models.db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-probe-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers:\n  ollama:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:11434/v1\n    discovery:\n      type: ollama\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const calls: string[] = [];
      const service = createOmpModelsService({
        agentDir: dir,
        fetch: (async (input) => {
          calls.push(String(input));
          return new Response(JSON.stringify({ models: [{ name: "qwen2.5" }, { name: "llama3.2" }] }), { status: 200 });
        }) as typeof fetch,
      });
      const before = await readFile(join(dir, "models.yml"), "utf8");
      const result = await service.probeProvider({ providerId: "ollama" });
      assert.equal(result.ok, true);
      assert.equal(result.found, 2);
      assert.deepEqual(result.models.map((item) => item.id), ["qwen2.5", "llama3.2"]);
      assert.equal(calls[0], ollamaTagsUrl("http://127.0.0.1:11434/v1"));
      assert.equal(await readFile(join(dir, "models.yml"), "utf8"), before);
      assert.equal(await readFile(join(dir, "models.db"), "utf8").then(() => "exists").catch(() => "missing"), "missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("probe without a discovery type fetches the wire API model list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-probe-api-"));
    try {
      await writeFile(
        join(dir, "models.yml"),
        "providers:\n  gateway:\n    api: openai-completions\n    baseUrl: \"https://gw.test/v1\"\n    apiKey: sk-gateway\n",
        "utf8",
      );
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const service = createOmpModelsService({
        agentDir: dir,
        fetch: (async (input, init?: RequestInit) => {
          calls.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
          return new Response(
            JSON.stringify({ data: [{ id: "glm-5", context_length: 200_000 }] }),
            { status: 200 },
          );
        }) as typeof fetch,
      });
      const before = await readFile(join(dir, "models.yml"), "utf8");
      const result = await service.probeProvider({ providerId: "gateway", headers: { "X-Org-Id": "org-1" } });
      assert.equal(result.ok, true);
      assert.deepEqual(result.models, [{ id: "glm-5", name: "glm-5", contextWindow: 200_000 }]);
      assert.equal(calls[0]?.url, "https://gw.test/v1/models");
      assert.equal(calls[0]?.headers.Authorization, "Bearer sk-gateway");
      assert.equal(calls[0]?.headers["X-Org-Id"], "org-1");
      assert.equal(await readFile(join(dir, "models.yml"), "utf8"), before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("probe honors the request api over models.yml and never lets headers shadow auth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-probe-anthropic-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers: {}\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const service = createOmpModelsService({
        agentDir: dir,
        fetch: (async (input, init?: RequestInit) => {
          calls.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
          return new Response(JSON.stringify({ data: [{ id: "claude-opus-4-5", display_name: "Claude Opus 4.5" }] }), { status: 200 });
        }) as typeof fetch,
      });
      const result = await service.probeProvider({
        providerId: "proxy",
        api: "anthropic-messages",
        endpointUrl: "https://proxy.test",
        apiKey: "sk-live",
        headers: { "x-api-key": "attacker", "anthropic-version": "1999-01-01" },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.models, [{ id: "claude-opus-4-5", name: "Claude Opus 4.5" }]);
      assert.equal(calls[0]?.url, "https://proxy.test/v1/models");
      assert.equal(calls[0]?.headers["x-api-key"], "sk-live");
      assert.equal(calls[0]?.headers["anthropic-version"], "2023-06-01");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("probe reports command credentials and apis without a model list instead of firing blind requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-probe-guard-"));
    try {
      await writeFile(
        join(dir, "models.yml"),
        "providers:\n  vault:\n    api: openai-completions\n    baseUrl: \"https://vault.test/v1\"\n    apiKey: \"!op read op://dev/key\"\n",
        "utf8",
      );
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      let calls = 0;
      const service = createOmpModelsService({
        agentDir: dir,
        fetch: (async () => {
          calls += 1;
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      });
      const command = await service.probeProvider({ providerId: "vault" });
      assert.equal(command.ok, false);
      assert.match(command.detail, /外部命令取凭据/);
      const noList = await service.probeProvider({
        providerId: "bedrock",
        api: "bedrock-converse-stream",
        endpointUrl: "https://bedrock.test",
      });
      assert.equal(noList.ok, false);
      assert.match(noList.detail, /没有模型列表接口/);
      assert.equal(calls, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("probe surfaces invalid credentials distinctly from a plain failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-probe-401-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers: {}\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const service = createOmpModelsService({
        agentDir: dir,
        fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
      });
      const result = await service.probeProvider({
        providerId: "gateway",
        api: "openai-completions",
        endpointUrl: "https://gw.test/v1",
        apiKey: "bad",
      });
      assert.equal(result.ok, false);
      assert.equal(result.httpStatus, 401);
      assert.match(result.detail, /凭据无效/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("custom roles, writeRoles deletes, project storage needs cwd", async () => {
    await withAgentDir(async (dir, service) => {
      await service.createRole({ id: "review", name: "Review", desc: "custom" });
      const created = await readFile(join(dir, "config.yml"), "utf8");
      assert.match(created, /modelTags:/);
      assert.match(created, /review:/);
      await service.setRole({ roleId: "review", selector: "acme/fast" });
      await service.writeRoles({ roles: { default: "acme/fast" } });
      const snapshot = await service.get();
      assert.equal(snapshot.roles.find((role) => role.id === "default")?.primary, "acme/fast");
      assert.equal(snapshot.roles.find((role) => role.id === "review")?.primary, "");
      await assert.rejects(
        async () => {
          await service.setRoleStorage({ storage: "project" });
        },
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "UNAVAILABLE");
          return true;
        },
      );
    });
  });

  test("project role storage writes cwd .omp/config.yml when a workspace exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-project-"));
    const cwd = await mkdtemp(join(tmpdir(), "omp-models-cwd-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers: {}\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles:\n  default: acme/fast\n", "utf8");
      const service = createOmpModelsService({ agentDir: dir, getCwd: () => cwd });
      await service.setRoleStorage({ storage: "project" });
      await service.setRole({ roleId: "default", selector: "acme/slow" });
      const project = await readFile(join(cwd, ".omp", "config.yml"), "utf8");
      assert.match(project, /acme\/slow/);
      const snapshot = await service.get();
      assert.equal(snapshot.modelRoleStorage, "project");
      assert.equal(snapshot.projectScopeAvailable, true);
      assert.equal(snapshot.roles.find((role) => role.id === "default")?.scope, "project");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("fallback chains and modelProviderOrder persist", async () => {
    await withAgentDir(async (dir, service) => {
      await service.setFallback({
        chains: { "acme/fast": ["acme/slow"] },
        revertPolicy: "never",
      });
      await service.setProviderOrder({ order: ["anthropic", "openai"] });
      const snapshot = await service.get();
      assert.deepEqual(snapshot.fallbackChains["acme/fast"], ["acme/slow"]);
      assert.equal(snapshot.fallbackRevertPolicy, "never");
      assert.deepEqual(snapshot.modelProviderOrder, ["anthropic", "openai"]);
      const config = await readFile(join(dir, "config.yml"), "utf8");
      assert.match(config, /fallbackRevertPolicy: never/);
      assert.match(config, /modelProviderOrder:/);
    });
  });

  test("logout does not return secrets and authenticated follows auth sqlite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-auth-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers: {}\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(dir, "agent.db"));
      db.exec("CREATE TABLE auth_credentials (provider TEXT, disabled_cause TEXT, updated_at INTEGER, secret TEXT)");
      db.prepare("INSERT INTO auth_credentials (provider, disabled_cause, secret) VALUES (?, NULL, ?)").run("anthropic", "sk-should-not-leak");
      db.close();
      const service = createOmpModelsService({ agentDir: dir });
      const before = await service.get();
      assert.equal(before.loginProviders.find((item) => item.id === "anthropic")?.authenticated, true);
      const result = await service.logout({ providerId: "anthropic" });
      assert.equal(result.applied, true);
      assert.equal(JSON.stringify(result).includes("sk-should-not-leak"), false);
      const after = await service.get();
      assert.equal(after.loginProviders.find((item) => item.id === "anthropic")?.authenticated, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("provider presets", () => {
  test("xAI paid API preset uses OpenAI Responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-models-xai-preset-"));
    try {
      await writeFile(join(dir, "models.yml"), "providers: {}\n", "utf8");
      await writeFile(join(dir, "config.yml"), "modelRoles: {}\n", "utf8");
      const service = createOmpModelsService({ agentDir: dir });
      const model = await service.get();
      const xai = model.presets.flatMap((group) => [...group.items]).find((item) => item.id === "xai");
      assert.equal(xai?.api, "openai-responses");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
