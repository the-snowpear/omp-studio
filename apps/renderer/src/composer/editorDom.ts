import { iconSvg } from "../icons";
import { chipPayload, chipIconName, parseChipPayload } from "./ingest";
import { normalizeDoc } from "./serialize";
import { splitChipLabel, type ComposerChip, type ComposerDoc, type ComposerNode, type PromptImage } from "./types";
import { modeChipConflictsWith } from "./commands";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function removeChipLabel(label: string): string {
  return `移除胶囊 ${label}`;
}

/**
 * `tabindex="-1"` on purpose: the capsule lives inside a textbox, where Tab
 * belongs to the surrounding form and Backspace is the keyboard way to delete.
 */
function removeButtonHtml(label: string): string {
  return `<button type="button" class="cm-chip-x" tabindex="-1" aria-label="${escapeHtml(removeChipLabel(label))}">${iconSvg("x", "sm")}</button>`;
}

function chipNameHtml(label: string): string {
  const { stem, ext } = splitChipLabel(label);
  const stemHtml = `<span class="cm-chip-stem">${escapeHtml(stem)}</span>`;
  const extHtml = ext === "" ? "" : `<span class="cm-chip-ext">${escapeHtml(ext)}</span>`;
  return `${stemHtml}${extHtml}`;
}

function chipLabelHtml(label: string): string {
  const inner = chipNameHtml(label);
  return `<span class="cm-chip-sizer" aria-hidden="true">${inner}</span><span class="cm-chip-clip"><span class="cm-chip-scroll">${inner}</span></span>`;
}

function writeChipLabel(chip: HTMLElement, label: string): void {
  const host = chip.querySelector(".cm-chip-label");
  if (host) host.innerHTML = chipLabelHtml(label);
}

/** Hover fade reserved for the × — keep in sync with `.cm-chip-clip` mask. */
export const CHIP_SCROLL_FADE_PX = 14;
/** Constant marquee speed. Duration is distance / this, so a long name still finishes. */
export const CHIP_SCROLL_PX_PER_SEC = 80;

export function chipScrollMotion(fullWidth: number, clipWidth: number): {
  readonly distance: number;
  readonly durationSec: number;
} {
  const overflow = fullWidth - clipWidth;
  if (overflow <= 0) return { distance: 0, durationSec: 0 };
  const distance = overflow + CHIP_SCROLL_FADE_PX;
  return { distance, durationSec: distance / CHIP_SCROLL_PX_PER_SEC };
}

function armChipScroll(chip: HTMLElement): void {
  const clip = chip.querySelector<HTMLElement>(".cm-chip-clip");
  const stem = chip.querySelector<HTMLElement>(".cm-chip-clip .cm-chip-stem");
  const ext = chip.querySelector<HTMLElement>(".cm-chip-clip .cm-chip-ext");
  if (!clip || !stem) return;
  const { distance, durationSec } = chipScrollMotion(stem.scrollWidth + (ext?.offsetWidth ?? 0), clip.clientWidth);
  chip.style.setProperty("--cm-scroll-x", `-${distance}px`);
  chip.style.setProperty("--cm-scroll-duration", `${durationSec}s`);
}

/**
 * Marks capsules whose stem is actually clipped so the idle fade does not
 * ghost the last letters of a name that already fits. Also writes the hover
 * scroll distance so duration scales with how far the name has to travel.
 */
export function syncChipTruncation(root: ParentNode): void {
  for (const chip of root.querySelectorAll<HTMLElement>(".cm-chip")) {
    const stem = chip.querySelector<HTMLElement>(".cm-chip-clip .cm-chip-stem");
    chip.classList.toggle("is-trunc", stem !== null && stem.scrollWidth > stem.clientWidth + 0.5);
    armChipScroll(chip);
  }
}

export function createChipElement(chip: ComposerChip): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `cm-chip cm-chip-${chip.kind}`;
  span.contentEditable = "false";
  span.dataset.chip = chipPayload(chip);
  span.title = chip.path ?? chip.name ?? chip.label;
  const icon = chip.kind === "mode" ? "" : iconSvg(chipIconName(chip.kind), "sm");
  span.innerHTML = `${icon}<span class="cm-chip-label">${chipLabelHtml(chip.label)}</span>${removeButtonHtml(chip.label)}`;
  return span;
}

/** Capsule id when the event target sits inside a capsule's × button, else `null`. */
export function chipRemoveTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const chip = target.closest(".cm-chip-x")?.closest<HTMLElement>(".cm-chip");
  if (!chip) return null;
  return parseChipPayload(chip.dataset.chip ?? "")?.id ?? null;
}

function endsWithNewline(nodes: ComposerNode[]): boolean {
  const last = nodes[nodes.length - 1];
  return last?.type === "text" ? last.value.endsWith("\n") : false;
}

export function readDoc(editor: HTMLElement, images: Map<string, PromptImage>): ComposerDoc {
  const nodes: ComposerNode[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      nodes.push({ type: "text", value: node.textContent ?? "" });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.classList.contains("cm-chip")) {
      const parsed = parseChipPayload(node.dataset.chip ?? "");
      if (!parsed) return;
      const image = images.get(parsed.id);
      nodes.push({ type: "chip", chip: image === undefined ? parsed : { ...parsed, image } });
      return;
    }
    if (node.tagName === "BR") {
      nodes.push({ type: "text", value: "\n" });
      return;
    }
    if (node.tagName === "DIV" || node.tagName === "P") {
      if (nodes.length > 0 && !endsWithNewline(nodes)) nodes.push({ type: "text", value: "\n" });
      for (const child of Array.from(node.childNodes)) walk(child);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(editor.childNodes)) walk(child);
  return normalizeDoc({ nodes });
}

export function writeDoc(editor: HTMLElement, doc: ComposerDoc, images: Map<string, PromptImage>): void {
  editor.replaceChildren();
  for (const node of doc.nodes) {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      parts.forEach((part, index) => {
        if (part.length > 0) editor.append(document.createTextNode(part));
        if (index < parts.length - 1) editor.append(document.createElement("br"));
      });
      continue;
    }
    if (node.chip.image) images.set(node.chip.id, node.chip.image);
    editor.append(createChipElement(node.chip));
    if (node.chip.kind !== "mode") editor.append(document.createTextNode(" "));
  }
}

/**
 * Relabels image capsules `图1..图N` in document order. Deleting or moving one
 * would otherwise leave a label that disagrees with the `[图N]` marker that
 * `serializeDoc` emits from the attachment order.
 */
export function renumberImageChips(editor: HTMLElement): void {
  const chips = editor.querySelectorAll<HTMLElement>(".cm-chip-image");
  let index = 0;
  for (const chip of chips) {
    const parsed = parseChipPayload(chip.dataset.chip ?? "");
    if (!parsed) continue;
    index += 1;
    const label = `图${index}`;
    if (parsed.label === label) continue;
    chip.dataset.chip = chipPayload({ ...parsed, label });
    writeChipLabel(chip, label);
    chip.querySelector(".cm-chip-x")?.setAttribute("aria-label", removeChipLabel(label));
    // Clipboard images have no path, so the tooltip has to follow the label.
    if (parsed.path === undefined && parsed.name === undefined) chip.title = label;
  }
}

/** Collapses the selection just before `node`, or at the end of `parent`. */
function placeCaretBefore(parent: Node, node: ChildNode | null): void {
  const selection = window.getSelection();
  if (!selection) return;
  const index = node === null ? -1 : [...parent.childNodes].indexOf(node);
  const range = document.createRange();
  range.setStart(parent, index < 0 ? parent.childNodes.length : index);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Caret after `node`. Text nodes keep the caret inside so `@` stays a mention. */
function placeCaretAfter(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, (node as Text).data.length);
  } else {
    const parent = node.parentNode;
    if (!parent) return;
    const index = [...parent.childNodes].indexOf(node as ChildNode);
    range.setStart(parent, index < 0 ? parent.childNodes.length : index + 1);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Removes a capsule by id, plus the single spacer inserted after it. When the
 * removal came from inside the editor the caret lands where the capsule was,
 * so typing continues in place instead of jumping to the end of the document.
 */
export function removeChipById(editor: HTMLElement, id: string): boolean {
  for (const chip of editor.querySelectorAll<HTMLElement>(".cm-chip")) {
    if (parseChipPayload(chip.dataset.chip ?? "")?.id !== id) continue;
    const spacer = chip.nextSibling;
    if (spacer?.nodeType === Node.TEXT_NODE && spacer.textContent === " ") spacer.remove();
    const parent = chip.parentNode;
    const after = chip.nextSibling;
    const fromEditor = editor.contains(document.activeElement);
    chip.remove();
    if (fromEditor && parent !== null) placeCaretBefore(parent, after);
    return true;
  }
  return false;
}

/** Remove every skill capsule with this definition name. */
export function removeSkillChipsByName(editor: HTMLElement, name: string): boolean {
  const ids: string[] = [];
  for (const chip of editor.querySelectorAll<HTMLElement>(".cm-chip")) {
    const payload = parseChipPayload(chip.dataset.chip ?? "");
    if (payload?.kind !== "skill") continue;
    if ((payload.name ?? payload.label) !== name) continue;
    ids.push(payload.id);
  }
  let removed = false;
  for (const id of ids) {
    if (removeChipById(editor, id)) removed = true;
  }
  return removed;
}

/** Drop mode capsules that collide with `name` (same switch, or plan/vibe/goal mutex). */
export function removeConflictingModeChips(editor: HTMLElement, name: string): boolean {
  const ids: string[] = [];
  for (const chip of editor.querySelectorAll<HTMLElement>(".cm-chip")) {
    const payload = parseChipPayload(chip.dataset.chip ?? "");
    if (payload?.kind !== "mode") continue;
    const existing = payload.name ?? payload.label.replace(/^\//u, "");
    if (modeChipConflictsWith(name, existing)) ids.push(payload.id);
  }
  let removed = false;
  for (const id of ids) {
    if (removeChipById(editor, id)) removed = true;
  }
  return removed;
}

export function placeCaretAtEnd(editor: HTMLElement): void {
  const last = editor.lastChild;
  if (last) {
    placeCaretAfter(last);
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function insertNodesAtCaret(editor: HTMLElement, nodes: Node[]): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    for (const node of nodes) editor.append(node);
    const last = nodes[nodes.length - 1];
    if (last) placeCaretAfter(last);
    else placeCaretAtEnd(editor);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  for (const node of [...nodes].reverse()) range.insertNode(node);
  const last = nodes[nodes.length - 1];
  if (last) placeCaretAfter(last);
}

/**
 * Inserts clipboard text as plain text. Pasted paths must stay text (only drops
 * and file clipboards become capsules), and the editor must never absorb the
 * markup that a rich-text paste would otherwise carry in.
 */
export function insertPlainText(editor: HTMLElement, text: string): void {
  const nodes: Node[] = [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  lines.forEach((line, index) => {
    if (line.length > 0) nodes.push(document.createTextNode(line));
    if (index < lines.length - 1) nodes.push(document.createElement("br"));
  });
  if (nodes.length === 0) return;
  insertNodesAtCaret(editor, nodes);
}

export type MentionQuery = {
  trigger: "@";
  query: string;
  textNode: Text;
  start: number;
  end: number;
};

const MENTION_TOKEN = /(?:^|[\s([{<"'])(@)([^\s]*)$/u;

function inChip(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(".cm-chip") !== null;
}

function mentionInText(textNode: Text, end: number): MentionQuery | null {
  if (end < 0 || end > textNode.data.length) return null;
  const before = textNode.data.slice(0, end);
  const match = MENTION_TOKEN.exec(before);
  if (!match || match.index === undefined) return null;
  const start = match[0].startsWith("@") ? match.index : match.index + 1;
  return {
    trigger: "@",
    query: match[2] ?? "",
    textNode,
    start,
    end,
  };
}

/** Mention in the text that ends at `node` (inclusive). */
function mentionEndingAt(node: Node | null): MentionQuery | null {
  if (!node || inChip(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    return mentionInText(node as Text, (node as Text).data.length);
  }
  if (node instanceof HTMLElement && !node.classList.contains("cm-chip")) {
    return mentionEndingAt(node.lastChild);
  }
  return null;
}

export function mentionAtCaret(editor: HTMLElement): MentionQuery | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
  const node = selection.anchorNode;
  if (!node || !editor.contains(node) || inChip(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const hit = mentionInText(textNode, selection.anchorOffset);
    if (hit) return hit;
    // Toolbar `@` / insertNode often leaves the caret at offset 0 of the next text node.
    if (selection.anchorOffset === 0) return mentionEndingAt(textNode.previousSibling);
    return null;
  }
  return mentionEndingAt(node.childNodes[selection.anchorOffset - 1] ?? null);
}

/**
 * Last `@query` mention in the editor. Used when the caret is not inside the
 * token (toolbar `@` button, then pick from the menu).
 */
export function findMentionToken(editor: HTMLElement, query: string): MentionQuery | null {
  const needle = `@${query}`;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let found: MentionQuery | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    if (inChip(textNode)) continue;
    const text = textNode.data;
    let from = 0;
    while (from <= text.length) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      const hit = mentionInText(textNode, at + needle.length);
      if (hit && hit.start === at && hit.query === query) found = hit;
      from = at + 1;
    }
  }
  return found;
}

export function replaceMention(mention: MentionQuery, chipEl: HTMLSpanElement): void {
  const text = mention.textNode.data;
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  mention.textNode.data = before;
  const parent = mention.textNode.parentNode;
  if (!parent) return;
  const spacer = document.createTextNode(after.length > 0 ? ` ${after}` : " ");
  parent.insertBefore(spacer, mention.textNode.nextSibling);
  parent.insertBefore(chipEl, spacer);
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(spacer, after.length > 0 ? 1 : 1);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function editorIsEmpty(editor: HTMLElement): boolean {
  const text = editor.textContent?.replace(/\u00a0/g, " ").trim() ?? "";
  return text.length === 0 && editor.querySelector(".cm-chip") === null;
}
