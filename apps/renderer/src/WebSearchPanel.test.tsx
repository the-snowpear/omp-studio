import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandReceipt, CommandRequestId, StudioClient, WebSearchConfigReadModel } from "@omp-studio/client-contract";

import { WebSearchPanel } from "./models/WebSearchPanel";

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
  vi.restoreAllMocks();
});

const T0 = "2026-08-30T00:00:00.000Z";

const DESC: Record<string, string> = {
  perplexity: "Uses auth when configured; explicit selection falls back to anonymous search",
  brave: "Requires BRAVE_API_KEY",
  tavily: "Requires TAVILY_API_KEY",
  duckduckgo: "Credential-free best-effort fallback",
  google: "Credential-free browser-backed fallback",
};

function readModel(overrides: Partial<WebSearchConfigReadModel> = {}): WebSearchConfigReadModel {
  return {
    enabled: true,
    order: ["perplexity"],
    exclude: [],
    timeoutSeconds: 60,
    geminiModel: "",
    providers: [
      { id: "perplexity", name: "Perplexity", description: DESC.perplexity!, credentialFree: false, hasCredential: true },
      { id: "brave", name: "Brave", description: DESC.brave!, credentialFree: false, hasCredential: false },
      { id: "tavily", name: "Tavily", description: DESC.tavily!, credentialFree: false, hasCredential: false },
      { id: "duckduckgo", name: "DuckDuckGo", description: DESC.duckduckgo!, credentialFree: true, hasCredential: true },
      { id: "google", name: "Google", description: DESC.google!, credentialFree: true, hasCredential: true },
    ],
    advanced: {
      searxng: { endpoint: "", tokenSet: false, basicUsername: "", passwordSet: false },
      exa: { enabled: true, searchDelayMs: 1000 },
    },
    ...overrides,
  };
}

function fakeClient(): StudioClient & {
  readonly command: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
} {
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
          commandName: "models.webSearch.set",
          status: "completed",
          result: { ok: true },
          observedAt: T0,
        } as unknown as CommandReceipt,
      });
    });
    return () => undefined;
  });
  return { command, subscribe, bootstrap: vi.fn(), query: vi.fn(), close: vi.fn() } as unknown as StudioClient & {
    readonly command: ReturnType<typeof vi.fn>;
    readonly subscribe: ReturnType<typeof vi.fn>;
  };
}

function mount(webSearch = readModel(), client = fakeClient(), preview = false) {
  const onSaved = vi.fn();
  const onPreviewSave = vi.fn();
  const onEditProvider = vi.fn();
  render(
    <WebSearchPanel
      client={client}
      preview={preview}
      webSearch={webSearch}
      onSaved={onSaved}
      onPreviewSave={onPreviewSave}
      onEditProvider={onEditProvider}
    />,
  );
  return { onSaved, onPreviewSave, onEditProvider, client };
}

describe("WebSearchPanel", () => {
  it("previews the effective chain: explicit order first, then the credential-ready auto chain", () => {
    mount();
    // Priority chip carries the rank.
    expect(screen.getByText("Perplexity", { selector: ".wsx-chip.is-priority" })).toBeTruthy();
    // Auto group only lists ready/keyless engines, not Brave/Tavily (missing).
    expect(screen.getByText("DuckDuckGo", { selector: ".wsx-chip.is-auto" })).toBeTruthy();
    expect(screen.getByText("Google", { selector: ".wsx-chip.is-auto" })).toBeTruthy();
    expect(screen.queryByText("Brave", { selector: ".wsx-chip.is-auto" })).toBeNull();
  });

  it("shows a warning when the tool is off", () => {
    mount(readModel({ enabled: false }));
    expect(screen.getByText(/web_search 工具已关闭/)).toBeTruthy();
  });

  it("shows a warning when no engine is usable at all", () => {
    mount(readModel({
      order: [],
      exclude: ["duckduckgo", "google"],
      providers: readModel().providers.filter((provider) => provider.id === "perplexity"
        ? false
        : provider.id === "brave" || provider.id === "tavily"),
    }));
    expect(screen.getByText(/没有可用引擎/)).toBeTruthy();
  });

  it("promotes a library engine into the priority chain and drops it from the library", () => {
    mount();
    // Library order minus order ids: brave, tavily, duckduckgo, google → first promote = Brave.
    fireEvent.click(screen.getAllByRole("button", { name: /设为优先/ })[0]!);
    // Brave now has a ranked chain row.
    expect(screen.getByText("2", { selector: ".wsx-rank" })).toBeTruthy();
    expect(screen.getByText("brave", { selector: ".wsx-chain-row .wsx-provider-id" })).toBeTruthy();
    // And it left the library (its description row is gone).
    expect(screen.queryByText(DESC.brave!)).toBeNull();
  });

  it("excludes an engine and restores it back", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "排除 Brave" }));
    expect(screen.getByText("已排除", { selector: ".wsx-excluded-label" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /恢复/ }));
    expect(screen.queryByText("已排除", { selector: ".wsx-excluded-label" })).toBeNull();
  });

  it("filters the library by credential state and search query", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /未配置/ }));
    expect(screen.getByText(DESC.brave!)).toBeTruthy();
    expect(screen.getByText(DESC.tavily!)).toBeTruthy();
    expect(screen.queryByText(DESC.duckduckgo!)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/搜索引擎名称或 ID/), { target: { value: "tavily" } });
    expect(screen.queryByText(DESC.brave!)).toBeNull();
    expect(screen.getByText(DESC.tavily!)).toBeTruthy();
  });

  it("saves through models.webSearch.set with the full payload (real mode)", async () => {
    const { client, onSaved } = mount();
    fireEvent.click(screen.getAllByRole("button", { name: /设为优先/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /高级设置/ }));
    fireEvent.change(screen.getByDisplayValue(/实例默认/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(client.command).toHaveBeenCalled());
    const [commandName, input] = client.command.mock.calls[0]! as [string, Record<string, unknown>];
    expect(commandName).toBe("models.webSearch.set");
    expect(input.order).toEqual(["perplexity", "brave"]);
    expect(input.searxng).toMatchObject({ safesearch: 2, endpoint: "", token: "" });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("keeps preview mode local: onPreviewSave mutates the demo read model only", () => {
    const { client, onPreviewSave } = mount(readModel(), fakeClient(), true);
    fireEvent.click(screen.getAllByRole("button", { name: /设为优先/ })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /保存|Save/ }));
    expect(onPreviewSave).toHaveBeenCalledTimes(1);
    const next = onPreviewSave.mock.calls[0]![0] as WebSearchConfigReadModel;
    expect(next.order).toEqual(["perplexity", "brave"]);
    expect(client.command).not.toHaveBeenCalled();
  });
});
