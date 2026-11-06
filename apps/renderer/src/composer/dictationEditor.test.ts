import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChipElement, insertPlainText, readDoc } from "./editorDom";
import { DictationEditor } from "./dictationEditor";

function select(node: Node, start: number, end = start): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function text(editor: HTMLElement): string {
  return readDoc(editor, new Map()).nodes.map((node) => node.type === "text" ? node.value : `[${node.chip.label}]`).join("");
}

// jsdom does not implement native editing or native undo. This stub exercises
// the local insertion range; real browser undo must be separately verified.
function nativeInsertion(editor: HTMLElement): void {
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => {
    insertPlainText(editor, value);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return true;
  }) });
}

let editor: HTMLDivElement;
let transaction: DictationEditor;
beforeEach(() => {
  editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  document.body.append(editor);
  editor.focus();
  transaction = new DictationEditor(editor);
  nativeInsertion(editor);
});
afterEach(() => {
  transaction.invalidate();
  editor.remove();
  Reflect.deleteProperty(document, "execCommand");
  vi.unstubAllGlobals();
});

describe("dictation editor transaction", () => {
  it("shows partial and committed recognition locally, outside normal readDoc", () => {
    editor.textContent = "before after";
    select(editor.firstChild!, 7);
    expect(transaction.begin("a")).toBe(true);
    transaction.update("a", "你好", " API");
    expect(editor.querySelector("[data-composer-dictation]")?.textContent).toBe("你好 API");
    expect(text(editor)).toBe("before after");
    expect(editor.querySelector("[data-composer-dictation]")?.getAttribute("contenteditable")).toBe("false");
    expect(transaction.commit("a", "你好 API ")).toEqual({ applied: true, unchanged: true });
    expect(text(editor)).toBe("before 你好 API after");
    expect(document.execCommand).toHaveBeenCalledTimes(1);
    expect(transaction.commit("a", "duplicate").applied).toBe(false);
    expect(text(editor)).toBe("before 你好 API after");
  });

  it("replaces only the captured selection, preserving surrounding capsules", () => {
    const chip = createChipElement({ id: "file", kind: "file", label: "App.tsx", path: "App.tsx" });
    editor.append(chip, document.createTextNode("keep replace tail"));
    select(editor.lastChild!, 5, 12);
    expect(transaction.begin("a")).toBe(true);
    transaction.update("a", "", "replacement");
    expect(text(editor)).toBe("[App.tsx]keep replace tail");
    expect(transaction.commit("a", "语音")).toEqual({ applied: true, unchanged: true });
    expect(text(editor)).toBe("[App.tsx]keep 语音 tail");
    expect(editor.querySelector(".cm-chip")).toBe(chip);
  });

  it("keeps simultaneous typing and marks the automatic-send gate changed", () => {
    editor.textContent = "left right";
    select(editor.firstChild!, 5);
    transaction.begin("a");
    insertPlainText(editor, "typed ");
    transaction.noteEdit();
    transaction.update("a", "speech ", "");
    expect(text(editor)).toBe("left typed right");
    expect(transaction.commit("a", "speech ")).toEqual({ applied: true, unchanged: false });
    expect(text(editor)).toBe("left speech typed right");
  });

  it("cancels recognition without deleting a selected draft or simultaneous typing", () => {
    editor.textContent = "left selected right";
    select(editor.firstChild!, 5, 13);
    transaction.begin("a");
    transaction.update("a", "discard", "partial");
    insertPlainText(editor, "typed");
    transaction.noteEdit();
    transaction.cancel("other");
    expect(editor.querySelector("[data-composer-dictation]")).not.toBeNull();
    transaction.cancel("a");
    expect(text(editor)).toBe("left selectedtyped right");
    expect(editor.querySelector("[data-composer-dictation]")).toBeNull();
    expect(transaction.commit("a", "late").applied).toBe(false);
  });

  it("does not replace a human edit made inside the original selection", () => {
    editor.textContent = "left selected right";
    select(editor.firstChild!, 5, 13);
    transaction.begin("a");
    const selected = [...editor.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent === "selected")!;
    select(selected, 3);
    transaction.beforeEdit();
    insertPlainText(editor, "typed");
    transaction.noteEdit();
    expect(transaction.commit("a", "voice")).toEqual({ applied: false, unchanged: false });
    expect(text(editor)).toBe("left seltypedected right");
  });

  it("does not guess an insertion point after the transaction anchor is removed", () => {
    editor.textContent = "old";
    select(editor.firstChild!, 1);
    transaction.begin("a");
    editor.replaceChildren(document.createTextNode("new target"));
    expect(transaction.commit("a", "lost")).toEqual({ applied: false, unchanged: false });
    expect(text(editor)).toBe("new target");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("uses the last editor selection after toolbar focus moves elsewhere", () => {
    editor.textContent = "before after";
    select(editor.firstChild!, 7);
    transaction.rememberSelection();
    const toolbar = document.createElement("button");
    document.body.append(toolbar);
    toolbar.focus();
    window.getSelection()!.removeAllRanges();
    expect(transaction.begin("a")).toBe(true);
    expect(transaction.commit("a", "speech ").applied).toBe(true);
    expect(text(editor)).toBe("before speech after");
    expect(document.activeElement).toBe(toolbar);
    toolbar.remove();
  });

  it("keeps failure available for recovery instead of bypassing native undo", () => {
    editor.textContent = "original";
    select(editor.firstChild!, 3);
    transaction.begin("a");
    vi.mocked(document.execCommand).mockReturnValue(false);
    expect(transaction.commit("a", "voice")).toEqual({ applied: false, unchanged: false });
    expect(text(editor)).toBe("original");
  });
});
