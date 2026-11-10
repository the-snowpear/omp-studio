import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PREVIEW_NEXT_MESSAGES } from "../preview/nextMessagePreview";
import { ChipComposer } from "./ChipComposer";
import { predictionDraft } from "./useWordPrediction";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
function caret(editor: HTMLElement, offset?: number) {
  editor.focus();
  const range = document.createRange();
  if (offset === undefined) {
    range.selectNodeContents(editor);
    range.collapse(false);
  } else {
    range.setStart(editor.firstChild!, offset);
    range.collapse(true);
  }
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
it("keeps hidden chip content out of prediction and skips oversized drafts", () => {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.append(document.createTextNode("please "));
  const chip = document.createElement("span");
  chip.className = "cm-chip";
  chip.contentEditable = "false";
  chip.textContent = "private-attachment-name";
  editor.append(chip, document.createTextNode(" re"));
  document.body.append(editor);
  try {
    caret(editor);
    const result = predictionDraft(editor)!;
    expect(result.text).not.toContain("private-attachment-name");
    expect(result.text.slice(0, result.caret)).toContain(" re");
    editor.textContent = "x".repeat(4097);
    caret(editor);
    expect(predictionDraft(editor)).toBeUndefined();
  } finally {
    editor.remove();
  }
});
it("inserts word and alternative message predictions into the draft without submitting", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const original = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(100, 40, 0, 20),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 200),
  );
  const client = { command: vi.fn() } as unknown as StudioClient;
  const submit = vi.fn();
  try {
    const mounted = render(
      <I18nProvider forcedLanguage="en">
        <PreviewModeProvider switchEnabled>
          <ChipComposer
            prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }}
            placeholder="Enter a message"
            onSubmit={submit}
          />
        </PreviewModeProvider>
      </I18nProvider>,
    );
    const editor = screen.getByRole("textbox");
    editor.textContent = "please revi";
    caret(editor);
    fireEvent.input(editor);
    await waitFor(() =>
      expect(
        mounted.container.querySelector(".cm-prediction")?.textContent,
      ).toBe("ewTab"),
    );
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.textContent).toBe("please review ");
    editor.textContent = ""; caret(editor); fireEvent.input(editor);
    await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]));
    expect(editor.getAttribute("data-prediction-visible")).toBe("true");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(editor.hasAttribute("data-prediction-visible")).toBe(false);
    fireEvent.input(editor);
    await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]));
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(editor.textContent).toBe(PREVIEW_NEXT_MESSAGES[0]);
    expect(editor.hasAttribute("data-prediction-visible")).toBe(false);
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(screen.getAllByRole("option")).toHaveLength(4);
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe(PREVIEW_NEXT_MESSAGES[1]);
    expect(submit).not.toHaveBeenCalled();
    expect(client.command).not.toHaveBeenCalled();
  } finally {
    if (original)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});

it("does not overlay a suggestion on text after the caret", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const original = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(100, 40, 0, 20),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  const client = { command: vi.fn() } as unknown as StudioClient;
  try {
    const mounted = render(
      <PreviewModeProvider switchEnabled>
        <ChipComposer prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }} />
      </PreviewModeProvider>,
    );
    const editor = screen.getByRole("textbox");
    editor.textContent = PREVIEW_NEXT_MESSAGES[0]!.slice(0, 6);
    caret(editor, 2);
    fireEvent.input(editor);
    await act(() => new Promise(resolve => setTimeout(resolve, 220)));
    expect(mounted.container.querySelector(".cm-prediction")).toBeNull();

    caret(editor);
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull());
  } finally {
    if (original) Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});

it("shows the next-message suggestion before focus and keeps it when focus leaves", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(
    <PreviewModeProvider switchEnabled>
      <ChipComposer placeholder="Enter a message" prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }} />
      <button type="button">Other control</button>
    </PreviewModeProvider>,
  );
  const editor = screen.getByRole("textbox");
  expect(document.activeElement).not.toBe(editor);
  await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]));
  expect(editor.getAttribute("data-prediction-visible")).toBe("true");

  act(() => caret(editor));
  expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();
  act(() => screen.getByRole("button", { name: "Other control" }).focus());
  expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();
  expect(editor.getAttribute("data-prediction-visible")).toBe("true");

  act(() => caret(editor));
  fireEvent.keyDown(editor, { key: "Tab" });
  expect(editor.textContent).toBe(PREVIEW_NEXT_MESSAGES[0]);
  act(() => screen.getByRole("button", { name: "Other control" }).focus());
  expect(mounted.container.querySelector(".cm-prediction")).toBeNull();
});

it("restores an available suggestion immediately after the draft is cleared", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(
    <PreviewModeProvider switchEnabled>
      <ChipComposer placeholder="Enter a message" prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }} />
    </PreviewModeProvider>,
  );
  const editor = screen.getByRole("textbox");
  await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]));

  editor.textContent = "unrelated draft";
  caret(editor);
  fireEvent.input(editor);
  await act(() => new Promise(resolve => setTimeout(resolve, 220)));
  expect(mounted.container.querySelector(".cm-prediction")).toBeNull();

  editor.textContent = "";
  caret(editor);
  fireEvent.input(editor);
  expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]);
  expect(editor.getAttribute("data-prediction-visible")).toBe("true");
  fireEvent.keyDown(editor, { key: "Tab" });
  expect(editor.textContent).toBe(PREVIEW_NEXT_MESSAGES[0]);
});

it("does not reuse a suggestion from a different session", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  const client = { command: vi.fn() } as unknown as StudioClient;
  const view = (sessionId: string) => (
    <PreviewModeProvider switchEnabled>
      <ChipComposer prediction={{ client, sessionId, available: true, nextMessageAvailable: true }} />
    </PreviewModeProvider>
  );
  const mounted = render(view("first"));
  await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull());
  mounted.rerender(view("second"));
  expect(mounted.container.querySelector(".cm-prediction")).toBeNull();
  await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull());
});

it("shows a suggestion when a hidden composer becomes visible", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const resize: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize.push(callback); }
    observe() {}
    disconnect() {}
  });
  let width = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 200));
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(
    <PreviewModeProvider switchEnabled>
      <ChipComposer prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }} />
    </PreviewModeProvider>,
  );
  await act(() => new Promise(resolve => setTimeout(resolve, 220)));
  expect(mounted.container.querySelector(".cm-prediction")).toBeNull();

  width = 400;
  act(() => resize.forEach(callback => callback([{ contentRect: { width } }] as ResizeObserverEntry[], {} as ResizeObserver)));
  await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]));
});

it("keeps an available suggestion while its composer is hidden and restored", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const resize: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize.push(callback); }
    observe() {}
    disconnect() {}
  });
  let width = 400;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 200));
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(
    <PreviewModeProvider switchEnabled>
      <ChipComposer placeholder="Enter a message" prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }} />
    </PreviewModeProvider>,
  );
  const editor = screen.getByRole("textbox");
  await waitFor(() => expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]));

  width = 0;
  act(() => resize.forEach(callback => callback([{ contentRect: { width } }] as ResizeObserverEntry[], {} as ResizeObserver)));
  expect(editor.getAttribute("data-prediction-visible")).toBe("true");
  width = 400;
  act(() => resize.forEach(callback => callback([{ contentRect: { width } }] as ResizeObserverEntry[], {} as ResizeObserver)));
  expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain(PREVIEW_NEXT_MESSAGES[0]);
  expect(editor.getAttribute("data-prediction-visible")).toBe("true");
});

it("ignores late suggestions during composition and after dismissal", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const original = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(100, 40, 0, 20),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  let receive!: (event: { kind: "next"; channelId: string; revision: number; suffix: string | null; choices?: string[]; rank?: number }) => void;
  const input = vi.fn(async (_request: { input: { kind: string; revision?: number } }) => ({ ok: true }));
  const detach = vi.fn(async () => {});
  vi.stubGlobal("ompStudioChrome", {
    attachPrediction: vi.fn(async () => ({ ok: true })),
    detachPrediction: detach,
    predictionInput: input,
    onPrediction: (listener: typeof receive) => { receive = listener; return () => {}; },
  });
  const client = {
    command: vi.fn(async () => ({ requestId: "prepare" })),
    getState: () => ({ commands: { prepare: { status: "completed", result: { result: { channelId: "c", sessionId: "s" } } } } }),
  } as unknown as StudioClient;
  try {
    const mounted = render(
      <PreviewModeProvider switchEnabled>
        <ChipComposer prediction={{ client, sessionId: "s", available: true, nextMessageAvailable: true }} />
      </PreviewModeProvider>,
    );
    const editor = screen.getByRole("textbox");
    expect(document.activeElement).not.toBe(editor);
    await waitFor(() => expect(input.mock.calls.some(([request]) => request.input.kind === "next" && request.input.revision !== undefined)).toBe(true));
    const firstRevision = input.mock.calls.find(([request]) => request.input.kind === "next")![0].input.revision!;
    const suggestion = (revision: number) => ({ kind: "next" as const, channelId: "c", revision, suffix: "Suggested message", choices: ["Suggested message"], rank: 0 });

    act(() => receive(suggestion(firstRevision)));
    expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();

    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();
    expect(detach).not.toHaveBeenCalled();
    act(() => receive({ kind: "next", channelId: "c", revision: firstRevision, suffix: null }));
    expect(mounted.container.querySelector(".cm-prediction")).toBeNull();
    act(() => receive(suggestion(firstRevision)));
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();

    act(() => caret(editor));
    editor.textContent = "different draft";
    caret(editor);
    fireEvent.input(editor);
    await waitFor(() => expect(input.mock.calls.some(([request]) => request.input.kind === "update")).toBe(true));
    const updateRevision = input.mock.calls.filter(([request]) => request.input.kind === "update").at(-1)![0].input.revision!;
    act(() => receive({ kind: "next", channelId: "c", revision: updateRevision, suffix: null }));
    editor.textContent = "";
    caret(editor);
    fireEvent.input(editor);
    expect(mounted.container.querySelector(".cm-prediction")).toBeNull();
    await waitFor(() => expect(input.mock.calls.some(([request]) => request.input.kind === "next" && (request.input.revision ?? 0) > updateRevision)).toBe(true));
    const restoredRevision = input.mock.calls.filter(([request]) => request.input.kind === "next").at(-1)![0].input.revision!;
    act(() => receive(suggestion(restoredRevision)));
    expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();

    editor.textContent = "Sug";
    caret(editor);
    fireEvent.input(editor);
    await waitFor(() => expect(input.mock.calls.some(([request]) => request.input.kind === "update" && (request.input.revision ?? 0) > restoredRevision)).toBe(true));
    const prefixRevision = input.mock.calls.filter(([request]) => request.input.kind === "update").at(-1)![0].input.revision!;
    act(() => receive({ ...suggestion(prefixRevision), suffix: "gested message" }));
    editor.textContent = "";
    caret(editor);
    fireEvent.input(editor);
    expect(mounted.container.querySelector(".cm-prediction")?.textContent).toContain("Suggested message");
    const emptyRevision = input.mock.calls.filter(([request]) => request.input.kind === "next").at(-1)![0].input.revision!;
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.textContent).toBe("Suggested message");
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ input: { kind: "next.accepted", revision: emptyRevision, rank: 0 } }));

    editor.textContent = "";
    caret(editor);
    fireEvent.input(editor);
    const compositionRevision = input.mock.calls.filter(([request]) => request.input.kind === "next").at(-1)![0].input.revision!;
    fireEvent.compositionStart(editor);
    act(() => receive(suggestion(compositionRevision)));
    expect(mounted.container.querySelector(".cm-prediction")).toBeNull();

    const nextCount = input.mock.calls.filter(([request]) => request.input.kind === "next").length;
    fireEvent.compositionEnd(editor);
    expect(mounted.container.querySelector(".cm-prediction")).toBeNull();
    await waitFor(() => expect(input.mock.calls.filter(([request]) => request.input.kind === "next").length).toBeGreaterThan(nextCount));
    const latestRevision = input.mock.calls.filter(([request]) => request.input.kind === "next").at(-1)![0].input.revision!;
    act(() => receive(suggestion(latestRevision)));
    expect(mounted.container.querySelector(".cm-prediction")).not.toBeNull();
    fireEvent.keyDown(editor, { key: "Escape" });
    act(() => receive(suggestion(latestRevision)));
    expect(mounted.container.querySelector(".cm-prediction")).toBeNull();
  } finally {
    if (original) Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});
