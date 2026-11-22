import type { ComposerChip } from "./types";

/**
 * Main conversation Composers that accept dragged capsules. Each conversation
 * document mounts its own Composer, so drags (sidebar rows, conversation
 * windows, Explorer files, capsules) find the input under the pointer here
 * instead of through one window-wide ref.
 */

export type DropPoint = { readonly x: number; readonly y: number };
export type DroppedChip = Omit<ComposerChip, "id"> & { id?: string };

export type ComposerFileScope = { targetId: string | null; workspaceId: string | undefined };
export type CapsuleOrigin = { readonly element: HTMLElement; readonly chipId: string; readonly target: ComposerDropTarget };

export function acceptsFileScope(target: ComposerDropTarget, source: ComposerFileScope | undefined): boolean {
  return source === undefined || (target.fileScope?.targetId === source.targetId && target.fileScope.workspaceId === source.workspaceId);
}

export type ComposerDropTarget = {
  readonly fileScope?: ComposerFileScope | undefined;
  /** Owning conversation document; a window never drops into its own input. */
  readonly documentId: string | undefined;
  /** Conversation session, so a row or capsule never references its own conversation. */
  readonly sessionId: string | undefined;
  /** Hit area: the whole Composer card, larger than the text box. */
  readonly element: HTMLElement;
  readonly editor: HTMLElement;
  accepts(): boolean;
  showCaret(point: DropPoint): void;
  hideCaret(): void;
  /** Inserts the capsule where `point` lands and returns its element for the landing flight. */
  insertAt(chip: DroppedChip, point: DropPoint): HTMLElement | null;
  /** Moves an existing capsule of this editor to `point`. */
  moveTo(chip: HTMLElement, point: DropPoint): HTMLElement | null;
  remove(chipId: string): void;
  /** The full capsule behind one of this editor's elements, image bytes included. */
  chipOf(chip: HTMLElement): ComposerChip | null;
};

const targets = new WeakMap<Element, ComposerDropTarget>();

export function registerComposerDrop(target: ComposerDropTarget): () => void {
  targets.set(target.element, target);
  target.element.dataset.composerDrop = "";
  return () => {
    if (targets.get(target.element) !== target) return;
    targets.delete(target.element);
    target.hideCaret();
    delete target.element.dataset.composerDrop;
  };
}

/** The accepting Composer directly under the pointer, ignoring drag ghosts. */
export function composerDropAt(surface: Document, point: DropPoint, exclude: { documentId?: string | undefined; sessionId?: string | undefined } = {}): ComposerDropTarget | null {
  if (typeof surface.elementsFromPoint !== "function") return null;
  for (const element of surface.elementsFromPoint(point.x, point.y)) {
    if (element.closest(".dock-drag-preview, .capsule-ghost, .dock-drag-source")) continue;
    const host = element.closest("[data-composer-drop]");
    const target = host ? targets.get(host) : undefined;
    if (!target || !target.accepts()) return null;
    if (exclude.documentId !== undefined && target.documentId === exclude.documentId) return null;
    if (exclude.sessionId !== undefined && target.sessionId === exclude.sessionId) return null;
    return target;
  }
  return null;
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

/**
 * Collapsed range where a capsule dropped at `point` lands. A point inside a
 * capsule snaps to whichever side of it is nearer; a point outside the text
 * box (toolbar, image strip) clamps onto its first or last line.
 */
export function dropRangeAt(editor: HTMLElement, point: DropPoint): Range {
  const document = editor.ownerDocument;
  const box = editor.getBoundingClientRect();
  const x = clamp(point.x, box.left + 1, Math.max(box.left + 1, box.right - 1));
  const y = clamp(point.y, box.top + 1, Math.max(box.top + 1, box.bottom - 1));
  const end = () => { const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); return range; };
  let range: Range | null = null;
  const probe = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (typeof document.caretRangeFromPoint === "function") range = document.caretRangeFromPoint(x, y);
  else if (typeof probe.caretPositionFromPoint === "function") {
    const position = probe.caretPositionFromPoint(x, y);
    if (position) { range = document.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); }
  }
  if (!range || !editor.contains(range.startContainer)) return point.y < box.top ? start(editor) : end();
  const container = range.startContainer;
  const element = container.nodeType === Node.ELEMENT_NODE ? container as Element : container.parentElement;
  const chip = element?.closest<HTMLElement>(".cm-chip");
  if (chip && editor.contains(chip)) {
    const rect = chip.getBoundingClientRect(), snapped = document.createRange();
    if (x < rect.left + rect.width / 2) snapped.setStartBefore(chip); else snapped.setStartAfter(chip);
    snapped.collapse(true);
    return snapped;
  }
  return range;
}

function start(editor: HTMLElement) {
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  range.collapse(true);
  return range;
}

/** Viewport box of a collapsed range, falling back to its neighbours or the empty line. */
export function caretBox(range: Range, editor: HTMLElement): { x: number; y: number; height: number } {
  const rect = typeof range.getClientRects === "function" ? [...range.getClientRects()].find(item => item.height > 0) : undefined;
  if (rect) return { x: rect.left, y: rect.top, height: rect.height };
  const container = range.startContainer;
  if (container.nodeType === Node.ELEMENT_NODE) {
    const before = container.childNodes[range.startOffset - 1], after = container.childNodes[range.startOffset];
    const edge = (node: ChildNode | undefined, side: "left" | "right") => {
      if (!node) return null;
      const probe = editor.ownerDocument.createRange();
      const box = node.nodeType === Node.ELEMENT_NODE ? (node as Element).getBoundingClientRect() : typeof probe.getBoundingClientRect === "function" ? (probe.selectNode(node), probe.getBoundingClientRect()) : null;
      return box && box.height > 0 ? { x: side === "left" ? box.left : box.right, y: box.top, height: box.height } : null;
    };
    const found = edge(before, "right") ?? edge(after, "left");
    if (found) return found;
  }
  const box = editor.getBoundingClientRect(), style = getComputedStyle(editor);
  const line = Number.parseFloat(style.lineHeight) || 20;
  return { x: box.left + (Number.parseFloat(style.paddingLeft) || 0), y: box.top + (Number.parseFloat(style.paddingTop) || 0), height: line };
}

/** Puts `nodes` at `range` with one space between them and the surrounding words. */
export function insertNodesAtRange(editor: HTMLElement, range: Range, nodes: Node[]): void {
  const document = editor.ownerDocument;
  const marker = document.createComment("drop");
  range.insertNode(marker);
  const previous = marker.previousSibling, next = marker.nextSibling;
  const fragment = document.createDocumentFragment();
  if (previous?.nodeType === Node.TEXT_NODE && /\S$/u.test((previous as Text).data)) fragment.append(document.createTextNode(" "));
  else if (previous?.nodeType === Node.ELEMENT_NODE && (previous as Element).classList.contains("cm-chip")) fragment.append(document.createTextNode(" "));
  for (const node of nodes) fragment.append(node);
  if (!(next?.nodeType === Node.TEXT_NODE && /^\s/u.test((next as Text).data))) fragment.append(document.createTextNode(" "));
  marker.replaceWith(fragment);
}
