import { fireEvent } from "@testing-library/react";

/** Type plain text into the real Ask contenteditable, preserving its input event path. */
export function setAskText(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  fireEvent.input(editor, { inputType: "insertText", data: text });
}

export function setAskCaret(node: Node, offset: number): void {
  const document = node.ownerDocument!;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}
