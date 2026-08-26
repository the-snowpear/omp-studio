import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
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
    generatedModelsYml: "providers:\n  gateway:\n    api: openai-completions\n",
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

function fakeClient(probe: ModelDiscoveryResult | Error = PROBE_OK): StudioClient & {
  readonly query: ReturnType<typeof vi.fn>;
  readonly command: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (name: string) => {
    if (name === "models.get") return readModel();
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

async function openEditor(options: { preview?: boolean; client?: StudioClient } = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview ? "1" : "0");
  const client = options.client ?? fakeClient();
  render(
    <PreviewModeProvider switchEnabled>
      <ModelConfigPage client={client} />
    </PreviewModeProvider>,
  );
  const edit = await screen.findAllByRole("button", { name: "编辑供应商" });
  fireEvent.click(edit[0] as HTMLElement);
  await screen.findByRole("button", { name: /自动获取模型/ });
  return client as ReturnType<typeof fakeClient>;
}

describe("ModelConfigPage 自动获取模型", () => {
  it("probes the wire API without a discovery type and imports picked models into the draft", async () => {
    const client = await openEditor();

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
    });
    expect(input.discoveryType).toBeUndefined();

    // "kept" is already on the draft, so it is listed but unpicked: 2 of 3.
    const importButton = await screen.findByRole("button", { name: /导入 2 个模型/ });
    expect(screen.getByText("gateway/fresh")).toBeTruthy();
    expect(screen.getAllByText("已存在")).toHaveLength(1);
    // glm-5 has no endpoint metadata but the local models.db knows it.
    expect(screen.getByText("本地补全")).toBeTruthy();
    expect(screen.getByText("131k ctx")).toBeTruthy();

    fireEvent.click(importButton);

    expect(await screen.findByText("已加入 2 个模型，保存后写入 models.yml")).toBeTruthy();
    // Import only touches the draft; models.yml is written by the form's submit.
    expect(client.command).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /导入/ })).toBeNull();
    expect(screen.getByText("Fresh One")).toBeTruthy();
    expect(screen.getByText("GLM-5")).toBeTruthy();
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
    const client = await openEditor({ client: fakeClient(new Error("连接失败：连接被拒绝")) });
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
    const client = await openEditor({ preview: true });
    fireEvent.click(screen.getByRole("button", { name: /自动获取模型/ }));
    expect(await screen.findByText("演示：自动获取模型未调用 Host")).toBeTruthy();
    expect(screen.getByText("GLM-5")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /导入 4 个模型/ })).toBeTruthy();
    expect(client.command).not.toHaveBeenCalled();
  });
});
