import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PREVIEW_IDA, PREVIEW_IDA_RESULT } from "../preview/idaPreview";
import { IdaPane } from "./IdaPane";

vi.mock("./CapabilityEditor", () => ({ CapabilityEditor: ({ label, value, onChange, readOnly }: { label: string; value: string; onChange?: (value: string) => void; readOnly?: boolean }) => <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange?.(event.target.value)} /> }));
vi.mock("../hostError", () => ({ waitReceipt: async (client: { results: Record<string, unknown> }, id: string) => client.results[id], hostErrorMessage: (error: Error) => error.message }));
afterEach(() => { cleanup(); localStorage.clear(); });

it("previews reviewed Python execution without Host calls and keeps drafts per database while hidden", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  const view = (visible: boolean) => <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} available visible={visible} /></PreviewModeProvider></I18nProvider>;
  const { rerender } = render(view(true));
  await waitFor(() => expect(screen.getByRole("button", { name: /sample.exe/ })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("tab", { name: "Python" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Python" }), { target: { value: "print(db)" } });
  rerender(view(false)); rerender(view(true));
  expect(screen.getByDisplayValue("print(db)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /parser.dll/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /parser.dll/ })).toHaveProperty("disabled", false));
  fireEvent.change(screen.getByRole("textbox", { name: "Python" }), { target: { value: "print('library')" } });
  fireEvent.click(screen.getByRole("button", { name: /sample.exe/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /sample.exe/ })).toHaveProperty("disabled", false));
  expect(screen.getByRole("textbox", { name: "Python" })).toHaveProperty("value", "print(db)");
  fireEvent.click(screen.getByRole("button", { name: /运行请求/ }));
  expect(screen.getByRole("dialog", { name: "确认 IDA 操作" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "待执行 Python" })).toHaveProperty("value", "print(db)");
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await screen.findByText(PREVIEW_IDA_RESULT.output);
  fireEvent.click(screen.getByRole("button", { name: /parser.dll/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /parser.dll/ })).toHaveProperty("disabled", false));
  expect(screen.queryByText(PREVIEW_IDA_RESULT.output)).toBeNull();
  expect(screen.getByDisplayValue("print('library')")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});

it("gates native actions without an advertised IDA capability and never shows fixture databases", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} available sessionId="s" /></PreviewModeProvider></I18nProvider>);
  fireEvent.change(screen.getByPlaceholderText("文件路径"), { target: { value: "sample.exe" } });
  expect(screen.getByRole("button", { name: "打开数据库" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: /sample.exe/ })).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});

it("shows native Python errors even when the command completed and retains recovery paths", async () => {
  const results = { "ida.status.details": { result: PREVIEW_IDA }, "ida.run": { result: { ...PREVIEW_IDA_RESULT, output: "before failure", error: "ValueError: invalid record" } } };
  const command = vi.fn(async (kind: string) => ({ requestId: kind }));
  const client = { command, results, query: vi.fn(async () => ({ capabilities: [] })) } as unknown as StudioClient;
  const capabilities = { capabilities: ["ida.status.details", "ida.run"].map(id => ({ id, grade: "native" })) } as never;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} available sessionId="s" capabilities={capabilities} /></PreviewModeProvider></I18nProvider>);
  await screen.findByRole("button", { name: /sample.exe/ });
  fireEvent.click(screen.getByRole("tab", { name: "Python" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Python" }), { target: { value: "raise ValueError('invalid record')" } });
  fireEvent.click(screen.getByRole("button", { name: /运行请求/ }));
  expect(command).not.toHaveBeenCalledWith("ida.run", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await screen.findByText("ValueError: invalid record");
  expect(command).toHaveBeenCalledWith("ida.run", { sessionId: "s", id: "demo-db", code: "raise ValueError('invalid record')", timeoutMs: 120_000 });
  expect(screen.getByText(PREVIEW_IDA_RESULT.backup)).toBeTruthy();
  expect(screen.getByText(PREVIEW_IDA_RESULT.resultFile)).toBeTruthy();
});

it("requires confirmation before closing and removes only the selected preview database", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaPane client={client} available /></PreviewModeProvider></I18nProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并关闭" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("button", { name: /sample.exe/ })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并关闭" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /sample.exe/ })).toBeNull());
  expect(screen.getByRole("button", { name: /parser.dll/ })).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
});
