import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { AgentAccountPoolState } from "@omp-studio/studio-protocol";
import { SubagentsPanel } from "../SubagentsPanel";
import { createPreviewAgentDefinitions } from "../preview/subagentsPreview";
import { createPreviewModelConfig } from "../preview/modelConfigFixtures";
import { createPreviewPoolAccounts } from "../preview/agentAccountPoolsPreview";
import { AgentAccountRules } from "./AgentAccountRules";
import { useAgentAccountPools } from "./useAgentAccountPools";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const client = () => ({ query: vi.fn(), command: vi.fn(), subscribe: vi.fn(() => () => {}) }) as unknown as StudioClient;
const accountRegion = () => screen.getByRole("region", { name: "账号使用策略" });

it("edits the selected agent, keeps account drafts across providers and the list, and saves preview locally", async () => {
  const api = client();
  render(<SubagentsPanel client={api} preview models={createPreviewModelConfig()} />);
  expect(screen.queryByRole("region", { name: "代理账号池" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开 reviewer 详情" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Personal/ }));
  fireEvent.click(screen.getByRole("button", { name: /OpenAI Codex.*默认账号规则/ }));
  fireEvent.click(within(accountRegion()).getByRole("radio", { name: "停用提供商" }));
  fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开 notes 详情" }));
  expect((await screen.findByRole("radio", { name: "默认规则" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开 reviewer 详情" }));
  expect((await screen.findByRole("checkbox", { name: /Personal/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("button", { name: /OpenAI Codex.*已停用/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存子代理" }));
  await screen.findByRole("button", { name: "打开 reviewer 详情" });
  expect(screen.getByText("2 个提供商有账号规则")).toBeTruthy();
  expect(api.command).not.toHaveBeenCalled();
  expect(api.query).not.toHaveBeenCalled();
});

it("does not silently turn an empty selected-account draft into a blocked provider", async () => {
  render(<SubagentsPanel client={client()} preview models={createPreviewModelConfig()} initialAgent="notes" />);
  fireEvent.click(await screen.findByRole("radio", { name: "指定账号" }));
  expect((screen.getByRole("button", { name: "保存子代理" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开 notes 详情" }));
  expect((await screen.findByRole("radio", { name: "指定账号" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "停用提供商" }));
  expect((screen.getByRole("button", { name: "保存子代理" }) as HTMLButtonElement).disabled).toBe(false);
});

it("reads and writes global agent rules independently of effective session restrictions", async () => {
  let settings: AgentAccountPoolState = { global: {}, effective: { reviewer: { anthropic: ["email:review@example.test"] } } };
  const receipts: Record<string, unknown> = {};
  let index = 0;
  const command = vi.fn(async (kind: string, input: { agent?: string; pools?: unknown }) => {
    if (kind === "accounts.pool.set") settings = { ...settings, global: { reviewer: input.pools } } as AgentAccountPoolState;
    const requestId = String(++index);
    receipts[requestId] = { status: "completed", requestId, result: { result: kind === "accounts.pool.options" ? { accounts: createPreviewPoolAccounts(), truncated: false } : settings } };
    return { requestId };
  });
  const api = { command, getState: () => ({ commands: receipts }), subscribe: vi.fn(() => () => {}) } as unknown as StudioClient;
  const context = { sessionId: "s1", available: true, capabilities: { capabilities: ["accounts.pool.get", "accounts.pool.set", "accounts.pool.options"].map(id => ({ id, grade: "native" })) } } as unknown as Parameters<typeof useAgentAccountPools>[0]["context"];
  function Harness({ sessionId = "s1" }: { sessionId?: string }) {
    const state = useAgentAccountPools({ client: api, preview: false, visible: true, context: { ...context!, sessionId } });
    return <><AgentAccountRules agent="reviewer" state={state} models={null} /><button onClick={() => void state.save("reviewer")}>Save</button></>;
  }
  const view = render(<Harness />);
  await screen.findByText("当前会话另有生效规则");
  expect((screen.getByRole("radio", { name: "默认规则" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "停用提供商" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("accounts.pool.set", { sessionId: "s1", agent: "reviewer", pools: { anthropic: [] } }));
  await waitFor(() => expect(screen.queryByText("未保存")).toBeNull());
  expect(screen.getByText("当前会话另有生效规则")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "默认规则" }));
  view.rerender(<Harness sessionId="s2" />);
  await waitFor(() => expect((screen.getByRole("radio", { name: "停用提供商" }) as HTMLInputElement).checked).toBe(true));
  expect(screen.queryByText("未保存")).toBeNull();
});

it("saving only account changes does not rewrite the agent definition or its other overrides", async () => {
  const receipts: Record<string, unknown> = {};
  let settings: AgentAccountPoolState = { global: {}, effective: {} };
  let index = 0;
  const command = vi.fn(async (kind: string, input: { pools?: unknown }) => {
    if (kind === "accounts.pool.set") settings = { global: { reviewer: input.pools }, effective: { reviewer: input.pools } } as AgentAccountPoolState;
    const requestId = String(++index);
    receipts[requestId] = { status: "completed", requestId, result: { result: kind === "accounts.pool.options" ? { accounts: createPreviewPoolAccounts(), truncated: false } : settings } };
    return { requestId };
  });
  const api = { command, query: vi.fn(async () => createPreviewAgentDefinitions()), getState: () => ({ commands: receipts }), subscribe: vi.fn(() => () => {}) } as unknown as StudioClient;
  const context = { sessionId: "s1", available: true, capabilities: { capabilities: ["accounts.pool.get", "accounts.pool.set", "accounts.pool.options"].map(id => ({ id, grade: "stable" })) } } as unknown as Parameters<typeof useAgentAccountPools>[0]["context"];
  render(<SubagentsPanel client={api} context={context} preview={false} models={createPreviewModelConfig()} initialAgent="reviewer" />);
  fireEvent.click(await screen.findByRole("radio", { name: "停用提供商" }));
  fireEvent.click(screen.getByRole("button", { name: "保存子代理" }));
  await screen.findByRole("button", { name: "打开 reviewer 详情" });
  expect(command.mock.calls.filter(([kind]) => kind !== "accounts.pool.get" && kind !== "accounts.pool.options")).toEqual([
    ["accounts.pool.set", { sessionId: "s1", agent: "reviewer", pools: { anthropic: [] } }],
  ]);
});
