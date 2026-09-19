import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "@omp-studio/client-contract";

import { extractYamlMapEntry, mergeYamlMapEntry, parseStructured } from "../structured-editor";
import type { ProviderYamlDraft } from "./providerYaml";
import { draftProviderYamlNode, serializeModelsYmlNode } from "./providerYaml";

/**
 * The provider editor derives its models.yml card from the form draft. These
 * tests pin that mapping against the Host writer's shape (`toYamlProvider`) so
 * the card cannot promise something a save would drop.
 */

const SOURCE = `providers:
  gateway:
    name: Company Gateway
    api: openai-completions
    baseUrl: "https://gw.example.com/v1"
    apiKey: sk-live
    headers:
      X-Org-Id: org-1
    futureField: keep-me
`;

function model(overrides: Partial<ModelCatalogEntry> & { id: string }): ModelCatalogEntry {
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
    headersText: "X-Org-Id: org-1",
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

/** Exactly what ModelConfigPage renders: the derived slice for that provider. */
function derivedSlice(form: ProviderYamlDraft, source = SOURCE, id = "gateway", storedAuth?: string): string {
  const node = parseStructured("yaml", source, false);
  const providers = node.ok ? (node.value as { providers?: Record<string, unknown> }).providers : undefined;
  const merged = mergeYamlMapEntry(source, ["providers", id], serializeModelsYmlNode({
    [id]: draftProviderYamlNode(form, providers?.[id] as Record<string, unknown> | undefined, storedAuth),
  }));
  if (!merged.ok) throw new Error(merged.message);
  return extractYamlMapEntry(merged.text, ["providers", id], {});
}

function derivedNode(form: ProviderYamlDraft, source = SOURCE, id = "gateway", storedAuth?: string): Record<string, unknown> {
  const parsed = parseStructured("yaml", derivedSlice(form, source, id, storedAuth), false);
  if (!parsed.ok) throw new Error(parsed.message);
  return (parsed.value as Record<string, unknown>)[id] as Record<string, unknown>;
}

describe("供应商表单 → models.yml 派生", () => {
  it.each(["123", "1e3", "~", "[a]", "{a: b}", "- entry", "null", "!command"])("保留字符串 %s 的类型", (value) => {
    const node = derivedNode(draft({ name: value, models: [model({ id: value })] }));
    expect(node.name).toBe(value);
    expect((node.models as Array<{ id: string }>)[0]?.id).toBe(value);
  });

  it("完整保留特殊 YAML 键和未知嵌套节点", () => {
    const node = { "a: b": { "#key": "123", values: [["~", "[a]"]] } };
    const parsed = parseStructured("yaml", serializeModelsYmlNode(node), false);
    expect(parsed).toEqual({ ok: true, value: node });
  });

  it("把基座地址、名称与 API 别名写进节点", () => {
    const node = derivedNode(draft({ name: "Acme Gateway", endpointUrl: "https://acme.test/v1", api: "openai-codex" }));
    expect(node.name).toBe("Acme Gateway");
    expect(node.baseUrl).toBe("https://acme.test/v1");
    expect(node.api).toBe("openai-codex-responses");
  });

  it("清空的选填字段从节点里移除", () => {
    const node = derivedNode(draft({ website: "", note: "", headersText: "", local: false }));
    expect(node).not.toHaveProperty("website");
    expect(node).not.toHaveProperty("note");
    expect(node).not.toHaveProperty("headers");
    expect(node).not.toHaveProperty("local");
  });

  it("保留表单没有接管的字段", () => {
    expect(derivedNode(draft({ name: "Renamed" })).futureField).toBe("keep-me");
  });

  it("高级开关按写入语义落盘", () => {
    const node = derivedNode(draft({
      disableStrictTools: true,
      transport: "pi-native",
      discoveryType: "openai",
      discoveryTimeoutMs: 5000,
      remoteCompactionEnabled: true,
      remoteCompactionEndpoint: "https://compaction.test",
      remoteCompactionModel: "small",
    }));
    expect(node.disableStrictTools).toBe(true);
    expect(node.transport).toBe("pi-native");
    expect(node.discovery).toEqual({ type: "openai", timeoutMs: 5000 });
    expect(node.remoteCompaction).toEqual({ enabled: true, endpoint: "https://compaction.test", model: "small" });
    expect(derivedNode(draft()).transport).toBeUndefined();
  });

  it("自定义模型映射成 models 行，目录模型不重复写入", () => {
    const node = derivedNode(draft({
      models: [
        model({ id: "kept", name: "Kept", contextWindow: 200_000, reasoning: true, image: true, tools: false, cost: { input: 1, output: 2 } }),
        model({ id: "catalog-only", source: "catalog" }),
      ],
    }));
    expect(node.models).toEqual([{
      id: "kept",
      name: "Kept",
      contextWindow: 200_000,
      reasoning: true,
      input: ["text", "image"],
      supportsTools: false,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }]);
  });

  it("thinking 沿用文件里的 mode 与 effortMap", () => {
    const source = `providers:
  gateway:
    api: openai-completions
    models:
      - id: kept
        thinking:
          mode: budget
          effortMap:
            low: 1000
          efforts:
            - low
`;
    const node = derivedNode(draft({ models: [model({ id: "kept", reasoning: true, thinking: ["high"] })] }), source);
    expect(node.models).toEqual([{
      id: "kept",
      name: "kept",
      reasoning: true,
      thinking: { mode: "budget", efforts: ["high"], effortMap: { low: 1000 } },
    }]);
  });

  it("模型 Override 与自定义模型同一份映射", () => {
    const node = derivedNode(draft({
      modelOverrides: {
        "glm-5": { name: "GLM-5 Override", tools: false, image: false, cost: { input: 3 }, thinking: ["low"] },
      },
    }));
    expect(node.modelOverrides).toEqual({
      "glm-5": {
        name: "GLM-5 Override",
        supportsTools: false,
        input: ["text"],
        cost: { input: 3 },
        thinking: { mode: "effort", efforts: ["low"] },
      },
    });
    expect(derivedNode(draft()).modelOverrides).toBeUndefined();
  });

  it("表单没有新密钥时保留文件里的凭据", () => {
    expect(derivedNode(draft({ apiKey: "" })).apiKey).toBe("sk-live");
    expect(derivedNode(draft({ apiKey: "" }), SOURCE.replace("sk-live", '"********"')).apiKey).toBe("********");
  });

  it("切换鉴权方式时按写入语义改写 apiKey", () => {
    expect(derivedNode(draft({ authType: "none", apiKey: "sk-new" }))).not.toHaveProperty("apiKey");
    expect(derivedNode(draft({ authType: "oauth" })).apiKey).toBeUndefined();
    // A typed command replaces the prior API key; switching with no command drops it.
    expect(derivedNode(draft({ authType: "command", command: "op read op://key" })).apiKey).toBe("!op read op://key");
    expect(derivedNode(draft({ authType: "command", command: "" }))).not.toHaveProperty("apiKey");
    // With no prior credential the command lands, quoted so YAML keeps it a string.
    const emptySource = "providers:\n  gateway:\n    api: openai-completions\n";
    const withCommand = derivedSlice(draft({ authType: "command", command: "op read op://key" }), emptySource);
    expect(withCommand).toContain('apiKey: "!op read op://key"');
    // A typed command replaces whatever the file had, `!command` or not.
    const commandSource = "providers:\n  gateway:\n    api: openai-completions\n    apiKey: \"!keep-me\"\n";
    expect(derivedNode(draft({ authType: "command", command: "op read op://key" }), commandSource).apiKey).toBe("!op read op://key");
    expect(derivedNode(draft({ authType: "command", command: "" }), commandSource).apiKey).toBe("!keep-me");
    expect(derivedNode(draft({ authType: "env", envName: "GATEWAY_KEY" })).apiKey).toBe("GATEWAY_KEY");
    expect(derivedNode(draft({ authType: "env", envName: "" })).apiKey).toBe("GATEWAY_API_KEY");
  });

  it("none/oauth 显式写 auth，其余模式删掉遗留的 auth", () => {
    expect(derivedNode(draft({ authType: "none" })).auth).toBe("none");
    expect(derivedNode(draft({ authType: "oauth" })).auth).toBe("oauth");
    const oauthSource = `${SOURCE}    auth: oauth\n`;
    const switched = derivedNode(draft({ authType: "api-key", apiKey: "sk-new" }), oauthSource);
    expect(switched.auth).toBeUndefined();
    expect(switched.apiKey).toBe("sk-new");
  });

  it("脱敏占位符按加载时的鉴权类型解析", () => {
    const redacted = SOURCE.replace("sk-live", '"********"');
    // A stored plaintext key (or its placeholder) is kept…
    expect(derivedNode(draft(), redacted).apiKey).toBe("********");
    expect(derivedNode(draft(), redacted, "gateway", "api-key").apiKey).toBe("********");
    // …while a placeholder hiding an env name is dropped like the Host would.
    expect(derivedNode(draft(), redacted, "gateway", "env").apiKey).toBeUndefined();
  });

  it("脱敏占位符原样往返，不会被当成 YAML 别名", () => {
    const redacted = SOURCE.replace("sk-live", '"********"');
    expect(derivedNode(draft({ apiKey: "" }), redacted).apiKey).toBe("********");
    expect(derivedSlice(draft({ name: "Renamed" }), redacted)).toContain('apiKey: "********"');
  });

  it("新供应商从空节点起步", () => {
    const node = derivedNode(draft({ id: "acme", name: "Acme", endpointUrl: "https://acme.test/v1" }), SOURCE, "acme");
    expect(node).toEqual({
      name: "Acme",
      api: "openai-completions",
      baseUrl: "https://acme.test/v1",
      headers: { "X-Org-Id": "org-1" },
      models: [],
    });
  });

  it("表单回到原值时派生结果与文件切片一致", () => {
    const node = derivedNode(draft());
    expect(node.name).toBe("Company Gateway");
    expect(node.apiKey).toBe("sk-live");
    expect(node.headers).toEqual({ "X-Org-Id": "org-1" });
    expect(node.futureField).toBe("keep-me");
  });
});
