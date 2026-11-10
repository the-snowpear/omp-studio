import { selectOption } from "../test/selectOption";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { IdaDatabaseTools } from "./IdaDatabaseTools";
import { ResourcesPane } from "./ResourcesPane";
import { PREVIEW_IDA } from "../preview/idaDatabaseToolsPreview";
vi.mock("../hostError", () => ({ waitReceipt: async (client: { results: Record<string, unknown> }, id: string) => client.results[id], hostErrorMessage: (error: Error) => error.message }));
vi.mock("./CapabilityEditor", () => ({ CapabilityEditor: ({ label, value, onChange, readOnly }: { label: string; value: string; onChange?: (value: string) => void; readOnly?: boolean }) => <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange?.(event.target.value)} /> }));
afterEach(() => { cleanup(); localStorage.clear(); });

async function selectDatabase() {
  fireEvent.click(screen.getByRole("combobox", { name: "IDA 数据库" }));
  fireEvent.click(await screen.findByRole("option", { name: "sample.exe · open" }));
}

it("IDA preview requires exact operation review and never reaches Host", async () => {
  localStorage.setItem("omp.previewMode", "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaDatabaseTools client={client} sessionId="s" available /></PreviewModeProvider></I18nProvider>);
  await selectDatabase();
  fireEvent.click(screen.getByRole("button", { name: "修改数据库" }));
  selectOption(screen.getByRole("combobox", { name: "IDA 操作" }), "保存数据库");
  fireEvent.click(screen.getByRole("button", { name: "检查操作" }));
  expect(await screen.findByRole("dialog", { name: "确认 IDA 操作" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(await screen.findByText("演示操作已完成")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});

it("resource preview reads local fixtures without Host calls", async () => {
  localStorage.setItem("omp.previewMode", "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ResourcesPane client={client} sessionId="s" available /></PreviewModeProvider></I18nProvider>);
  const uriTab = screen.queryByRole("tab", { name: /URI/ });
  if (uriTab) fireEvent.click(uriTab);
  fireEvent.change(screen.getByLabelText("Resource URI"), { target: { value: "local://notes.md" } });
  fireEvent.click(screen.getByRole("button", { name: "读取" }));
  await waitFor(() => expect(screen.getByDisplayValue(/This is a local preview/)).toBeTruthy());
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});

it.each(["resources", "ida"])("%s releases busy state after a late response from the previous session", async kind => {
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const results: Record<string, unknown> = { status: { result: PREVIEW_IDA }, read: pending };
  const ids = kind === "ida" ? ["ida.status", "ida.view", "ida.prepare", "ida.commit"] : ["resource.read"];
  const client = { results, query: vi.fn(async () => ({ capabilities: ids.map(id => ({ id, grade: "native" })) })), command: vi.fn(async (name: string) => ({ requestId: name === "ida.status" ? "status" : "read" })) } as unknown as StudioClient;
  const surface = (sessionId: string) => <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled>{kind === "ida" ? <IdaDatabaseTools client={client} sessionId={sessionId} available /> : <ResourcesPane client={client} sessionId={sessionId} available />}</PreviewModeProvider></I18nProvider>;
  const { rerender } = render(surface("first"));
  if (kind === "ida") await selectDatabase();
  else { const tab = screen.queryByRole("tab", { name: /URI/ }); if (tab) fireEvent.click(tab); fireEvent.change(screen.getByLabelText("Resource URI"), { target: { value: "local://notes.md" } }); }
  await waitFor(() => expect(screen.getByRole("button", { name: "读取" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "读取" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /读取/ })).toHaveProperty("disabled", true));
  rerender(surface("second"));
  await act(async () => { complete({ result: { text: "stale first session", offset: 0, total: 1, truncated: false } }); await pending; });
  if (kind === "ida") await selectDatabase();
  else { const tab = screen.queryByRole("tab", { name: /URI/ }); if (tab) fireEvent.click(tab); fireEvent.change(screen.getByLabelText("Resource URI"), { target: { value: "local://notes.md" } }); }
  await waitFor(() => expect(screen.getByRole("button", { name: "读取" })).toHaveProperty("disabled", false));
  expect(screen.queryByDisplayValue("stale first session")).toBeNull();
});

it("pages the original IDA view and version even if the address draft changed", async () => {
  const results = { "ida.status": { result: PREVIEW_IDA }, "ida.view": { result: { text: "first page", total: 120, offset: 0, nextOffset: 100, truncated: false } } };
  const command = vi.fn(async (kind: string) => ({ requestId: kind }));
  const client = { command, results, query: vi.fn(async () => ({ capabilities: ["ida.status", "ida.view"].map(id => ({ id, grade: "native" })) })) } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaDatabaseTools client={client} sessionId="s" available /></PreviewModeProvider></I18nProvider>);
  await selectDatabase();
  selectOption(screen.getByRole("combobox", { name: "IDA 视图" }), "函数");
  fireEvent.change(screen.getByLabelText("地址 / 符号"), { target: { value: "main" } });
  fireEvent.click(screen.getByRole("button", { name: "读取" }));
  await screen.findByDisplayValue("first page");
  fireEvent.change(screen.getByLabelText("地址 / 符号"), { target: { value: "other" } });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(command).toHaveBeenLastCalledWith("ida.view", { sessionId: "s", dbId: "demo-db", identity: "preview-demo-db", version: 1, view: "functions", target: "main", offset: 100 }));
});

it("consumes the reviewed token once and does not offer replay after a failed commit", async () => {
  const results = { "ida.status": { result: PREVIEW_IDA }, "ida.prepare": { result: { token: "one-time-token", edit: { action: "save", dbId: "demo-db" }, identity: "preview-demo-db", version: 1, expiresAt: Date.now() + 300_000 } } };
  const command = vi.fn(async (kind: string) => { if (kind === "ida.commit") throw Error("Database changed; review again"); return { requestId: kind }; });
  const client = { command, results, query: vi.fn(async () => ({ capabilities: ["ida.status", "ida.view", "ida.prepare", "ida.commit"].map(id => ({ id, grade: "native" })) })) } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><IdaDatabaseTools client={client} sessionId="s" available /></PreviewModeProvider></I18nProvider>);
  await selectDatabase();
  fireEvent.click(screen.getByRole("button", { name: "修改数据库" }));
  selectOption(screen.getByRole("combobox", { name: "IDA 操作" }), "保存数据库");
  fireEvent.click(screen.getByRole("button", { name: "检查操作" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认执行" }));
  await screen.findByText("Database changed; review again");
  expect(command).toHaveBeenCalledWith("ida.commit", { sessionId: "s", token: "one-time-token" });
  expect(screen.queryByRole("button", { name: "确认执行" })).toBeNull();
});
