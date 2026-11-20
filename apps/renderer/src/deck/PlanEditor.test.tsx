import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { isolateHistory, undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { ComponentProps } from "react";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { PlanCard, PlanReviewDeck } from "./PlanCard";
import { QueuedDeck } from "./QueuedDeck";

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects); else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (originalBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds); else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

const BODY = "## Goal\n\nOriginal plan.\n\n## Steps\n\nKeep these steps.\n";
function surface(props: Partial<ComponentProps<typeof PlanCard>> = {}, language: "zh" | "en" = "zh", preview = false) {
  return <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled={false}><PreviewSurface preview={preview}>
    <PlanCard title="Review" body={BODY} onAction={() => true} onSaveMarkdown={async () => true} {...props} />
  </PreviewSurface></PreviewModeProvider></I18nProvider>;
}
function openEditor() { fireEvent.click(screen.getByRole("button", { name: "编辑计划" })); }
const dialog = () => screen.getByRole("dialog");
const source = () => EditorView.findFromDOM(screen.getByRole("textbox", { name: /计划 Markdown|Plan Markdown/ }))!;
const rendered = () => dialog().querySelector<HTMLElement>(".plan-preview-scroll")!;
function replace(text: string) {
  act(() => source().dispatch({ changes: { from: 0, to: source().state.doc.length, insert: text }, annotations: isolateHistory.of("full") }));
}

describe("plan split editing", () => {
  it.each([false, true])("resizes compact plans, retains height across expand/locale changes and restores automatic height (preview=%s)", preview => {
    const plan = { kind: "plan" as const, id: "resize-plan", title: "Review", body: BODY };
    const surface = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}>
      <PreviewModeProvider switchEnabled={false}><PreviewSurface preview={preview}>
        <div className="convo-wrap">{preview
          ? <QueuedDeck items={[plan]} regionLabel="Queued" />
          : <PlanReviewDeck title={plan.title} body={plan.body} onAction={() => true} />}</div>
      </PreviewSurface></PreviewModeProvider>
    </I18nProvider>;
    const ui = render(surface("zh"));
    const deck = ui.container.querySelector<HTMLElement>(".deck")!;
    const area = ui.container.querySelector<HTMLElement>(".convo-wrap")!;
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 800, 650));
    vi.spyOn(deck, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 400, 800, 300));
    vi.spyOn(deck, "offsetHeight", "get").mockImplementation(() => Number.parseFloat(deck.style.getPropertyValue("--question-height")) || 300);
    const handle = screen.getByRole("separator", { name: "调整计划卡高度" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(deck.style.getPropertyValue("--question-height")).toBe("324px");
    expect(deck.classList.contains("is-question-sized")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    expect(screen.queryByRole("separator", { name: "调整计划卡高度" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "收起计划" }));
    expect(deck.style.getPropertyValue("--question-height")).toBe("324px");
    ui.rerender(surface("en"));
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize plan card" }), { key: "ArrowDown" });
    expect(deck.style.getPropertyValue("--question-height")).toBe("300px");
    ui.rerender(surface("zh"));
    fireEvent.doubleClick(screen.getByRole("separator", { name: "调整计划卡高度" }));
    expect(deck.style.getPropertyValue("--question-height")).toBe("");
    expect(deck.classList.contains("is-question-sized")).toBe(false);
  });

  it("previews the unsaved draft and preserves history, notes, layout and caret across view, collapse and language switches", async () => {
    const save = vi.fn(async () => true);
    const props = { onSaveMarkdown: save };
    const ui = render(surface(props));
    openEditor();
    expect(dialog().querySelectorAll(".cm-editor")).toHaveLength(1);
    replace("## Goal\n\n实时草稿 with **formatting**.\n");
    expect(rendered().querySelector("strong")?.textContent).toBe("formatting");
    expect(save).not.toHaveBeenCalled();
    act(() => source().dispatch({ selection: { anchor: 12 } }));
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("45");
    fireEvent.click(within(dialog()).getByRole("button", { name: "阅读" }));
    expect(screen.queryByRole("textbox", { name: "计划 Markdown" })).toBeNull();
    expect(rendered().textContent).toContain("实时草稿");
    fireEvent.click(within(dialog()).getByRole("button", { name: "编辑" }));
    expect(source().state.selection.main.head).toBe(12);
    fireEvent.click(within(dialog()).getByRole("button", { name: "收起计划" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    openEditor();
    expect(source().state.doc.toString()).toContain("实时草稿");
    expect(source().state.selection.main.head).toBe(12);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("45");
    ui.rerender(surface(props, "en"));
    expect(screen.getByRole("textbox", { name: "Plan Markdown" })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Save plan" })).toBeTruthy();
    expect(source().state.doc.toString()).toContain("实时草稿");
    ui.rerender(surface(props));
    act(() => { undo(source()); });
    expect(source().state.doc.toString()).toBe(BODY);
    act(() => { redo(source()); });
    expect(source().state.doc.toString()).toContain("实时草稿");
    fireEvent.click(within(dialog()).getByRole("button", { name: "保存计划" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(dialog()).getByRole("status").textContent).toBe("已保存"));
    expect(source().state.doc.toString()).toContain("实时草稿");
  });

  it.each(["批准并执行", "批准并保留上下文", "批准并压缩上下文", "请求修改"])("saves before %s and keeps the page open on a failed decision", async label => {
    let finish!: (ok: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const action = vi.fn(async () => false);
    render(surface({ onSaveMarkdown: save, onAction: action }));
    openEditor(); replace("## Updated\n\nSave before submitting.");
    fireEvent.click(within(dialog()).getByRole("button", { name: label }));
    expect(save).toHaveBeenCalledExactlyOnceWith("## Updated\n\nSave before submitting.");
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "计划 Markdown" }).getAttribute("aria-readonly")).toBe("true");
    await act(async () => finish(true));
    expect(action).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();
    expect(within(dialog()).getByRole("alert").textContent).toContain("提交失败");
  });

  it("keeps edits on save failure, retries from the compact card, and does not exit on a cancelled save-as", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(true);
    const action = vi.fn(async () => false);
    const quit = vi.fn(async () => ({ ok: false, cancelled: true }));
    render(surface({ onSaveMarkdown: save, onAction: action, onSaveAndQuit: quit }));
    openEditor(); replace("## Draft\n\nKeep me.");
    fireEvent.click(within(dialog()).getByRole("button", { name: "批准并执行" }));
    await screen.findByText("Disk unavailable");
    expect(action).not.toHaveBeenCalled();
    expect(source().state.doc.toString()).toContain("Keep me.");
    fireEvent.click(within(dialog()).getByRole("button", { name: "收起计划" }));
    fireEvent.click(screen.getByRole("button", { name: "批准并执行" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(2);
    openEditor();
    fireEvent.click(within(dialog()).getByRole("button", { name: "保存并退出" }));
    await waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeTruthy();
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("keeps a note on its section after insert/rename/delete/undo and submits a pending annotation draft", async () => {
    const action = vi.fn(async () => false);
    render(surface({ onAction: action })); openEditor();
    const button = within(dialog()).getByRole("button", { name: "批注 Steps" });
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    fireEvent.change(screen.getByRole("textbox", { name: "批注内容 Steps" }), { target: { value: "Keep this section's comment" } });
    fireEvent.click(screen.getByRole("button", { name: "保存批注" }));
    const prefix = "## New\n\nInserted before the existing plan.\n\n";
    act(() => source().dispatch({ changes: { from: 0, insert: prefix }, annotations: isolateHistory.of("full") }));
    const heading = source().state.doc.toString().indexOf("Steps");
    act(() => source().dispatch({ changes: { from: heading, to: heading + 5, insert: "Implementation" }, annotations: isolateHistory.of("full") }));
    expect(screen.getByText("Keep this section's comment").closest("section")?.textContent).toContain("Implementation");
    const from = source().state.doc.toString().indexOf("## Implementation");
    act(() => source().dispatch({ changes: { from, to: source().state.doc.length }, annotations: isolateHistory.of("full") }));
    expect(screen.getByText("原章节已删除")).toBeTruthy();
    act(() => { undo(source()); });
    expect(screen.queryByText("原章节已删除")).toBeNull();
    expect(screen.getByText("Keep this section's comment").closest("section")?.textContent).toContain("Implementation");
    fireEvent.click(within(dialog()).getByRole("button", { name: "批注 Implementation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "批注内容 Implementation" }), { target: { value: "Include pending comment" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "请求修改" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(action.mock.calls[0]).toEqual(["refine", { feedback: expect.stringContaining("## Implementation\n- Keep this section's comment\n- Include pending comment") }]);
  });

  it("maps duplicate prose, nested lists, table rows and fences to their original CRLF offsets in both directions", () => {
    const text = "## Map\r\n\r\nSame text.\r\n\r\nSame text.\r\n\r\n- Parent\r\n  - Child\r\n\r\n| Key | Value |\r\n| --- | --- |\r\n| x | y |\r\n\r\n```ts\r\nconst n = 1;\r\n```\r\n";
    render(surface({ body: text })); openEditor();
    const repeated = within(rendered()).getAllByText("Same text.");
    fireEvent.pointerMove(repeated[1]!);
    expect(repeated[1]!.classList.contains("plan-render-linked")).toBe(true);
    expect(source().dom.querySelector(".plan-source-linked")?.textContent).toContain("Same text.");
    const second = text.lastIndexOf("Same text.");
    expect(Number(repeated[1]!.dataset.sourceStart)).toBe(second);
    act(() => source().dispatch({ selection: { anchor: text.indexOf("Same text.") } }));
    expect(repeated[0]!.classList.contains("plan-render-linked")).toBe(true);
    expect(repeated[1]!.classList.contains("plan-render-linked")).toBe(false);
    for (const element of rendered().querySelectorAll<HTMLElement>("tr[data-source-start], li[data-source-start], div[data-source-start]")) {
      const raw = text.slice(Number(element.dataset.sourceStart), Number(element.dataset.sourceEnd));
      expect(raw).toMatch(/Parent|Child|Key|x \| y|```ts/);
    }
    const code = rendered().querySelector<HTMLElement>(".md-code")!.parentElement!;
    fireEvent.pointerMove(code);
    expect(source().dom.querySelectorAll(".plan-source-linked")).toHaveLength(3);
  });

  it("defaults overall annotations to collapsed, retains text and includes folded notes in feedback", async () => {
    const action = vi.fn(async () => false);
    const props = { onAction: action };
    const ui = render(surface(props)); openEditor();
    expect(screen.queryByRole("textbox", { name: "全文批注" })).toBeNull();
    const toggle = within(dialog()).getByRole("button", { name: "全文批注" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole("textbox", { name: "全文批注" }), { target: { value: "Keep my overall note" } });
    fireEvent.click(toggle);
    expect(screen.queryByRole("textbox", { name: "全文批注" })).toBeNull();
    expect(toggle.textContent).toContain("有批注");
    ui.rerender(surface(props, "en"));
    expect(within(dialog()).getByRole("button", { name: "Overall annotations Has notes" }).getAttribute("aria-expanded")).toBe("false");
    ui.rerender(surface(props));
    fireEvent.click(within(dialog()).getByRole("button", { name: "收起计划" }));
    openEditor();
    fireEvent.click(within(dialog()).getByRole("button", { name: "全文批注 有批注" }));
    expect((screen.getByRole("textbox", { name: "全文批注" }) as HTMLTextAreaElement).value).toBe("Keep my overall note");
    fireEvent.click(within(dialog()).getByRole("button", { name: "全文批注 有批注" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "请求修改" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("refine", { feedback: expect.stringContaining("## Entire plan\n- Keep my overall note") }));
  });

  it("returns the linked highlight to the caret after leaving either surface and follows keyboard edits", () => {
    render(surface()); openEditor();
    const original = within(rendered()).getByText("Original plan.");
    const steps = within(rendered()).getByText("Keep these steps.");
    act(() => source().dispatch({ selection: { anchor: BODY.indexOf("Original") } }));
    expect(original.classList.contains("plan-render-linked")).toBe(true);
    fireEvent.pointerMove(steps);
    expect(steps.classList.contains("plan-render-linked")).toBe(true);
    const caret = source().state.selection.main.head;
    fireEvent.pointerLeave(rendered(), { relatedTarget: dialog().querySelector(".plan-editor-toolbar") });
    expect(original.classList.contains("plan-render-linked")).toBe(true);
    expect(steps.classList.contains("plan-render-linked")).toBe(false);
    expect(source().state.selection.main.head).toBe(caret);
    act(() => source().dispatch({ selection: { anchor: BODY.indexOf("Original") + "Original plan.".length } }));
    expect(original.classList.contains("plan-render-linked")).toBe(true);
    fireEvent.pointerMove(steps);
    fireEvent.mouseLeave(source().contentDOM, { relatedTarget: dialog().querySelector(".plan-editor-toolbar") });
    expect(original.classList.contains("plan-render-linked")).toBe(true);
    act(() => source().dispatch({ selection: { anchor: BODY.indexOf("Keep these") } }));
    expect(steps.classList.contains("plan-render-linked")).toBe(true);
    act(() => source().dispatch(source().state.replaceSelection("Updated ")));
    expect(within(rendered()).getByText("Updated Keep these steps.").classList.contains("plan-render-linked")).toBe(true);
  });

  it("updates an open search panel with the language and keeps the search query and document", () => {
    const ui = render(surface()); openEditor();
    act(() => { openSearchPanel(source()); });
    const field = screen.getByRole("textbox", { name: "查找" });
    fireEvent.input(field, { target: { value: "Original" } });
    ui.rerender(surface({}, "en"));
    expect((screen.getByRole("textbox", { name: "Find" }) as HTMLInputElement).value).toBe("Original");
    expect(source().state.doc.toString()).toBe(BODY);
    ui.rerender(surface());
    expect((screen.getByRole("textbox", { name: "查找" }) as HTMLInputElement).value).toBe("Original");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "查找" }), { key: "Escape", code: "Escape", keyCode: 27 });
    expect(screen.queryByRole("textbox", { name: "查找" })).toBeNull();
    expect(dialog()).toBeTruthy();
  });

  it("uses the same editor for unmarked demo plans and preserves local edits when fixture language changes", async () => {
    const props = { onSaveMarkdown: undefined };
    const ui = render(surface(props, "zh", true)); openEditor();
    replace("## Local demo\n\nEdited draft");
    ui.rerender(surface({ ...props, body: "## English fixture\n\nChanged locale" }, "en", true));
    expect(source().state.doc.toString()).toContain("Edited draft");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(within(dialog()).getByRole("status").textContent).toBe("Saved"));
    expect(dialog().textContent).not.toContain("Demo");
  });
});
