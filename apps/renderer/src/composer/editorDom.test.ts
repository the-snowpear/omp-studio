import { afterEach, describe, expect, it } from "vitest";

import {
  createChipElement,
  findMentionToken,
  insertNodesAtCaret,
  mentionAtCaret,
  removeConflictingModeChips,
  replaceMention,
} from "./editorDom";

afterEach(() => {
  document.body.replaceChildren();
});

function mountEditor(): HTMLElement {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  document.body.append(editor);
  editor.focus();
  return editor;
}

function setCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("mentionAtCaret", () => {
  it("reads @query when the caret is inside the token", () => {
    const editor = mountEditor();
    const text = document.createTextNode("see @exp");
    editor.append(text);
    setCaret(text, text.data.length);

    expect(mentionAtCaret(editor)).toMatchObject({ query: "exp", start: 4, end: 8 });
  });

  it("reads a toolbar @ when the caret sits on the editor after the text node", () => {
    const editor = mountEditor();
    const text = document.createTextNode("@");
    editor.append(text);
    setCaret(editor, 1);

    expect(mentionAtCaret(editor)).toMatchObject({ query: "", start: 0, end: 1 });
  });

  it("reads @ when the caret is at the start of the following text node", () => {
    const editor = mountEditor();
    const at = document.createTextNode("@");
    const after = document.createTextNode("");
    editor.append(at, after);
    setCaret(after, 0);

    expect(mentionAtCaret(editor)).toMatchObject({ query: "", start: 0, end: 1, textNode: at });
  });
});

describe("insertNodesAtCaret", () => {
  it("leaves the caret inside an inserted @ so it is still a mention", () => {
    const editor = mountEditor();
    insertNodesAtCaret(editor, [document.createTextNode("@")]);

    expect(mentionAtCaret(editor)?.query).toBe("");
    expect(editor.textContent).toBe("@");
  });
});

describe("findMentionToken", () => {
  it("finds the last @query even when the selection is gone", () => {
    const editor = mountEditor();
    editor.append(document.createTextNode("ask @exp"));
    window.getSelection()?.removeAllRanges();

    expect(findMentionToken(editor, "exp")).toMatchObject({ query: "exp", start: 4, end: 8 });
  });
});

describe("replaceMention", () => {
  it("consumes the @ token into the capsule", () => {
    const editor = mountEditor();
    const text = document.createTextNode("@");
    editor.append(text);
    setCaret(editor, 1);
    const mention = mentionAtCaret(editor);
    expect(mention).not.toBeNull();
    replaceMention(mention!, createChipElement({
      id: "chip-1",
      kind: "agent",
      label: "explore",
      name: "explore",
    }));

    expect(editor.querySelector(".cm-chip-agent .cm-chip-clip")?.textContent).toBe("explore");
    const leftoverAt = [...editor.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").includes("@"),
    );
    expect(leftoverAt).toBe(false);
  });
});

describe("removeConflictingModeChips", () => {
  it("removes plan when a vibe capsule would collide", () => {
    const editor = mountEditor();
    editor.append(
      createChipElement({ id: "plan", kind: "mode", label: "plan", name: "plan" }),
      document.createTextNode(" keep"),
    );
    expect(removeConflictingModeChips(editor, "vibe")).toBe(true);
    const names = [...editor.querySelectorAll<HTMLElement>(".cm-chip")].map((chip) => {
      const payload = JSON.parse(chip.dataset.chip ?? "{}") as { name?: string };
      return payload.name;
    });
    expect(names).not.toContain("plan");
    expect(editor.textContent).toContain("keep");
  });
});
