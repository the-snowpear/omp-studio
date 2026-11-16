import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { PromptHistoryItem, PromptHistoryQueryResultMap, PromptHistoryReference } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { SurfaceProvider, surfaceWindow } from "../dock/SurfaceContext";
import { PreviewSurface } from "../preview/PreviewContext";
import { previewPromptBody } from "../preview/promptHistoryPreview";
import type { ChipComposerHandle } from "./ChipComposer";
import { PromptHistoryButton } from "./PromptHistory";

type ReadResult = PromptHistoryQueryResultMap["history.prompts.read"];
const rows: PromptHistoryItem[] = [1, 2, 3].map(id => ({ id, revision: `r${id}`, preview: `Saved prompt ${id}`, createdAt: Date.now(), useCount: 1 }));
const frames: HTMLIFrameElement[] = [];
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  frames.splice(0).forEach(frame => frame.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (scrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
function bodyFor(reference: PromptHistoryReference): ReadResult {
  return { id: reference.id, revision: reference.revision, prompt: `${reference.sessionId}/${reference.scope}/${reference.id}\nFull original prompt, beyond the list preview.`, truncated: false };
}
function historyClient(read: (reference: PromptHistoryReference) => ReadResult | Promise<ReadResult> = bodyFor) {
  const query = vi.fn(async (kind: string, input: PromptHistoryReference) => {
    if (kind === "history.prompts.list") return { sessionId: input.sessionId, scope: input.scope, items: rows, truncated: false };
    if (kind === "history.prompts.read") return read(input);
    throw new Error(`Unexpected query: ${kind}`);
  });
  const command = vi.fn(async (_kind: string, _input: PromptHistoryReference) => ({ requestId: "delete" }));
  const client = {
    query, command,
    getState: () => ({ commands: { delete: { status: "completed", result: { id: 2, deleted: true } } } }),
    subscribe: () => () => {},
  } as unknown as StudioClient;
  return { client, query, command, reads: () => query.mock.calls.filter(([kind]) => kind === "history.prompts.read").map(([, input]) => input) };
}
async function click(element: Element) {
  await act(async () => { fireEvent.click(element); });
}
async function advance(milliseconds = 260) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
function mountHistory(client: StudioClient, { preview = false, surface = document }: { preview?: boolean; surface?: Document } = {}) {
  const insertText = vi.fn(), focus = vi.fn();
  const composerRef = { current: { insertText, focus } as unknown as ChipComposerHandle };
  let language: "zh" | "en" = "zh", sessionId = "runtime";
  const tree = () => <I18nProvider forcedLanguage={language}><PreviewSurface preview={preview}><SurfaceProvider document={surface}>
    <PromptHistoryButton client={client} sessionId={sessionId} ownSession available canDelete composerRef={composerRef} />
  </SurfaceProvider></PreviewSurface></I18nProvider>;
  const container = surface.createElement("div");
  surface.body.append(container);
  const view = render(tree(), { container });
  const ui = within(surface.body);
  return {
    ...view, ui, insertText, focus,
    open: () => click(ui.getByRole("button", { name: language === "zh" ? "输入历史" : "Prompt history" })),
    body: () => ui.getByRole("region", { name: /^(完整内容|Full prompt)$/ }).querySelector("pre")?.textContent,
    update: async (nextLanguage: "zh" | "en", nextSessionId = sessionId) => {
      language = nextLanguage; sessionId = nextSessionId;
      await act(async () => { view.rerender(tree()); });
    },
  };
}

it("keeps the body on a repeated scope click and rereads unchanged references after scope or search changes", async () => {
  const api = historyClient();
  const view = mountHistory(api.client);
  await view.open();
  await advance();
  expect(view.body()).toBe(bodyFor({ sessionId: "runtime", scope: "workspace", id: 1, revision: "r1" }).prompt);

  await click(view.ui.getByRole("tab", { name: "本项目" }));
  await advance();
  expect(view.body()).toContain("runtime/workspace/1");
  expect(api.reads()).toHaveLength(1);

  await click(view.ui.getByRole("tab", { name: "本会话" }));
  await advance();
  expect(view.body()).toBe(bodyFor({ sessionId: "runtime", scope: "session", id: 1, revision: "r1" }).prompt);
  await click(view.ui.getByRole("tab", { name: "本项目" }));
  await advance();
  expect(view.body()).toContain("runtime/workspace/1");
  expect(api.reads().map(input => input.scope)).toEqual(["workspace", "session", "workspace"]);

  fireEvent.change(view.ui.getByRole("textbox"), { target: { value: "Saved" } });
  await advance(180);
  await advance();
  expect(view.body()).toContain("runtime/workspace/1");
  expect(api.reads()).toHaveLength(4);
  expect(view.insertText).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
});

it("keeps a failed deletion visible after successfully refreshing the history list", async () => {
  const api = historyClient();
  vi.spyOn(api.client as unknown as { getState(): unknown }, "getState").mockReturnValue({ commands: { delete: { status: "failed", error: { code: "COMMAND_BLOCKED", message: "The prompt was submitted again" } } } });
  const view = mountHistory(api.client);
  await view.open();
  await advance();
  const selected = view.ui.getByRole("option", { selected: true });
  await click(within(selected).getByRole("button", { name: "从历史中删除" }));
  await click(within(selected).getByRole("button", { name: "确认删除这条记录" }));
  expect(api.query.mock.calls.filter(([kind]) => kind === "history.prompts.list")).toHaveLength(2);
  expect(view.ui.getByRole("alert").textContent).toContain("The prompt was submitted again");
  expect(view.ui.getByText("Saved prompt 1")).toBeTruthy();
  expect(view.insertText).not.toHaveBeenCalled();
});

it("refreshes demo bodies through zh → en → zh without losing the selection, search or delete confirmation", async () => {
  const api = historyClient();
  const view = mountHistory(api.client, { preview: true });
  await view.open();
  const search = view.ui.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(search, { target: { value: " " } });
  await advance(180);
  fireEvent.pointerEnter(view.ui.getAllByRole("option")[1]!);
  await advance();
  await click(within(view.ui.getByRole("option", { selected: true })).getByRole("button", { name: "从历史中删除" }));
  expect(view.body()).toBe(previewPromptBody(2, true)!.prompt);

  for (const language of ["en", "zh"] as const) {
    await view.update(language);
    await advance();
    const selected = view.ui.getByRole("option", { selected: true });
    expect(selected.id).toBe("ph-2");
    expect(within(selected).getByRole("button", { name: language === "zh" ? "确认删除这条记录" : "Confirm delete" })).toBeTruthy();
    expect(view.body()).toBe(previewPromptBody(2, language === "zh")!.prompt);
    expect(view.ui.getByRole("textbox")).toBe(search);
    expect(search.value).toBe(" ");
  }
  expect(api.query).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
  expect(view.insertText).not.toHaveBeenCalled();
});

it("keeps real body reads and pending deletion alive across locale-only changes", async () => {
  const pendingBody = deferred<ReadResult>();
  const api = historyClient(reference => reference.id === 2 ? pendingBody.promise : bodyFor(reference));
  const view = mountHistory(api.client);
  await view.open();
  await advance();
  fireEvent.pointerEnter(view.ui.getAllByRole("option")[1]!);
  await advance();
  await click(within(view.ui.getByRole("option", { selected: true })).getByRole("button", { name: "从历史中删除" }));

  for (const language of ["en", "zh"] as const) {
    await view.update(language);
    await advance();
    const selected = view.ui.getByRole("option", { selected: true });
    expect(selected.id).toBe("ph-2");
    expect(within(selected).getByRole("button", { name: language === "zh" ? "确认删除这条记录" : "Confirm delete" })).toBeTruthy();
  }
  const reference: PromptHistoryReference = { sessionId: "runtime", scope: "workspace", id: 2, revision: "r2" };
  await act(async () => { pendingBody.resolve(bodyFor(reference)); });
  expect(view.body()).toBe(bodyFor(reference).prompt);
  expect(api.reads().filter(input => input.id === 2)).toHaveLength(1);

  const pendingDelete = deferred<{ requestId: string }>();
  api.command.mockReturnValueOnce(pendingDelete.promise);
  await click(view.ui.getByRole("button", { name: "确认删除这条记录" }));
  await view.update("en");
  await view.update("zh");
  await act(async () => { pendingDelete.resolve({ requestId: "delete" }); });
  expect(view.ui.queryByText("Saved prompt 2")).toBeNull();
  expect(api.command).toHaveBeenCalledExactlyOnceWith("history.prompts.delete", reference);
  expect(api.query.mock.calls.filter(([kind]) => kind === "history.prompts.list")).toHaveLength(1);
  expect(view.insertText).not.toHaveBeenCalled();
});

it("debounces hover reads and reuses the latest cached body when returning to a row", async () => {
  const api = historyClient();
  const view = mountHistory(api.client);
  await view.open();
  await advance();
  const options = view.ui.getAllByRole("option");
  fireEvent.pointerEnter(options[1]!);
  await advance(100);
  fireEvent.pointerEnter(options[2]!);
  await advance(259);
  expect(api.reads().map(input => input.id)).toEqual([1]);
  await advance(1);
  expect(view.body()).toContain("runtime/workspace/3");
  fireEvent.pointerEnter(options[0]!);
  await advance();
  expect(view.body()).toContain("runtime/workspace/1");
  await advance();
  expect(api.reads().map(input => input.id)).toEqual([1, 3]);
});

it("does not insert or display a late body from a previous session", async () => {
  const pending = deferred<ReadResult>();
  const api = historyClient(reference => reference.sessionId === "runtime" ? pending.promise : bodyFor(reference));
  const view = mountHistory(api.client);
  await view.open();
  await advance();
  await click(view.ui.getAllByRole("option")[0]!);
  await view.update("zh", "other-session");
  expect(view.ui.queryByRole("dialog")).toBeNull();
  await act(async () => { pending.resolve(bodyFor({ sessionId: "runtime", scope: "workspace", id: 1, revision: "r1" })); });
  expect(view.insertText).not.toHaveBeenCalled();
  expect(view.ui.queryByRole("dialog")).toBeNull();

  await view.open();
  await advance();
  expect(view.body()).toBe(bodyFor({ sessionId: "other-session", scope: "workspace", id: 1, revision: "r1" }).prompt);
  expect(api.command).not.toHaveBeenCalled();
});

it("owns its portal, sizing, focus and outside-pointer handling in the detached document", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const surface = frame.contentDocument!;
  const childWindow = surfaceWindow(surface);
  Object.defineProperties(childWindow, {
    innerWidth: { configurable: true, writable: true, value: 400 },
    innerHeight: { configurable: true, writable: true, value: 620 },
  });
  Object.defineProperty(childWindow.Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const api = historyClient();
  const view = mountHistory(api.client, { surface });
  const opener = view.ui.getByRole("button", { name: "输入历史" });
  vi.spyOn(opener.parentElement!, "getBoundingClientRect").mockReturnValue(new childWindow.DOMRect(300, 420, 44, 24));
  await view.open();
  const dialog = view.ui.getByRole("dialog");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(dialog.ownerDocument).toBe(surface);
  expect(dialog.style.width).toBe("368px");
  expect(dialog.style.left).toBe("16px");
  expect(dialog.style.bottom).toBe("210px");
  expect(surface.activeElement).toBe(view.ui.getByRole("textbox"));

  Object.defineProperties(childWindow, { innerWidth: { value: 360 }, innerHeight: { value: 540 } });
  fireEvent.resize(window);
  expect(dialog.style.width).toBe("368px");
  fireEvent.resize(childWindow);
  expect(dialog.style.width).toBe("328px");
  expect(dialog.style.bottom).toBe("130px");
  fireEvent.pointerDown(view.ui.getByRole("textbox"));
  expect(view.ui.getByRole("dialog")).toBe(dialog);
  fireEvent.pointerDown(document.body);
  expect(view.ui.getByRole("dialog")).toBe(dialog);
  fireEvent.pointerDown(surface.body);
  expect(view.ui.queryByRole("dialog")).toBeNull();

  await click(opener);
  fireEvent.keyDown(view.ui.getByRole("textbox"), { key: "Escape" });
  expect(view.ui.queryByRole("dialog")).toBeNull();
  expect(view.focus).toHaveBeenCalledOnce();
  expect(view.insertText).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
});
