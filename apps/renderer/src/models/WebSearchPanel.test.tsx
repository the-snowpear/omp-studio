import { useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ClientEvent, CommandRequestId, StudioClient } from "@omp-studio/client-contract";
import type { SearchCredentialStatus } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { createPreviewModelConfig } from "../preview/modelConfigFixtures";
import { WebSearchPanel } from "./WebSearchPanel";
import { dragList } from "../test/drag-list";

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function runtimeClient() {
  let state: SearchCredentialStatus = { provider: "exa", configured: true, source: "env", envVar: "EXA_API_KEY", apiKeyLogin: true, keyUrl: "https://dashboard.exa.ai/api-keys", credentials: [] };
  const results = new Map<string, unknown>();
  let sequence = 0;
  const query = vi.fn(async () => ({ capabilities: [{ id: "search.credentials.list", grade: "stable" }] }));
  const command = vi.fn(async (name: string, input: Record<string, unknown>) => {
    const requestId = ("test-" + ++sequence) as CommandRequestId;
    if (name === "search.credentials.set") state = { ...state, source: "api_key", credentials: [{ id: 42, label: "API key #42", type: "api_key" }] };
    if (name === "search.credentials.remove") state = { ...state, source: "env", credentials: [] };
    results.set(requestId, name === "search.credentials.list" ? { providers: [state] } : state);
    return { requestId, commandName: name, status: "accepted", acceptedAt: "2026-11-09T00:00:00Z" };
  });
  const subscribe = vi.fn((scope: { requestId?: string }, listener: (event: ClientEvent) => void) => {
    const requestId = scope.requestId;
    if (requestId) queueMicrotask(() => listener({ kind: "command.receipt", receipt: { requestId, status: "completed", result: { result: results.get(requestId) } } } as ClientEvent));
    return () => {};
  });
  return { client: { query, command, subscribe } as unknown as StudioClient, command };
}
function providerRow(name: string) { return screen.getByText(name, { selector: ".wsx-pool-row .wsx-provider-name" }).closest(".wsx-pool-row") as HTMLElement; }

it("uses Runtime credential receipts, removes the selected key and keeps an unsaved search draft", async () => {
  const { client, command } = runtimeClient();
  const model = createPreviewModelConfig();
  const webSearch = { ...model.webSearch, providers: model.webSearch.providers.filter(row => row.id === "exa") };
  render(<I18nProvider forcedLanguage="zh"><WebSearchPanel client={client} sessionId="chat" preview={false} webSearch={webSearch} models={model.availableModels} loginAvailable onSaved={vi.fn()} onPreviewSave={vi.fn()} /></I18nProvider>);
  fireEvent.click(screen.getByRole("switch", { name: "web_search 工具开关" }));
  fireEvent.click(within(providerRow("Exa")).getByRole("button", { name: "配置凭证" }));
  const modal = screen.getByRole("dialog");
  await waitFor(() => expect(within(modal).getByText("环境变量")).toBeTruthy());
  const input = within(modal).getByLabelText("API 密钥") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "new-test-key" } });
  fireEvent.click(within(modal).getByRole("button", { name: "保存密钥" }));
  await within(modal).findByText("API key #42");
  expect(command).toHaveBeenCalledWith("search.credentials.set", { sessionId: "chat", provider: "exa", apiKey: "new-test-key" });
  expect(input.value).toBe("");
  fireEvent.click(within(modal).getByRole("button", { name: "删除凭据 API key #42" }));
  await waitFor(() => expect(within(modal).queryByText("API key #42")).toBeNull());
  expect(command).toHaveBeenCalledWith("search.credentials.remove", { sessionId: "chat", provider: "exa", credentialId: 42 });
  expect(within(modal).getByText("环境变量")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "web_search 工具开关" }).getAttribute("aria-checked")).toBe("false");
});

it("does not offer credential writes while Runtime is disconnected", () => {
  const { client, command } = runtimeClient();
  const model = createPreviewModelConfig();
  render(<I18nProvider forcedLanguage="zh"><WebSearchPanel client={client} preview={false} webSearch={model.webSearch} models={model.availableModels} loginAvailable onSaved={vi.fn()} onPreviewSave={vi.fn()} /></I18nProvider>);
  fireEvent.click(within(providerRow("Ollama Cloud")).getByRole("button", { name: "配置凭证" }));
  expect(screen.getByText("连接支持此功能的 Runtime 后，可查看和管理凭据。")).toBeTruthy();
  expect((screen.getByLabelText("API 密钥") as HTMLInputElement).disabled).toBe(true);
  expect(command).not.toHaveBeenCalled();
});

it("adds a library engine to the draft, selects a grounded model and saves one native search chain", async () => {
  const { client, command } = runtimeClient();
  const saved = vi.fn();
  const model = createPreviewModelConfig();
  function Harness() {
    const [webSearch, setWebSearch] = useState(model.webSearch);
    return <WebSearchPanel client={client} preview webSearch={webSearch} models={model.availableModels} loginAvailable onSaved={vi.fn()} onPreviewSave={next => { saved(next); setWebSearch(next); }} />;
  }
  render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><Harness /></I18nProvider></PreviewModeProvider>);
  fireEvent.click(within(providerRow("Ollama Cloud")).getByRole("button", { name: "加入链条" }));
  expect(screen.getByText("web/ollama", { selector: ".wsx-chain-row .wsx-provider-id" })).toBeTruthy();
  expect((within(providerRow("Ollama Cloud")).getByRole("button", { name: "已加入" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(providerRow("Gemini")).getByRole("button", { name: "加入链条" }));
  expect(screen.getByRole("combobox", { name: "选择 Gemini 搜索模型" })).toBeTruthy();
  fireEvent.click(within(providerRow("Gemini").querySelector<HTMLElement>(".wsx-pool-choice")!).getByRole("button", { name: "加入链条" }));
  const rows = [...document.querySelectorAll<HTMLElement>(".wsx-chain-list .wsx-chain-row")];
  dragList(rows, 4, 0, 2, ".wsx-drag-handle");
  await waitFor(() => expect(document.querySelector<HTMLElement>(".wsx-chain-row")?.dataset.id).toBe("google/gemini-2.5-pro"));
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存搜索链" }));
  expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ routing: expect.objectContaining({ primary: "google/gemini-2.5-pro", fallbacks: ["web/perplexity", "web/exa", "google/gemini-2.5-flash", "web/ollama"] }) }));
  expect(command).not.toHaveBeenCalled();
});
