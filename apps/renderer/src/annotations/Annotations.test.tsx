import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { AnnotationCapture } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { AnnotationButton, AnnotationsProvider, OpenAnnotationArtifact } from "./Annotations";
import { DockProvider } from "../dock/DockContext";
import { DockFloatingLayer } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
// Resolve the production lazy module before assertions use Testing Library's timeout.
import "./AnnotationDialog";

const rects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const bounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalUrl = location.pathname + location.search;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1200, 760));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 1200, 760)] as unknown as DOMRectList);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});
afterEach(() => {
  cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (rects) Object.defineProperty(Range.prototype, "getClientRects", rects); else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (bounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", bounds); else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  history.replaceState(null, "", originalUrl);
});
const defaultCapture: AnnotationCapture = { kind: "quote", label: "Source", text: "first\nsecond\n" };
function Surface({ preview, client, insert, source = defaultCapture }: {
  preview: boolean; client: StudioClient; insert: (text: string) => void; source?: AnnotationCapture;
}) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  const [store] = useState(() => new DockStore(null));
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><DockProvider definitions={WORKBENCH_PANELS} store={store}><div className="adaptive-workbench" /><AnnotationsProvider client={client} workspaceId="w" sessionId="s" runtimeSessionId="s" onInsert={insert}>
    <AnnotationButton source={source} />
    <AnnotationButton source={{ kind: "quote", label: "Second source", text: "other snapshot" }} label="标注另一份来源" />
    <AnnotationButton label="打开标注窗口" />
    <OpenAnnotationArtifact artifactId="saved" />
  </AnnotationsProvider><DockFloatingLayer /></DockProvider></PreviewModeProvider></I18nProvider>;
}
function mount(preview: boolean, client: StudioClient, insert = vi.fn(), source = defaultCapture) {
  const view = render(<Surface preview={preview} client={client} insert={insert} source={source} />);
  fireEvent.click(screen.getByRole("button", { name: "标注" }));
  return { insert, ...view };
}
it("Escape dismisses the source importer before closing the focused annotation window", async () => {
  render(<Surface preview={true} client={{ command: vi.fn() } as unknown as StudioClient} insert={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "打开标注窗口" }));
  const sources = await screen.findByRole("navigation", { name: "标注来源" });
  fireEvent.click(sources.querySelector("button")!);
  const path = await screen.findByRole("textbox", { name: "工作区相对文件路径" });
  fireEvent.keyDown(path, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "工作区相对文件路径" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "标注" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "关闭标注" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "标注" })).toBeNull();
});
async function select(start: number, end: number) {
  const element = await screen.findByRole("textbox", { name: "来源快照，可选择文本" });
  const editor = EditorView.findFromDOM(element)!;
  act(() => editor.dispatch({ selection: { anchor: start, head: end } }));
  return editor;
}
const draft = () => screen.getByLabelText("标注意见") as HTMLTextAreaElement;
function addNote(text: string) {
  fireEvent.change(draft(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "添加标注" }));
}
function realClient(stale = false) {
  const requests = new Map<string, { name: string; input: Record<string, unknown> }>(); let next = 0;
  const source = { id: "source", kind: "quote", label: "Source", text: "first\nsecond\n", version: "sha256:" + "0".repeat(64), sessionId: "s" };
  const command = vi.fn(async (name: string, input: Record<string, unknown>) => {
    const requestId = "r" + ++next; requests.set(requestId, { name, input }); return { requestId, status: "accepted", commandName: name };
  });
  const client = { command, subscribe: (filter: { requestId: string }, listener: (value: unknown) => void) => {
    const request = requests.get(filter.requestId)!;
    const result = request.name === "annotations.capture" ? { source } : {
      prompt: stale && !request.input.allowStale ? "" : "Approved feedback", staleSources: stale ? [source.id] : [],
    };
    queueMicrotask(() => listener({ kind: "command.receipt", receipt: { status: "completed", requestId: filter.requestId, commandName: request.name, result: { result } } }));
    return () => {};
  } } as unknown as StudioClient;
  return { client, command };
}

it("preview annotations support exact selection, edit, delete and repeated undo without Host writes", async () => {
  const client = { command: vi.fn() } as unknown as StudioClient; mount(true, client);
  const reader = await select(0, 5);
  // Chromium collapses the reader selection as focus moves into the note field.
  act(() => { draft().focus(); reader.dispatch({ selection: { anchor: 5 } }); });
  addNote("Original note");
  expect(document.querySelector(".annotation-note-quote")?.textContent).toBe("first");
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  expect(draft().value).toBe("Original note");
  fireEvent.change(draft(), { target: { value: "Edited note" } });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(draft().value).toBe("Edited note");
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
  const { client, command } = realClient(true); const { insert } = mount(false, client);
  await screen.findByRole("textbox", { name: "来源快照，可选择文本" }); addNote("Fix this");
  fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  const choice = await screen.findByRole("checkbox", { name: "使用捕获的旧版本" });
  expect(insert).not.toHaveBeenCalled(); expect((choice as HTMLInputElement).checked).toBe(false);
  fireEvent.click(choice); fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  await waitFor(() => expect(insert).toHaveBeenCalledWith("Approved feedback"));
  expect(command.mock.calls.some(([name]) => name === "core.prompt")).toBe(false);
});

it("Enter saves a note, Shift+Enter does not submit, and saving an empty edit deletes with undo", async () => {
  mount(true, { command: vi.fn() } as unknown as StudioClient);
  await select(0, 5);
  fireEvent.change(draft(), { target: { value: "Line feedback" } });
  fireEvent.keyDown(draft(), { key: "Enter", shiftKey: true });
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  expect((screen.getByRole("button", { name: "放入输入框" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(draft(), { key: "Enter" });
  expect(await screen.findByText("Line feedback")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(draft(), { target: { value: "" } });
  fireEvent.keyDown(draft(), { key: "Enter" });
  expect(screen.queryByText("Line feedback")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(screen.getByText("Line feedback")).toBeTruthy();
});

it("closing and restarting restores an unfinished edit and its exact anchor", async () => {
  const { client } = realClient(); const { unmount } = mount(false, client);
  await select(6, 12); addNote("Original");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(draft(), { target: { value: "Unfinished revision" } });
  fireEvent.keyDown(draft(), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  render(<Surface preview={false} client={client} insert={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "打开标注窗口" }));
  await waitFor(() => expect(draft().value).toBe("Unfinished revision"));
  expect(screen.getByRole("button", { name: "保存编辑" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存编辑" }));
  const bundle = JSON.parse(localStorage.getItem("omp.annotations.v1:w:s")!);
  expect(bundle.notes).toHaveLength(1);
  expect(bundle.notes[0]).toMatchObject({ note: "Unfinished revision", selection: { start: 6, end: 12 } });
});

it("restoring a draft on the second source keeps that source selected after saving", async () => {
  const version = "sha256:" + "0".repeat(64);
  localStorage.setItem("omp.annotations.v1:w:s", JSON.stringify({ schemaVersion: 1, revision: 2,
    sources: [
      { id: "first", kind: "quote", label: "First saved source", text: "alpha", version },
      { id: "second", kind: "quote", label: "Second saved source", text: "beta", version },
    ],
    notes: [{ id: "editing", sourceId: "second", note: "Original second note", selection: { start: 0, end: 4 } }],
  }));
  localStorage.setItem("omp.annotations.v1:w:s:editor", JSON.stringify({
    second: { text: "Restored second note", editing: "editing", selection: { start: 0, end: 4 } },
  }));
  render(<Surface preview={false} client={{} as StudioClient} insert={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "打开标注窗口" }));
  await waitFor(() => expect(draft().value).toBe("Restored second note"));
  fireEvent.click(screen.getByRole("button", { name: "保存编辑" }));
  expect(screen.getByText("Restored second note")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Second saved source/ }).getAttribute("aria-current")).toBe("true");
});

it("source switching keeps unfinished notes attached to their own snapshots", async () => {
  mount(true, { command: vi.fn() } as unknown as StudioClient);
  await select(0, 5);
  fireEvent.change(draft(), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "关闭标注" }));
  fireEvent.click(screen.getByRole("button", { name: "标注另一份来源" }));
  await screen.findByRole("button", { name: /Second source/ });
  expect(draft().value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: /^Source/ }));
  expect(draft().value).toBe("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "添加标注" }));
  expect(screen.getByText("Keep this draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Second source/ }));
  expect(screen.queryByText("Keep this draft")).toBeNull();
});

it("preserves CRLF and surrogate-pair offsets in the quoted feedback", async () => {
  const text = "first\r\n🙂 second\r\nlast";
  const client = { command: vi.fn() } as unknown as StudioClient;
  const { insert } = mount(true, client, vi.fn(), { kind: "quote", label: "Unicode source", text });
  const editor = await select(7, 16);
  expect(editor.state.doc.toString()).toBe(text);
  addNote("Exact selection");
  fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  await waitFor(() => expect(insert).toHaveBeenCalled());
  expect(insert.mock.calls[0]![0]).toContain(text.slice(7, 16));
  expect(client.command).not.toHaveBeenCalled();
});

it("native a/A/e/u shortcuts retain line and whole-source annotation modes", async () => {
  mount(true, { command: vi.fn() } as unknown as StudioClient);
  const editor = await select(6, 12);
  act(() => editor.focus());
  fireEvent.keyDown(editor.contentDOM, { key: "a" });
  expect(document.activeElement).toBe(draft());
  addNote("Line note");
  fireEvent.keyDown(editor.contentDOM, { key: "A", shiftKey: true });
  addNote("Whole-source note");
  fireEvent.keyDown(editor.contentDOM, { key: "e" });
  const chooser = await screen.findByRole("dialog", { name: "选择要编辑的标注" });
  expect(chooser).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Whole-source note" }));
  expect(draft().value).toBe("Whole-source note");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.keyDown(editor.contentDOM, { key: "u" });
  expect(screen.queryByText("Whole-source note")).toBeNull();
  expect(screen.getByText("Line note")).toBeTruthy();
});

it("recapturing the same snapshot reopens its notes without duplicating the source", async () => {
  mount(true, { command: vi.fn() } as unknown as StudioClient);
  await select(0, 5); addNote("Existing feedback");
  fireEvent.click(screen.getByRole("button", { name: "关闭标注" }));
  fireEvent.click(screen.getByRole("button", { name: "标注" }));
  await screen.findByText("Existing feedback");
  expect(screen.getAllByRole("button", { name: /^Source/ })).toHaveLength(1);
});

it("review requires a note on the diff, not just a note on another source", async () => {
  const client = { command: vi.fn() } as unknown as StudioClient; mount(true, client);
  await select(0, 5); addNote("Reply feedback");
  fireEvent.click(screen.getByRole("button", { name: "添加来源" }));
  fireEvent.click(screen.getByRole("tab", { name: "当前改动" }));
  fireEvent.click(screen.getByRole("button", { name: "读取改动" }));
  await screen.findByRole("button", { name: "准备审查" });
  expect((screen.getByRole("button", { name: "准备审查" }) as HTMLButtonElement).disabled).toBe(true);
  addNote("Verify the diff independently");
  expect((screen.getByRole("button", { name: "准备审查" }) as HTMLButtonElement).disabled).toBe(false);
  expect(client.command).not.toHaveBeenCalled();
});

it("marks-off previews prepare feedback without demonstration copy or Host operations", async () => {
  history.replaceState(null, "", "?preview=1&marks=off");
  const client = { command: vi.fn() } as unknown as StudioClient; const { insert } = mount(true, client);
  await select(0, 5); addNote("Preview feedback");
  expect(screen.queryByText("演示")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  await waitFor(() => expect(insert).toHaveBeenCalled());
  expect(insert.mock.calls[0]![0]).not.toContain("演示");
  expect(client.command).not.toHaveBeenCalled();
});
