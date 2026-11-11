import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { McpRuntimeStatus, PromptTemplateRow } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { McpRuntimePane, PromptTemplatesPane } from "./RuntimeCatalogPanes";
afterEach(() => { cleanup(); localStorage.clear(); });
it("previews template expansion and MCP fixtures without Host or automatic sends", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient; const insert = vi.fn();
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><PromptTemplatesPane client={client} available={false} onInsert={insert} /><McpRuntimePane client={client} available={false} /></PreviewModeProvider></I18nProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /review-change/u }));
  fireEvent.change(await screen.findByLabelText("参数（可用引号包住含空格的参数）"), { target: { value: "src/app.ts" } });
  fireEvent.click(screen.getByRole("button", { name: "预览展开结果" }));
  expect((await screen.findByLabelText("展开的提示词") as HTMLTextAreaElement).value).toContain("src/app.ts");
  expect(insert).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "放入主对话输入框" }));
  expect(insert).toHaveBeenCalledOnce(); expect(client.command).not.toHaveBeenCalled();
  expect(screen.getByText("连接 / 加载中")).toBeTruthy(); expect(screen.getByText("启动失败")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重新授权 filesystem" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看 filesystem 的工具" }));
  expect(screen.getByText("mcp_filesystem_read_file")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重连 docs" }));
  expect(within(screen.getByRole("article", { name: "docs" })).getByText("工具就绪")).toBeTruthy();
  expect(screen.queryByText("启动失败")).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});

function nativeClient(resolve: (kind: string, input: { sessionId: string; id?: string; version?: string; arguments?: string; name?: string; cursor?: string }) => unknown | Promise<unknown>) {
  const commands: Record<string, unknown> = {};
  let request = 0;
  const command = vi.fn(async (kind: string, input: Parameters<typeof resolve>[1]) => {
    const requestId = `catalog-${++request}`;
    const result = await resolve(kind, input);
    commands[requestId] = { status: "completed", result: { result } };
    return { requestId };
  });
  return { client: { command, getState: () => ({ commands }) } as unknown as StudioClient, command };
}

it("loads a template immediately, prepares the selected native version, and invalidates the expansion when arguments change", async () => {
  const user: PromptTemplateRow = { id: "user-review", name: "review", description: "Review files (user)", source: "(user)", version: "a".repeat(64) };
  const project: PromptTemplateRow = { id: "project-review", name: "review", description: "Review changes (project:frontend)", source: "(project:frontend)", version: "b".repeat(64) };
  const extra: PromptTemplateRow = { id: "tests", name: "write-tests", description: "Write tests", source: "(project)", version: "c".repeat(64) };
  const { client, command } = nativeClient((kind, input) => {
    if (kind === "templates.list") return { templates: input.cursor ? [extra] : [user, project], ...(input.cursor ? {} : { nextCursor: "page-2" }) };
    if (kind === "templates.get") return { template: input.id === project.id ? project : user, content: input.id === project.id ? "Project $1 / $2" : "User $ARGUMENTS" };
    if (kind === "templates.prepare") return { text: `Native expansion for ${input.id}: two words / third` };
    throw new Error(`Unexpected command ${kind}`);
  });
  const insert = vi.fn();
  const view = render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><PromptTemplatesPane client={client} sessionId="session" available onInsert={insert} /></PreviewModeProvider></I18nProvider>);
  await screen.findByText("User");
  await waitFor(() => expect(command).toHaveBeenCalledWith("templates.get", { sessionId: "session", id: user.id, version: user.version }));
  fireEvent.click(screen.getByRole("button", { name: /review.*Review changes/u }));
  const field = await screen.findByRole("textbox", { name: "Arguments (quote values containing spaces)" }) as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: '"two words" third' } });
  fireEvent.click(screen.getByRole("button", { name: "More templates" }));
  await screen.findByRole("button", { name: /write-tests/u });
  expect(field.value).toBe('"two words" third');
  fireEvent.click(screen.getByRole("button", { name: "Preview expansion" }));
  expect((await screen.findByRole("textbox", { name: "Expanded prompt" }) as HTMLTextAreaElement).value).toContain("project-review: two words / third");
  expect(command).toHaveBeenCalledWith("templates.prepare", { sessionId: "session", id: project.id, version: project.version, arguments: '"two words" third' });
  expect(insert).not.toHaveBeenCalled();
  view.rerender(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><PromptTemplatesPane client={client} sessionId="session" available visible={false} onInsert={insert} /></PreviewModeProvider></I18nProvider>);
  view.rerender(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><PromptTemplatesPane client={client} sessionId="session" available visible onInsert={insert} /></PreviewModeProvider></I18nProvider>);
  await waitFor(() => expect((screen.getByRole("button", { name: "Preview expansion" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("textbox", { name: "Expanded prompt" }) as HTMLTextAreaElement).value).toContain("project-review: two words / third");
  expect(field.value).toBe('"two words" third');
  fireEvent.change(field, { target: { value: "another" } });
  expect(screen.queryByRole("textbox", { name: "Expanded prompt" })).toBeNull();
  expect((screen.getByRole("button", { name: "Insert into main Composer" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Preview expansion" }));
  await screen.findByRole("textbox", { name: "Expanded prompt" });
  fireEvent.click(screen.getByRole("button", { name: "Insert into main Composer" }));
  expect(insert).toHaveBeenCalledWith("Native expansion for project-review: two words / third");
  expect(command.mock.calls.every(([kind]) => kind.startsWith("templates."))).toBe(true);
});

it("refreshes native readiness after reconnect and exposes tool identity and the startup failure", async () => {
  let connected = false;
  const { client, command } = nativeClient((kind) => {
    if (kind === "mcp.auth.reconnect") { connected = true; return { name: "docs", status: "connected", scope: "project" }; }
    if (kind === "mcp.runtime.status") return {
      available: true, startupTimeoutMs: 0, ready: connected, settled: true, total: 1,
      servers: connected ? [{ name: "docs", state: "ready", transport: "http", tools: 1, toolInfo: [{ name: "mcp_docs_search", mcpServerName: "docs", mcpToolName: "search", description: "Search project docs", readOnlyHint: true }] }] : [{ name: "docs", state: "failed", transport: "http", tools: 0, error: "HTTP 503: Service unavailable" }],
    } satisfies McpRuntimeStatus;
    throw new Error(`Unexpected command ${kind}`);
  });
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><McpRuntimePane client={client} sessionId="session" available authAvailable /></PreviewModeProvider></I18nProvider>);
  await screen.findByText("HTTP 503: Service unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect docs" }));
  await screen.findByText("Tools ready");
  expect(screen.queryByText("HTTP 503: Service unavailable")).toBeNull();
  expect(screen.getByText("Wait for all")).toBeTruthy();
  expect(command).toHaveBeenCalledWith("mcp.auth.reconnect", { sessionId: "session", name: "docs" });
  expect(command.mock.calls.filter(([kind]) => kind === "mcp.runtime.status")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "View tools for docs" }));
  expect(screen.getByText("mcp_docs_search")).toBeTruthy();
  expect(screen.getByText("Search project docs")).toBeTruthy();
  expect(screen.getByText("Read-only hint")).toBeTruthy();
});

it("shows an honest unavailable state when no active Runtime is connected", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><PromptTemplatesPane client={client} available={false} /><McpRuntimePane client={client} available={false} /></PreviewModeProvider></I18nProvider>);
  expect(screen.getAllByText("Connect an active session")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /review-change/u })).toBeNull();
  expect(screen.queryByRole("article", { name: "filesystem" })).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});
