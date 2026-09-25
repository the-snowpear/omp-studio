import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { JudgmentsPane } from "./JudgmentsPane";

afterEach(() => { cleanup(); localStorage.clear(); });
const capabilities = { capabilities: ["judgments.list", "judgments.read", "judgments.create"].map(id => ({ id, grade: "stable" })) } as ClientBootstrap["capabilityManifest"];
function mount(preview: boolean, client: StudioClient) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><JudgmentsPane client={client} workspaceId="w" sessionId="s" available capabilities={capabilities} /></PreviewModeProvider></I18nProvider>);
  const details = screen.getByText(/^批量评审/u).closest("details")!; details.open = true; fireEvent(details, new Event("toggle"));
}
it("preview creates and retries local fixture batches without calling Host", async () => {
  const client = { command: vi.fn() } as unknown as StudioClient; mount(true, client);
  fireEvent.click(screen.getByRole("button", { name: "新建批次" }));
  fireEvent.click(screen.getByRole("button", { name: "填入演示内容" }));
  fireEvent.click(screen.getByRole("button", { name: "检查并准备开始" }));
  expect(screen.getByLabelText("确认批次操作")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await screen.findByRole("button", { name: "保存全部结果" });
  fireEvent.click(screen.getByRole("button", { name: "保存全部结果" }));
  await screen.findByText("演示：结果已存入产物库");
  expect(client.command).not.toHaveBeenCalled();
});
it("freezes reviewed inputs and starts only after confirmation with a session fence", async () => {
  let next = 0; const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const batch = { id: "batch", intent: "Review", total: 1, done: 1, failed: 0, cost: 0.01, running: false, elapsedS: 1 };
  const command = vi.fn(async (name: string, input: Record<string, unknown>) => { const requestId = String(++next); calls.set(requestId, { name, input }); return { requestId }; });
  const client = { command, subscribe: (filter: { requestId: string }, listener: (event: unknown) => void) => {
    const request = calls.get(filter.requestId)!;
    const result = request.name === "judgments.list" ? { batches: [] } : request.name === "judgments.read" ? { batch, items: [], offset: 0, nextOffset: 0 } : { batch };
    queueMicrotask(() => listener({ kind: "command.receipt", receipt: { status: "completed", requestId: filter.requestId, commandName: request.name, result: { result } } })); return () => {};
  } } as unknown as StudioClient;
  mount(false, client);
  fireEvent.click(screen.getByRole("button", { name: "新建批次" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Review" } });
  fireEvent.change(screen.getByLabelText("待评审内容"), { target: { value: "original input" } });
  fireEvent.change(screen.getByLabelText("判断说明"), { target: { value: "Is it clear?" } });
  fireEvent.click(screen.getByRole("button", { name: "检查并准备开始" }));
  expect(command.mock.calls.some(([name]) => name === "judgments.create")).toBe(false);
  fireEvent.change(screen.getByLabelText("待评审内容"), { target: { value: "later edit" } });
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(command.mock.calls.filter(([name]) => name === "judgments.create")).toHaveLength(1));
  const created = command.mock.calls.find(([name]) => name === "judgments.create")![1];
  expect(created.sessionId).toBe("s"); expect((created.spec as { items: unknown[] }).items).toEqual([{ key: 0, state: "original input" }]);
  expect(command.mock.calls.some(([name]) => name === "judgments.retry")).toBe(false);
});
