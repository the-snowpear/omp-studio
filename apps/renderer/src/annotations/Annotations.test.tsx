import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { AnnotationButton, AnnotationsProvider } from "./Annotations";

afterEach(() => { cleanup(); localStorage.clear(); });
function mount(preview: boolean, client: StudioClient, insert = vi.fn()) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><AnnotationsProvider client={client} workspaceId="w" sessionId="s" runtimeSessionId="s" onInsert={insert}><AnnotationButton source={{ kind: "quote", label: "Source", text: "first\nsecond\n" }} /></AnnotationsProvider></PreviewModeProvider></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "标注" })); return insert;
}
it("preview annotations support edit, delete and undo without Host writes", async () => {
  const client = { command: vi.fn() } as unknown as StudioClient; mount(true, client);
  const source = await screen.findByLabelText("来源快照，可选择文本") as HTMLTextAreaElement;
  source.setSelectionRange(0, 5); fireEvent.select(source);
  fireEvent.change(screen.getByLabelText("标注意见"), { target: { value: "Original note" } });
  fireEvent.click(screen.getByRole("button", { name: "添加标注" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByLabelText("标注意见"), { target: { value: "Edited note" } });
  fireEvent.click(screen.getByRole("button", { name: "保存编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(screen.queryByText("Edited note")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(screen.getByText("Edited note")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(screen.getByText("Original note")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
});
it("requires explicit stale snapshot choice, then inserts text without sending a prompt", async () => {
  const requests = new Map<string, { name: string; input: Record<string, unknown> }>(); let next = 0;
  const command = vi.fn(async (name: string, input: Record<string, unknown>) => { const requestId = "r" + ++next; requests.set(requestId, { name, input }); return { requestId, status: "accepted", commandName: name }; });
  const source = { id: "source", kind: "quote", label: "Source", text: "first\nsecond\n", version: "sha256:" + "0".repeat(64), sessionId: "s" };
  const client = { command, subscribe: (filter: { requestId: string }, listener: (value: unknown) => void) => {
    const request = requests.get(filter.requestId)!;
    const result = request.name === "annotations.capture" ? { source } : { prompt: request.input.allowStale ? "Approved feedback" : "", staleSources: [source.id] };
    queueMicrotask(() => listener({ kind: "command.receipt", receipt: { status: "completed", requestId: filter.requestId, commandName: request.name, result: { result } } })); return () => {};
  } } as unknown as StudioClient;
  const insert = mount(false, client);
  await screen.findByLabelText("来源快照，可选择文本");
  fireEvent.change(screen.getByLabelText("标注意见"), { target: { value: "Fix this" } });
  fireEvent.click(screen.getByRole("button", { name: "添加标注" }));
  fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  const choice = await screen.findByRole("checkbox", { name: "使用捕获的旧版本" });
  expect(insert).not.toHaveBeenCalled(); expect((choice as HTMLInputElement).checked).toBe(false);
  fireEvent.click(choice); fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  await waitFor(() => expect(insert).toHaveBeenCalledWith("Approved feedback"));
  expect(command.mock.calls.some(([name]) => name === "core.prompt")).toBe(false);
});
