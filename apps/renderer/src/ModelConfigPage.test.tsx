import { previewModelAdaptation } from "./preview/modelAdaptationPreview";
import { dragList } from "./test/drag-list";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ClientEvent,
  CommandReceipt,
  CommandRequestId,
  ModelConfigReadModel,
  ModelDiscoveryResult,
  ModelProviderRecord,
  StudioClient,
} from "@omp-studio/client-contract";

import { ModelConfigPage } from "./ModelConfigPage";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  // The role model picker scrolls its active option into view; jsdom has no layout.
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  vi.restoreAllMocks();
});

const T0 = "2026-08-20T00:00:00.000Z";

/* Mounting the whole page brings the CodeMirror YAML editor with it, which is
   slow enough under a loaded parallel suite to trip the 5s default. */
vi.setConfig({ testTimeout: 30_000 });

function gateway(): ModelProviderRecord {
  return {
    id: "gateway",
    name: "Company Gateway",
    source: "custom",
    status: "available",
    statusDetail: "已从 models.yml 读取",
    api: "openai-completions",
    endpointUrl: "https://gw.example.com/v1",
    local: false,
    enabled: true,
    auth: { type: "api-key", hasSecret: true, apiKey: "sk-live" },
    headers: { "X-Org-Id": "org-1" },
    models: [
      {
        id: "kept",
        name: "Kept",
        selector: "gateway/kept",
        image: false,
        reasoning: false,
        tools: true,
        status: "available",
        source: "custom",
      },
    ],
  };
}

function readModel(): ModelConfigReadModel {
  return {
    providers: [gateway()],
    presets: [],
    roles: [],
    cycleOrder: ["smol", "default", "slow"],
    availableModels: [
      { provider: "other", id: "glm-5", selector: "other/glm-5", name: "GLM-5", reasoning: true, contextWindow: 131_072 },
    ],
    loginProviders: [],
    generatedModelsYml: "providers:\n  gateway:\n    name: Company Gateway\n    api: openai-completions\n    baseUrl: https://gw.example.com/v1\n",
    generatedConfigYml: "modelRoles: {}\n",
    runtimeEffectHint: "新会话生效",
    loginAvailable: false,
    ompAvailable: true,
    modelRoleStorage: "global",
    projectScopeAvailable: false,
    modelProviderOrder: [],
    fallbackChains: {},
    fallbackRevertPolicy: "cooldown-expiry",
    webSearch: {
      enabled: true,
      order: [],
      exclude: [],
      timeoutSeconds: 60,
      geminiModel: "",
      providers: [],
      advanced: { searxng: { endpoint: "", tokenSet: false, basicUsername: "", passwordSet: false }, exa: { enabled: true, searchDelayMs: 1000 } },
    },
  };
}

it("reorders filtered provider cards while preserving hidden providers and keeping the order local", async () => {
  window.localStorage.removeItem("omp.providerDisplayOrder");
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const model = { ...readModel(), providers: [
    { ...gateway(), id: "first", name: "Visible first" },
    { ...gateway(), id: "hidden", name: "Hidden" },
    { ...gateway(), id: "last", name: "Visible last" },
  ] };
  const client = fakeClient(PROBE_OK, model);
  const { container } = render(<PreviewModeProvider switchEnabled><ModelConfigPage client={client} /></PreviewModeProvider>);
  try {
    await screen.findAllByRole("button", { name: "编辑供应商" });
    fireEvent.change(container.querySelector(".mr-toolbar input")!, { target: { value: "Visible" } });
    const rows = [...container.querySelectorAll<HTMLElement>(".pv-card")];
    expect(rows.map(row => row.dataset.id)).toEqual(["first", "last"]);
    dragList(rows, 0, 1, 10, ".pv-drag");
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("omp.providerDisplayOrder")!)).toEqual(["last", "hidden", "first"]));
    expect([...container.querySelectorAll<HTMLElement>(".pv-card")].map(row => row.dataset.id)).toEqual(["last", "first"]);
    expect(client.command).not.toHaveBeenCalled();
  } finally {
    window.localStorage.removeItem("omp.providerDisplayOrder");
  }
});

const PROBE_OK: ModelDiscoveryResult = {
  ok: true,
  found: 3,
  usable: 3,
  models: [
    { id: "fresh", name: "Fresh One", contextWindow: 200_000 },
    { id: "glm-5", name: "GLM-5" },
    { id: "kept", name: "Kept" },
  ],
  latencyMs: 42,
  detail: "探测成功 · 发现 3 个模型 · HTTP 200",
};

function fakeClient(probe: ModelDiscoveryResult | Error = PROBE_OK, modelConfig?: ModelConfigReadModel): StudioClient & {
  readonly query: ReturnType<typeof vi.fn>;
  readonly command: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (name: string, input: import("@omp-studio/client-contract").ModelAdaptationInput) => {
    if (name === "models.adaptation.resolve") {
      const result = previewModelAdaptation(input);
      if (input.modelId !== "glm-5") return result;
      return { ...result, values: { ...result.values, contextWindow: 131072 }, sources: { ...result.sources, contextWindow: { source: "catalog", catalogVersion: "demo-v1" } } };
    }
    if (name === "models.get") return modelConfig ?? readModel();
    if (name === "agents.definitions.get") {
      return {
        agents: [],
        warnings: [],
        builtinToolNames: [],
        roleAliases: [],
        projectScopeAvailable: false,
        generatedAt: T0,
      };
    }
    throw new Error(`unexpected query ${name}`);
  });
  const command = vi.fn(async (commandName: string) => ({
    commandName,
    requestId: `req-${commandName}` as CommandRequestId,
    status: "accepted" as const,
    acceptedAt: T0,
  }));
  const subscribe = vi.fn((filter: { readonly requestId?: string }, cb: (event: { kind: string; receipt: CommandReceipt }) => void) => {
    const requestId = (filter.requestId ?? "req") as CommandRequestId;
    queueMicrotask(() => {
      cb({
        kind: "command.receipt",
        receipt: {
          requestId,
          commandName: "models.provider.probe",
          status: probe instanceof Error ? "failed" : "completed",
          ...(probe instanceof Error
            ? { error: { code: "UNAVAILABLE", message: probe.message } }
            : { result: probe }),
          observedAt: T0,
        } as unknown as CommandReceipt,
      });
    });
    return () => undefined;
  });
  return { query, command, bootstrap: vi.fn(), subscribe, close: vi.fn() } as unknown as StudioClient & {
    readonly query: ReturnType<typeof vi.fn>;
    readonly command: ReturnType<typeof vi.fn>;
  };
}

it("updates the catalog from the model navigation without a duplicate evaluation tab", async () => {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const client = fakeClient(PROBE_OK, {
    ...readModel(),
    catalog: { version: "old-version", upstreamCommit: "old", source: "builtin" },
  });
  vi.mocked(client.subscribe).mockImplementation((scope, listener) => {
    if (scope.scope === "command") {
      queueMicrotask(() => listener({
        kind: "command.receipt",
        receipt: {
          requestId: scope.requestId,
          commandName: "models.catalog.refresh",
          status: "completed",
          result: { updated: true, catalog: { version: "new-version", upstreamCommit: "new", source: "updated" }, message: "模型目录已更新" },
          observedAt: T0,
        },
      } as unknown as ClientEvent));
    }
    return () => undefined;
  });
  render(<PreviewModeProvider switchEnabled><ModelConfigPage client={client} /></PreviewModeProvider>);

  expect(await screen.findByText("old-version")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "基准测试" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "检查并更新目录" }));
  expect(await screen.findByText("new-version")).toBeTruthy();
  expect(client.command).toHaveBeenCalledWith("models.catalog.refresh", {});
});

it("keeps catalog updates local in unmarked preview mode", async () => {
  const url = window.location.href;
  window.history.replaceState({}, "", "?marks=off");
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = fakeClient();
  try {
    render(<PreviewModeProvider switchEnabled><ModelConfigPage client={client} /></PreviewModeProvider>);
    expect(await screen.findByText("2026.10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查并更新目录" }));
    expect(client.command).not.toHaveBeenCalled();
    expect(screen.queryByText("演示模式：已模拟目录更新，当前草稿和真实配置保持不变。")).toBeNull();
  } finally {
    window.history.replaceState({}, "", url);
  }
});

it("manages search credentials only in the provider library and keeps preview local", async () => {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = fakeClient();
  render(<PreviewModeProvider switchEnabled><ModelConfigPage client={client} /></PreviewModeProvider>);
  fireEvent.click(await screen.findByRole("tab", { name: /网络搜索/ }));
  const providerName = await screen.findByText("Exa", { selector: ".wsx-pool-row .wsx-provider-name" });
  expect(screen.queryByText("搜索凭据")).toBeNull();
  const row = providerName.closest(".wsx-pool-row") as HTMLElement;
  expect(within(row).getByText("免凭证")).toBeTruthy();
  fireEvent.click(await within(row).findByRole("button", { name: "配置凭证" }));
  const modal = screen.getByRole("dialog", { name: "配置 Exa 凭证" });
  const input = within(modal).getByLabelText("API 密钥") as HTMLInputElement;
  expect(input.type).toBe("password");
  expect(within(modal).queryByRole("button", { name: "登录" })).toBeNull();
  fireEvent.change(input, { target: { value: "preview-key" } });
  fireEvent.click(within(modal).getByRole("button", { name: "保存密钥" }));
  await waitFor(() => expect(within(modal).getByText("已就绪")).toBeTruthy());
  expect(input.value).toBe("");
  expect(within(row).getByText("已就绪")).toBeTruthy();
  fireEvent.click(within(modal).getByRole("button", { name: "删除凭据 API key" }));
  await waitFor(() => expect(within(row).getByText("免凭证")).toBeTruthy());
  expect(client.command).not.toHaveBeenCalled();
});

async function openEditor(options: { preview?: boolean; client?: StudioClient; modelConfig?: ModelConfigReadModel } = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview ? "1" : "0");
  const client = options.client ?? fakeClient(PROBE_OK, options.modelConfig);
  const view = render(
    <PreviewModeProvider switchEnabled>
      <ModelConfigPage client={client} />
    </PreviewModeProvider>,
  );
  const edit = await screen.findAllByRole("button", { name: "编辑供应商" });
  fireEvent.click(edit[0] as HTMLElement);
  await screen.findByRole("button", { name: /自动获取模型/ }, { timeout: 3000 });
  return {
    client: client as ReturnType<typeof fakeClient>,
    container: view.container,
  };
}

/**
 * The card renders CodeMirror into a portal, so read the visible document from
 * the in-flow holder (the editor host inside it carries the aria-label) instead
 * of from the React tree.
 */
async function yamlCard(container: HTMLElement, title: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const holder = Array.from(container.querySelectorAll<HTMLElement>(".st-holder"))
      .find((node) => node.querySelector(`.st-editor[aria-label="${title}"]`));
    const card = holder?.querySelector<HTMLElement>(".yml-card");
    if (!card) throw new Error(`YAML card ${title} is not mounted yet`);
    return card;
  });
}

async function yamlCardText(container: HTMLElement, title: string): Promise<string> {
  const card = await yamlCard(container, title);
  return card.querySelector(".cm-content")?.textContent ?? "";
}

function plainText(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("ModelConfigPage 自动获取模型", () => {
  it("applies gray recommendations to the model draft and the provider YAML save, including provenance", async () => {
    const { client, container } = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(await screen.findByPlaceholderText("如 gpt-example"), { target: { value: "glm-5" } });
    const context = await screen.findByRole("spinbutton", { name: "上下文窗口" }) as HTMLInputElement;
    await waitFor(() => expect(context.placeholder).toBe("131072"));
    expect(context.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(async () => expect(plainText(await yamlCardText(container, "gateway"))).toContain("contextWindow: 131072"));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("models.yml.write", expect.objectContaining({
      overlay: expect.objectContaining({ models: expect.arrayContaining([expect.objectContaining({
        id: "glm-5", contextWindow: 131072,
        thinkingConfig: expect.objectContaining({ mode: "effort", defaultLevel: "high" }),
        parameterSources: expect.objectContaining({ contextWindow: expect.objectContaining({ source: "catalog" }) }),
      })]) }),
    })));
  });

  it("probes the wire API without a discovery type and imports picked models into the draft", async () => {
    const { client } = await openEditor();

    fireEvent.click(screen.getByRole("button", { name: /自动获取模型/ }));

    await waitFor(() => expect(client.command).toHaveBeenCalled());
    const [name, input] = client.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("models.provider.probe");
    expect(input).toEqual({
      providerId: "gateway",
      endpointUrl: "https://gw.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-live",
      headers: { "X-Org-Id": "org-1" },
      advertisedReasoning: true,
    });
    expect(input.discoveryType).toBeUndefined();

    // "kept" is already on the draft, so it is listed but unpicked: 2 of 3.
    const importButton = await screen.findByRole("button", { name: /导入 2 个模型/ });
    expect(screen.getByText("gateway/fresh")).toBeTruthy();
    expect(screen.getAllByText("已存在")).toHaveLength(1);
    // The typed adaptation query supplies the missing catalog parameters.
    expect(screen.getAllByText("目录").length).toBeGreaterThan(0);
    expect(screen.getByText("131k ctx")).toBeTruthy();

    fireEvent.click(importButton);

    expect(await screen.findByText("已加入 2 个模型，保存后写入 models.yml")).toBeTruthy();
    // Import only touches the draft; models.yml is written by the form's submit.
    expect(client.command).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /导入/ })).toBeNull();
    // The card is derived from the draft, so an imported model shows up twice:
    // once in the model list and once inside the models.yml slice.
    expect(screen.getAllByText("Fresh One").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GLM-5").length).toBeGreaterThan(0);
  });

  it("select-all can include models that already exist", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: /自动获取模型/ }));
    await screen.findByRole("button", { name: /导入 2 个模型/ });
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(await screen.findByRole("button", { name: /导入 3 个模型/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    expect(await screen.findByRole("button", { name: /导入 0 个模型/ })).toBeTruthy();
  });

  it("surfaces a Host failure without opening the checklist", async () => {
    const { client } = await openEditor({ client: fakeClient(new Error("连接失败：连接被拒绝")) });
    fireEvent.click(screen.getByRole("button", { name: /自动获取模型/ }));
    expect(await screen.findByText("获取失败")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /导入/ })).toBeNull();
    expect(client.command).toHaveBeenCalledTimes(1);
  });

  it("keeps the button disabled until the provider has an id and a base url", async () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
    const client = fakeClient();
    render(
      <PreviewModeProvider switchEnabled>
        <ModelConfigPage client={client} />
      </PreviewModeProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加供应商" }));
    const fetchButton = await screen.findByRole<HTMLButtonElement>("button", { name: /自动获取模型/ });
    expect(fetchButton.disabled).toBe(true);
    expect(fetchButton.getAttribute("data-tip")).toBe("先填 Provider ID");

    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "acme" } });
    expect(screen.getByRole("button", { name: /自动获取模型/ }).getAttribute("data-tip")).toBe("先填 Base URL");

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://acme.test/v1" } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /自动获取模型/ }).disabled).toBe(false);
    expect(client.command).not.toHaveBeenCalled();
  });

  it("uses fixtures and never calls the Host in preview mode", async () => {
    const { client } = await openEditor({ preview: true });
    fireEvent.click(screen.getByRole("button", { name: /自动获取模型/ }));
    expect(await screen.findByText("演示：自动获取模型未调用 Host")).toBeTruthy();
    expect(screen.getByText("GLM-5")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /导入 4 个模型/ })).toBeTruthy();
    expect(client.command).not.toHaveBeenCalled();
  });
});

describe("ModelConfigPage YAML 卡片随表单实时更新", () => {
  it("表单改动不保存就出现在 models.yml 切片里，且卡片转为只读", async () => {
    const { container } = await openEditor();
    const clean = await yamlCard(container, "gateway");
    expect(plainText(await yamlCardText(container, "gateway"))).toContain("https://gw.example.com/v1");
    // Clean form: the card mirrors the file, so it stays editable.
    expect(clean.querySelector(".st-editor.is-disabled")).toBeNull();
    expect(clean.textContent).not.toContain("只读");

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://edited.test/v1" } });
    fireEvent.change(screen.getByLabelText("供应商名称"), { target: { value: "Edited Gateway" } });

    await waitFor(async () => {
      const text = plainText(await yamlCardText(container, "gateway"));
      expect(text).toContain("https://edited.test/v1");
      expect(text).toContain("Edited Gateway");
    });
    // The form owns the slice now, so the card reports read-only.
    const card = await yamlCard(container, "gateway");
    expect(card.querySelector(".st-editor.is-disabled")).toBeTruthy();
    expect(card.textContent).toContain("只读");
    // Editing the form alone never talks to the Host.
    expect(screen.queryByText("已写入 models.yml")).toBeNull();
  });

  it("表单改动后保存会带上完整切片，而不是空文档", async () => {
    const { client } = await openEditor();
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://edited.test/v1" } });

    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(client.command).toHaveBeenCalled());
    const [name, input] = client.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("models.yml.write");
    expect(String(input.text)).toContain("https://edited.test/v1");
    expect(String(input.text)).toContain("providers:");
    expect(input.overlay).toMatchObject({ id: "gateway", endpointUrl: "https://edited.test/v1" });
  });

  it("角色编辑器换主模型时 config.yml 卡片同步变化", async () => {
    const config = {
      ...readModel(),
      roles: [{ id: "smol", alias: "@smol", name: "Fast", desc: "", builtin: true, primary: "gateway/kept", scope: "global" as const }],
      availableModels: [
        { provider: "gateway", id: "kept", selector: "gateway/kept", name: "Kept", reasoning: true },
        { provider: "gateway", id: "fresh", selector: "gateway/fresh", name: "Fresh One", reasoning: true },
      ],
      generatedConfigYml: "modelRoles:\n  smol: gateway/kept\n",
    };
    const { container } = await openEditor({ modelConfig: config });

    fireEvent.click(document.getElementById("mcTabRoles") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 Fast" }));
    await waitFor(async () => expect(plainText(await yamlCardText(container, "smol"))).toContain("gateway/kept"));

    fireEvent.click(screen.getByRole("button", { name: "主模型" }));
    fireEvent.click(await screen.findByRole("option", { name: /Fresh One/ }));

    await waitFor(async () => expect(plainText(await yamlCardText(container, "smol"))).toContain("gateway/fresh"));
    const card = await yamlCard(container, "smol");
    expect(card.querySelector(".st-editor.is-disabled")).toBeTruthy();
    expect(card.textContent).toContain("只读");
  });

  it("清空 Base URL 后切片与保存都不再携带 baseUrl", async () => {
    const { client, container } = await openEditor();
    expect(plainText(await yamlCardText(container, "gateway"))).toContain("https://gw.example.com/v1");

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "" } });

    await waitFor(async () => {
      expect(plainText(await yamlCardText(container, "gateway"))).not.toContain("baseUrl");
    });
    fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(client.command).toHaveBeenCalled());
    const [name, input] = client.command.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("models.yml.write");
    // The cleared field reaches the wire as an explicit empty string so the
    // Host deletes the key — the same shape the card already showed.
    expect(String(input.text)).not.toContain("baseUrl");
    expect(input.overlay).toMatchObject({ id: "gateway", endpointUrl: "" });
  });
});
