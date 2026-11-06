import type { ComposerDictationCommit } from "./dictationTypes";

/** Native insertText preserves the browser's undo history; never rewrite the doc. */
export function insertDictationText(editor: HTMLElement, text: string): boolean {
  if (!text) return true;
  const doc = editor.ownerDocument;
  return typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text);
}

function marker(doc: Document, hidden = false): HTMLSpanElement {
  const span = doc.createElement("span");
  span.dataset.composerDictation = "true";
  span.setAttribute("contenteditable", "false");
  span.setAttribute("aria-hidden", "true");
  span.style.pointerEvents = "none";
  span.style.userSelect = "none";
  if (hidden) span.style.display = "none";
  else {
    span.className = "cm-dictation-text";
    span.style.opacity = "0.65";
    span.style.whiteSpace = "pre-wrap";
  }
  return span;
}

function select(range: Range): void {
  const selection = range.startContainer.ownerDocument?.defaultView?.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

type Transaction = {
  id: string;
  start: HTMLSpanElement;
  end: HTMLSpanElement | null;
  reserved: Range | null;
  edited: boolean;
};

/** Transient, local DOM transaction. No recognition text enters the persistent doc. */
export class DictationEditor {
  private transaction: Transaction | null = null;
  private savedSelection: Range | null = null;

  constructor(private readonly editor: HTMLElement) {}

  rememberSelection(): void {
    const selection = this.editor.ownerDocument.defaultView?.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (this.editor.contains(range.startContainer) && this.editor.contains(range.endContainer)) {
      this.savedSelection = range.cloneRange();
    }
  }

  begin(id: string): boolean {
    if (this.transaction !== null) return false;
    this.rememberSelection();
    const range = this.savedSelection?.cloneRange();
    if (!range || !this.editor.contains(range.startContainer) || !this.editor.contains(range.endContainer)) return false;
    const atomic = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".cm-chip, [data-composer-dictation]");
    if (atomic(range.startContainer) || atomic(range.endContainer)) return false;
    const start = marker(this.editor.ownerDocument);
    const end = range.collapsed ? null : marker(this.editor.ownerDocument, true);
    if (end !== null) {
      const tail = range.cloneRange();
      tail.collapse(false);
      tail.insertNode(end);
    }
    range.collapse(true);
    range.insertNode(start);
    const reserved = end === null ? null : this.editor.ownerDocument.createRange();
    if (reserved && end) {
      reserved.setStartAfter(start);
      reserved.setEndBefore(end);
    }
    this.transaction = { id, start, end, reserved, edited: false };
    // Concurrent typing sits outside the reserved selection, not in transcript.
    const caret = this.editor.ownerDocument.createRange();
    caret.setStartAfter(end ?? start);
    caret.collapse(true);
    select(caret);
    return true;
  }

  update(id: string, committedText: string, partialText: string): void {
    const transaction = this.transaction;
    if (transaction?.id !== id || !this.valid(transaction)) return;
    transaction.start.textContent = committedText + partialText;
  }

  /** An edit of the reserved selection conflicts; keep recovery text instead of
   * replacing human typing at that location. Edits outside still track the anchor. */
  beforeEdit(): void {
    const transaction = this.transaction;
    if (!transaction?.reserved) return;
    const selection = this.editor.ownerDocument.defaultView?.getSelection();
    if (!selection?.rangeCount) return;
    const edit = selection.getRangeAt(0);
    const reserved = transaction.reserved;
    if (edit.compareBoundaryPoints(Range.END_TO_START, reserved) < 0
      && edit.compareBoundaryPoints(Range.START_TO_END, reserved) > 0) {
      this.invalidate();
    }
  }

  noteEdit(): void {
    if (this.transaction) this.transaction.edited = true;
    this.rememberSelection();
  }

  commit(id: string, text: string): ComposerDictationCommit {
    const transaction = this.transaction;
    if (transaction?.id !== id) return { applied: false, unchanged: false };
    const unchanged = !transaction.edited;
    this.transaction = null; // Before synchronous native input callbacks.
    if (!this.valid(transaction)) {
      transaction.start.remove();
      transaction.end?.remove();
      return { applied: false, unchanged: false };
    }
    const range = this.editor.ownerDocument.createRange();
    range.setStartAfter(transaction.start);
    if (transaction.end !== null) range.setEndBefore(transaction.end);
    else range.collapse(true);
    transaction.start.remove();
    transaction.end?.remove();
    if (!text) return { applied: true, unchanged };
    const hadFocus = this.editor.ownerDocument.activeElement === this.editor;
    const previousFocus = this.editor.ownerDocument.activeElement;
    const selection = this.editor.ownerDocument.defaultView?.getSelection();
    const previous = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    if (!hadFocus) this.editor.focus({ preventScroll: true });
    select(range);
    const applied = insertDictationText(this.editor, text);
    if (!hadFocus) {
      this.editor.blur();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      if (previous?.startContainer.isConnected && previous.endContainer.isConnected) select(previous);
    }
    this.rememberSelection();
    return { applied, unchanged: applied && unchanged };
  }

  cancel(id: string): void {
    if (this.transaction?.id !== id) return;
    this.transaction.start.remove();
    this.transaction.end?.remove();
    this.transaction = null;
    this.rememberSelection();
  }

  invalidate(): void {
    this.transaction?.start.remove();
    this.transaction?.end?.remove();
    this.transaction = null;
    this.savedSelection = null;
  }

  private valid(transaction: Transaction): boolean {
    if (!this.editor.contains(transaction.start)) return false;
    return transaction.end === null || (this.editor.contains(transaction.end)
      && !!(transaction.start.compareDocumentPosition(transaction.end) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
}
