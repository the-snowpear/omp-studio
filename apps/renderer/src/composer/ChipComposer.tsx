import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { GitHubReferencePreview } from "./GitHubReferencePreview";
import { SessionReferenceDialog } from "./SessionReferenceDialog";
import { useSessionReferences } from "./SessionReferences";
import { isSessionIdCandidate, sameSessionSource, sessionReferenceChip, sessionReferenceLabel, SESSION_REFERENCE_START, type SessionReference } from "./sessionReference";
import type { GitHubReferenceSnapshot } from "./githubReference";
import type { GitCommitReferenceSnapshot } from "./gitCommitReference";
import type { BrowserReferenceSnapshot } from "./browserReference";
import { chipPayload, parseChipPayload } from "./ingest";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { useWordPrediction, type ComposerPrediction } from "./useWordPrediction";
import { isPrimaryModifier } from "../keyboard/shortcuts";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { isZh, pickLocale, useI18n } from "../i18n";
import type { ComposerChip, ComposerNode, ComposerSnapshot, MentionCandidate, PromptImage } from "./types";
import type { PredictionResult } from "@omp-studio/studio-protocol";
import { emptySnapshot, newChipId } from "./types";
import { defaultImageChipLabel, localizeImageChipLabel, snapshotFromDoc, snapshotIsEmpty, displayDocFromSerializedText, hasSerializedReference } from "./serialize";
import { fileToPromptImage, imagePreviewUrl, isImageFile } from "./ingest";
import { richPasteFromHtml, richPasteHasText, type RichPaste } from "./richPaste";
import {
  chipRemoveTarget,
  createChipElement,
  displaySessionChip,
  editorIsEmpty,
  findMentionToken,
  insertNodesAtCaret,
  insertPlainText,
  mentionAtCaret,
  placeCaretAtEnd,
  placeCaretAfter,
  readDoc,
  removeChipById,
  removeConflictingModeChips,
  removeSkillChipsByName,
  renumberImageChips,
  syncChipTruncation,
  replaceMention,
  writeDoc,
} from "./editorDom";
import { CommandMenu } from "./CommandMenu";
import { ImageAnnotatorModal } from "./ImageAnnotatorModal";
import { ImagePreview, type ImagePreviewSubject } from "./ImagePreview";
import { MentionMenu } from "./MentionMenu";
import { Icon } from "../icons";
import {
  filterSlashCommands,
  composerSlashExecute,
  lookupSlashCommand,
  parseSlashDraft,
  slashNeedsArgs,
  typedSlashSource,
  type StudioSlashCommand,
} from "./commands";

import { caretBox, dropRangeAt, insertNodesAtRange, registerComposerDrop, type ComposerDropTarget, type ComposerFileScope } from "./composerDrop";
import { DictationEditor, insertDictationText } from "./dictationEditor";
import { DictationKeyboard } from "./dictationKeyboard";
import type { ComposerDictationBinding, ComposerDictationHandle } from "./dictationTypes";

export type ChipComposerHandle = ComposerDictationHandle & {
  setDictationBinding(binding: ComposerDictationBinding | undefined): void;
  focus(options?: FocusOptions): void;
  clear(): void;
  getSnapshot(): ComposerSnapshot;
  setSnapshot(snapshot: ComposerSnapshot, options?: { preserveFocus?: boolean }): void;
  insertChip(chip: Omit<ComposerChip, "id"> & { id?: string }): void;
  /** Inserts text at the last caret (or the end), keeping serialized references as capsules. Never sends. */
  insertText(text: string): void;
  removeSkillChip(name: string): void;
  openFilePicker(): void;
  waitForAttachments?(): Promise<boolean>;
  openMention(trigger: "@" | "^"): void;
  openCommandMenu(): void;
  isEmpty(): boolean;
};

type Props = {
  dictation?: ComposerDictationBinding;
 prediction?:ComposerPrediction;
  predict?: (before:string,prefix:string,version:number)=>Promise<PredictionResult>;
  id?: string;
  ariaLabel?: string;
  fileAccept?: string;
  resolveImagePaste?: ((text: string) => Promise<readonly PromptImage[] | undefined>) | undefined;
  sessionReferences?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Keep the editor editable while the surrounding surface waits to submit. */
  submitDisabled?: boolean;
  compact?: boolean;
  workspaceId?: string;
  describedBy?: string;
  loadMentions?: (trigger: "@" | "/" | "^", query: string) => Promise<readonly MentionCandidate[]>;
  /** Explicit slash catalog. Omitted callers keep the static builtin fallback. */
  slashCatalog?: readonly StudioSlashCommand[];
  onRunCommand?: (command: StudioSlashCommand, args: string, images?: readonly PromptImage[]) => void;
  onChange?: (snapshot: ComposerSnapshot) => void;
  onSubmit?: () => void;
  onQueue?: () => void;
  /** Ctrl+Enter / Cmd+Enter: Runtime follow-up (text + images). */
  onFollowUp?: () => void;
  /** Escape when mention / slash menus are closed (queued-message edit cancel). */
  onEscape?: () => void;
  running?: boolean;
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onError?: (message: string) => void;
  /** Accept dragged capsules (rows, windows, files) for this conversation's main input. */
  dropTarget?: { documentId: string | undefined; sessionId: string | undefined; fileScope?: ComposerFileScope } | undefined;
  /** A capsule was grabbed; the owner runs the drag (reorder, move, open). */
  onCapsuleDrag?: ((event: PointerEvent<HTMLElement>, chip: HTMLElement, target: ComposerDropTarget) => void) | undefined;
};

function snapshotOf(editor: HTMLElement, images: Map<string, PromptImage>): ComposerSnapshot {
  return snapshotFromDoc(readDoc(editor, images));
}

/**
 * Capsule identity in document order. Capsule labels/wrapping only need
 * re-measuring when this changes (insert/remove/undo), not on every character
 * typed next to them — the old code re-walked every capsule twice per keystroke.
 */
function chipSignature(editor: HTMLElement): string {
  const chips = editor.querySelectorAll<HTMLElement>(".cm-chip");
  if (chips.length === 0) return "";
  const parts: string[] = [];
  for (const chip of chips) parts.push(chip.dataset.chip ?? "");
  return parts.join("\u0001");
}

type ThumbSubject = ImagePreviewSubject & { id: string };

/** Image capsules are immutable; the strip only changes when the capsules do. */
function sameThumbs(current: readonly ThumbSubject[], next: readonly ThumbSubject[]): boolean {
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const a = current[index]!;
    const b = next[index]!;
    if (a.id !== b.id || a.label !== b.label || a.url !== b.url || a.mimeType !== b.mimeType || a.data !== b.data) return false;
  }
  return true;
}

const imageObjectVersions = new WeakMap<PromptImage, number>();
let nextImageObjectVersion = 1;

function imageVersionOf(image: PromptImage | undefined): number {
  if (image === undefined) return 0;
  let version = imageObjectVersions.get(image);
  if (version === undefined) {
    version = nextImageObjectVersion++;
    imageObjectVersions.set(image, version);
  }
  return version;
}

function imageChipKey(snapshot: ComposerSnapshot): string {
  let key = "";
  for (const node of snapshot.doc.nodes) {
    if (node.type !== "chip" || node.chip.kind !== "image") continue;
    key += `${node.chip.id}\u0000${node.chip.label}\u0000${node.chip.path ?? ""}\u0000${imageVersionOf(node.chip.image)}\u0001`;
  }
  return key;
}

/**
 * Absolute OS paths resolved by Main. Files under the workspace come back
 * workspace-relative; anything else on the machine keeps its absolute path,
 * which the Runtime resolves just as well.
 */
async function resolveOsPaths(
  workspaceId: string,
  files: File[],
): Promise<Map<File, { kind: "file" | "dir" | "image"; path: string; name: string }>> {
  const out = new Map<File, { kind: "file" | "dir" | "image"; path: string; name: string }>();
  const chrome = window.ompStudioChrome;
  if (chrome?.getPathForFile === undefined || chrome.resolveDroppedPaths === undefined) return out;
  const pairs: Array<{ file: File; path: string }> = [];
  for (const file of files) {
    const path = chrome.getPathForFile(file);
    if (path) pairs.push({ file, path });
  }
  if (pairs.length === 0) return out;
  const resolved = await chrome.resolveDroppedPaths(workspaceId, pairs.map((pair) => pair.path));
  resolved.forEach((entry, index) => {
    const pair = pairs[index];
    if (!pair || !entry.ok) return;
    out.set(pair.file, { kind: entry.kind, path: entry.path, name: entry.name });
  });
  return out;
}

export const ChipComposer = forwardRef<ChipComposerHandle, Props>(function ChipComposer(
  {
    id,
    ariaLabel,
    fileAccept,
    resolveImagePaste,
    sessionReferences,
    placeholder,
    disabled,
    submitDisabled = false,
    compact,
    dictation,
    prediction,
    workspaceId,
    describedBy,
    loadMentions,
    slashCatalog,
    onRunCommand,
    onChange,
    onSubmit,
    onQueue,
    onFollowUp,
    onEscape,
    running,
    onFocus,
    onBlur,
    onPointerDown,
    onError,
    predict,
    dropTarget,
    onCapsuleDrag,
  },
  ref,
) {
  const { resolvedLanguage, t } = useI18n();
  const zh = resolvedLanguage === "zh";
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const executionTarget = useExecutionTarget();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [githubPreview, setGithubPreview] = useState<GitHubReferenceSnapshot | GitCommitReferenceSnapshot | BrowserReferenceSnapshot>();
  const [sessionPreview, setSessionPreview] = useState<{ chipId: string; reference: SessionReference }>();
  const access = useSessionReferences();
  const lookupSessions = sessionReferences ? access : null;
  const savedCaret = useRef<Range | null>(null);
  useEffect(() => {
    const remember = () => {
      const selection = window.getSelection();
      if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode) && editorRef.current.contains(selection.focusNode)) savedCaret.current = selection.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, [document, window]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** Set by Ctrl/Cmd+Shift+V so the next paste skips HTML conversion. */
  const plainPasteRef = useRef(false);
  const imagesRef = useRef(new Map<string, PromptImage>());
  const attachmentEpoch = useRef(0);
  const pendingAttachments = useRef<Promise<boolean> | null>(null);
  useEffect(() => () => { attachmentEpoch.current++; }, []);
  const composingRef = useRef(false);
  const dictationEditorRef = useRef<DictationEditor | null>(null);
  const dictationKeyboardRef = useRef<DictationKeyboard | null>(null);
  const dictationBindingRef = useRef(dictation);
  const [dictationBindingActive, setDictationBindingActive] = useState(() => Boolean(dictation?.active));
  const [dictationSpanActive, setDictationSpanActive] = useState(false);
  const committingDictationRef = useRef(false);
  const emitRef = useRef<() => ComposerSnapshot>(() => emptySnapshot());
  const keyboardBlockedRef = useRef(false);
  useEffect(() => {
    if (dictation === undefined) return;
    dictationBindingRef.current = dictation;
    const nextActive = Boolean(dictation.active);
    setDictationBindingActive((prev) => (prev === nextActive ? prev : nextActive));
    dictationKeyboardRef.current?.bindingChanged();
  }, [dictation]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const transaction = new DictationEditor(editor);
    dictationEditorRef.current = transaction;
    const keyboard = new DictationKeyboard(editor, {
      binding: () => dictationBindingRef.current,
      blocked: () => keyboardBlockedRef.current,
      composing: () => composingRef.current,
      insertText: (text) => {
        insertDictationText(editor, text);
        emitRef.current();
      },
    });
    dictationKeyboardRef.current = keyboard;
    const remember = () => transaction.rememberSelection();
    const beforeEdit = () => { if (!committingDictationRef.current) transaction.beforeEdit(); };
    editor.addEventListener("beforeinput", beforeEdit);
    editor.ownerDocument.addEventListener("selectionchange", remember);
    editor.ownerDocument.addEventListener("keyup", keyboard.keyup, true);
    editor.ownerDocument.addEventListener("visibilitychange", keyboard.visibilityChange);
    editor.ownerDocument.defaultView?.addEventListener("blur", keyboard.windowBlur);
    return () => {
      keyboard.dispose();
      transaction.invalidate();
      dictationEditorRef.current = null;
      dictationKeyboardRef.current = null;
      editor.removeEventListener("beforeinput", beforeEdit);
      editor.ownerDocument.removeEventListener("selectionchange", remember);
      editor.ownerDocument.removeEventListener("keyup", keyboard.keyup, true);
      editor.ownerDocument.removeEventListener("visibilitychange", keyboard.visibilityChange);
      editor.ownerDocument.defaultView?.removeEventListener("blur", keyboard.windowBlur);
    };
  }, []);
  const chipSignatureRef = useRef("");
  const imageChipKeyRef = useRef("");
  const truncationFrame = useRef(0);
  const scheduleTruncation = useCallback(() => {
    if (truncationFrame.current !== 0) return;
    truncationFrame.current = requestAnimationFrame(() => {
      truncationFrame.current = 0;
      const editor = editorRef.current;
      if (editor !== null) syncChipTruncation(editor);
    });
  }, []);
  useEffect(() => () => {
    if (truncationFrame.current !== 0) cancelAnimationFrame(truncationFrame.current);
    truncationFrame.current = 0;
  }, []);
  const [documentVersion,setDocumentVersion]=useState(0);
  const predictionVersion=useRef(0);
  const predictionBusy=useRef(false);
  const [legacyPrediction,setPrediction]=useState<{suffix:string;version:number;left:number;top:number}|null>(null);
  const invalidatePrediction=()=>{predictionVersion.current++;setPrediction(null);setDocumentVersion(value=>value+1);};
  const [empty, setEmpty] = useState(true);
  const [thumbs, setThumbs] = useState<Array<ImagePreviewSubject & { id: string }>>([]);
  const [preview, setPreview] = useState<(ImagePreviewSubject & { id: string }) | null>(null);
  const [annotatingId, setAnnotatingId] = useState<string | null>(null);
  const [mention, setMention] = useState<{ trigger: "@" | "^"; query: string } | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [slashSource, setSlashSource] = useState("");
  const [detachedCommand, setDetachedCommand] = useState(false);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const hadLeadingSlash = useRef(false);

  const closeCommandMenu = (): void => {
    setDetachedCommand(false);
    setCommandDismissed(true);
  };

  const emit = (): ComposerSnapshot => {
    dictationEditorRef.current?.noteEdit();
    invalidatePrediction();
    const editor = editorRef.current;
    if (!editor) return emptySnapshot();
    // Renumbering labels and measuring truncation are the only forced-layout
    // reads on this path, and only a capsule can invalidate them: plain typing
    // next to a `/plan` chip must not re-measure every capsule twice.
    if (chipSignature(editor) !== chipSignatureRef.current) {
      renumberImageChips(editor, zh);
      refreshSessionChips(editor);
      chipSignatureRef.current = chipSignature(editor);
      syncChipTruncation(editor);
      // Wrapping/scrollbars settle one frame later; coalesce capsule and resize work.
      scheduleTruncation();
    }
    const snapshot = snapshotOf(editor, imagesRef.current);
    const typed = typedSlashSource(snapshot.doc);
    setSlashSource(typed);
    const leadingSlash = typed.startsWith("/");
    if (leadingSlash && !hadLeadingSlash.current) {
      setDetachedCommand(false);
      setCommandDismissed(false);
    }
    hadLeadingSlash.current = leadingSlash;
    // Arguments and prose are still parsed when sending, but are no longer
    // completion queries. Dismissing this slash lasts until a new one is typed.
    if (!/^\/[^\s:]*$/u.test(typed)) closeCommandMenu();
    setEmpty(snapshotIsEmpty(snapshot));
    // Preview URLs are base64 data URLs; rebuilding them per keystroke allocates
    // the whole payload again for an image capsule that cannot have changed.
    const imageKey = imageChipKey(snapshot);
    if (imageKey !== imageChipKeyRef.current) {
      imageChipKeyRef.current = imageKey;
      const nextThumbs = snapshot.doc.nodes.flatMap((node) => {
        if (node.type !== "chip" || node.chip.kind !== "image" || node.chip.image === undefined) return [];
        return [{
          id: node.chip.id,
          url: imagePreviewUrl(node.chip.image),
          label: node.chip.label,
          mimeType: node.chip.image.mimeType,
          data: node.chip.image.data,
        }];
      });
      setThumbs((current) => (sameThumbs(current, nextThumbs) ? current : nextThumbs));
      // Drop bytes for capsules the user deleted; base64 payloads are large.
      const live = new Set(nextThumbs.map((thumb) => thumb.id));
      for (const id of [...imagesRef.current.keys()]) {
        if (!live.has(id)) imagesRef.current.delete(id);
      }
    }
    onChange?.(snapshot);
    return snapshot;
  };

  const refreshSessionChips = (editor: HTMLElement) => {
    for (const element of editor.querySelectorAll<HTMLElement>(".cm-chip-session")) {
      const reference = parseChipPayload(element.dataset.chip ?? "")?.sessionReference;
      if (!reference) continue;
      const source = reference.source;
      const label = source && access?.previewTitle(source, zh) || sessionReferenceLabel(reference, zh);
      const origin = source && access?.crossEnvironment(source) ? access.environmentName(source.targetId) : "";
      const count = reference.messages.length;
      const note = [origin, count ? t("sessionReference.attached", { count }) : ""].filter(Boolean).join(" · ");
      displaySessionChip(element, label, note, reference.sessionId, zh);
    }
  };

  emitRef.current = emit;

  const insertChip = (draft: Omit<ComposerChip, "id"> & { id?: string }): void => {
    const editor = editorRef.current;
    if (!editor) return;
    if (draft.kind === "mode") {
      const name = draft.name ?? draft.label.replace(/^\//u, "");
      removeConflictingModeChips(editor, name);
      const chip: ComposerChip = {
        ...draft,
        id: draft.id ?? newChipId(),
        name,
        label: draft.label.replace(/^\//u, "") || name,
      };
      editor.insertBefore(createChipElement(chip, document), editor.firstChild);
      placeCaretAtEnd(editor);
      emit();
      return;
    }
    dictationEditorRef.current?.beforeEdit();
    const chip: ComposerChip = { ...draft, id: draft.id ?? newChipId() };
    if ((chip.kind === "github" || chip.kind === "git-commit" || chip.kind === "browser") && chip.reference) {
      for (const element of editor.querySelectorAll<HTMLElement>(".cm-chip")) {
        const prior = parseChipPayload(element.dataset.chip ?? "");
        if (prior?.reference?.key !== chip.reference.key) continue;
        element.replaceWith(createChipElement({ ...chip, id: prior.id }));
        editor.focus(); emit(); return;
      }
      const caret = savedCaret.current;
      if (caret && editor.contains(caret.commonAncestorContainer)) {
        editor.focus(); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(caret);
      }
    }
    if (chip.image) imagesRef.current.set(chip.id, chip.image);
    insertNodesAtCaret(editor, [createChipElement(chip, document), document.createTextNode(" ")]);
    emit();
  };

  const removeChip = (chipId: string): void => {
    const editor = editorRef.current;
    if (!editor || !removeChipById(editor, chipId)) return;
    emit();
  };

  const replaceChipImage = (chipId: string, nextImage: PromptImage): void => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    for (const element of editor.querySelectorAll<HTMLElement>(".cm-chip-image")) {
      const parsed = parseChipPayload(element.dataset.chip ?? "");
      if (parsed?.id !== chipId) continue;
      if (parsed.path !== undefined) {
        const { path: _droppedPath, ...rest } = parsed;
        const nextChip: ComposerChip = { ...rest, label: defaultImageChipLabel(undefined, zh) };
        element.dataset.chip = chipPayload(nextChip);
        element.title = nextChip.label;
        renumberImageChips(editor, zh);
        syncChipTruncation(editor);
      }
      imagesRef.current.set(chipId, nextImage);
      emit();
      return;
    }
  };

  /* Dragged capsules land where the pointer is, not at the last caret. */
  const moveChipTo = (element: HTMLElement, point: { x: number; y: number }): HTMLElement | null => {
    const editor = editorRef.current;
    if (!editor || !editor.contains(element)) return null;
    const marker = document.createComment("move");
    dropRangeAt(editor, point).insertNode(marker);
    const spacer = element.nextSibling;
    const beside = marker.nextSibling === element || marker.previousSibling === element
      || (marker.previousSibling === spacer && spacer?.nodeType === Node.TEXT_NODE && spacer.textContent === " ");
    if (beside) { marker.remove(); return element; }
    dictationEditorRef.current?.beforeEdit();
    // Close the gap the capsule leaves: its own spacer, then one of two spaces meeting there.
    const previous = element.previousSibling;
    let next = element.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE && next.textContent === " ") { const after = next.nextSibling; next.remove(); next = after; }
    element.remove();
    const openBefore = !previous || previous.nodeName === "BR" || (previous.nodeType === Node.TEXT_NODE && /\s$/u.test((previous as Text).data));
    if (openBefore && next?.nodeType === Node.TEXT_NODE && /^\s/u.test((next as Text).data)) {
      const text = next as Text;
      if (text.data.length === 1) text.remove(); else text.data = text.data.slice(1);
    }
    const at = document.createRange();
    at.setStartBefore(marker); at.collapse(true);
    marker.remove();
    insertNodesAtRange(editor, at, [element]);
    typeAfter(editor, element);
    emit();
    return element;
  };
  /** After a drop the user keeps typing right behind the capsule. */
  const typeAfter = (editor: HTMLElement, element: HTMLElement) => {
    editor.focus({ preventScroll: true });
    const next = element.nextSibling, selection = window.getSelection();
    if (next?.nodeType !== Node.TEXT_NODE || !selection) { placeCaretAfter(element); return; }
    const range = document.createRange();
    range.setStart(next, /^\s/u.test((next as Text).data) ? 1 : 0);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
  };
  const insertChipAt = (draft: Omit<ComposerChip, "id"> & { id?: string }, point: { x: number; y: number }): HTMLElement | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    if (draft.sessionReference) {
      const existing = existingSessionChip(editor, draft.sessionReference, draft.sessionReference.messages.length > 0);
      if (existing) return moveChipTo(existing, point);
    }
    dictationEditorRef.current?.beforeEdit();
    const chip: ComposerChip = { ...draft, id: draft.id ?? newChipId() };
    if (chip.image) imagesRef.current.set(chip.id, chip.image);
    const element = createChipElement(chip, document);
    insertNodesAtRange(editor, dropRangeAt(editor, point), [element]);
    typeAfter(editor, element);
    emit();
    return element;
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dropActions = useRef({ insertChipAt, moveChipTo, removeChip, disabled: !!disabled, onCapsuleDrag });
  dropActions.current = { insertChipAt, moveChipTo, removeChip, disabled: !!disabled, onCapsuleDrag };
  const dropTargetRef = useRef<ComposerDropTarget | null>(null);
  const dropDocumentId = dropTarget?.documentId, dropSessionId = dropTarget?.sessionId, dropEnabled = dropTarget !== undefined;
  const dropWorkspaceId = dropTarget?.fileScope?.workspaceId, dropExecutionTargetId = dropTarget?.fileScope?.targetId;
  useEffect(() => {
    const root = rootRef.current, editor = editorRef.current;
    if (!dropEnabled || !root || !editor) return;
    const element = root.closest<HTMLElement>(".composer") ?? root;
    const caret = document.createElement("span");
    caret.className = "cm-drop-caret";
    caret.setAttribute("aria-hidden", "true");
    root.append(caret);
    const target: ComposerDropTarget = {
      documentId: dropDocumentId, sessionId: dropSessionId, element, editor,
      fileScope: dropExecutionTargetId === undefined ? undefined : { targetId: dropExecutionTargetId, workspaceId: dropWorkspaceId },
      accepts: () => !dropActions.current.disabled && editor.isConnected,
      showCaret: point => {
        const box = caretBox(dropRangeAt(editor, point), editor), origin = root.getBoundingClientRect();
        caret.style.height = `${box.height}px`;
        caret.style.transform = `translate(${box.x - origin.left - 1}px, ${box.y - origin.top}px)`;
        caret.classList.add("is-visible");
        element.dataset.capsuleOver = "";
      },
      hideCaret: () => { caret.classList.remove("is-visible"); delete element.dataset.capsuleOver; },
      insertAt: (chip, point) => dropActions.current.insertChipAt(chip, point),
      moveTo: (chip, point) => dropActions.current.moveChipTo(chip, point),
      remove: chipId => dropActions.current.removeChip(chipId),
      chipOf: chip => {
        const payload = editor.contains(chip) ? parseChipPayload(chip.dataset.chip ?? "") : null;
        if (!payload) return null;
        const image = imagesRef.current.get(payload.id);
        return image ? { ...payload, image } : payload;
      },
    };
    dropTargetRef.current = target;
    const release = registerComposerDrop(target);
    return () => { release(); caret.remove(); if (dropTargetRef.current === target) dropTargetRef.current = null; };
  }, [document, dropEnabled, dropDocumentId, dropSessionId, dropExecutionTargetId, dropWorkspaceId]);
  const onCapsulePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = dropTargetRef.current, drag = dropActions.current.onCapsuleDrag;
    if (!target || !drag || disabled || event.button !== 0 || chipRemoveTarget(event.target) !== null) return;
    const chip = (event.target as Element).closest<HTMLElement>(".cm-chip");
    if (!chip || !event.currentTarget.contains(chip) || chip.classList.contains("cm-chip-mode")) return;
    // No text selection or native drag from a capsule; a click still opens it.
    event.preventDefault();
    drag(event as PointerEvent<HTMLElement>, chip, target);
  };

  const enqueueAttachment = (work: (current: () => boolean) => Promise<boolean>): Promise<boolean> => {
    const epoch = attachmentEpoch.current;
    const current = () => attachmentEpoch.current === epoch;
    const next = (pendingAttachments.current ?? Promise.resolve(true)).then(() => current() ? work(current) : false).catch(cause => {
      if (current()) onError?.(cause instanceof Error ? cause.message : String(cause));
      return false;
    });
    pendingAttachments.current = next;
    void next.then(() => { if (pendingAttachments.current === next) pendingAttachments.current = null; });
    return next;
  };
  const readFiles = async (fileList: FileList | File[], current: () => boolean): Promise<boolean> => {
    const files = Array.from(fileList);
    if (files.length === 0) return true;
    const resolved = workspaceId && executionTarget.id === null ? await resolveOsPaths(workspaceId, files) : new Map();
    if (!current()) return false;
    let skipped = 0;
    for (const file of files) {
      const meta = resolved.get(file);
      // Main resolved the real kind by stat, so a folder named `foo.png` never
      // reaches the image branch; extension sniffing is only the fallback.
      if (meta ? meta.kind === "image" : isImageFile(file)) {
        const image = await fileToPromptImage(file).catch(() => null);
        if (!current()) return false;
        // Disk-backed images travel as @path. Preview bytes are optional: a
        // read failure must not drop the capsule. SVG is the exception: @path
        // would make the Runtime read it as text, so it always travels as
        // wire bytes ([图N]) and the Runtime rasterizes it for vision.
        if (image) {
          const svg = image.mimeType === "image/svg+xml";
          insertChip({
            kind: "image",
            label: meta && !svg ? meta.name : defaultImageChipLabel(undefined, zh),
            ...(meta && !svg ? { path: meta.path } : {}),
            image,
          });
          continue;
        }
        if (meta) {
          insertChip({
            kind: "image",
            label: meta.name,
            path: meta.path,
          });
          continue;
        }
        skipped += 1;
        continue;
      }
      if (meta) {
        if (!current()) return false;
        insertChip({
          kind: meta.kind === "dir" ? "dir" : "file",
          label: meta.name,
          path: meta.path,
        });
        continue;
      }
      skipped += 1;
    }
    if (skipped > 0) {
      onError?.(executionTarget.id !== null
        ? pickLocale(
            "SSH 工作区可以直接附加图片；普通文件请通过 @ 选择远端文件，本机文件尚不支持上传。",
            "SSH workspaces can attach images directly; use @ to select remote files, as uploading local files is not supported yet.",
          )
        : workspaceId
          ? pickLocale(
              "有些文件读不到，未添加为胶囊：可能已被移动或是快捷方式。",
              "Some files could not be read and were not attached: they may have been moved or are shortcuts.",
            )
          : pickLocale(
              "当前环境无法解析磁盘路径，只有图片可以附件。",
              "Disk paths cannot be resolved here; only images can be attached.",
            ));
    }
    return skipped === 0;
  };
  const ingestFiles = (files: FileList | File[]) => {
    const captured = Array.from(files);
    return enqueueAttachment(current => readFiles(captured, current));
  };

  useEffect(() => {
    setPreview((current) => {
      if (current === null) return null;
      const live = thumbs.find((thumb) => thumb.id === current.id);
      return live ?? null;
    });
    setAnnotatingId((current) => (current !== null && thumbs.some((thumb) => thumb.id === current) ? current : null));
  }, [thumbs]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor) {
      renumberImageChips(editor, zh);
      refreshSessionChips(editor);
      chipSignatureRef.current = chipSignature(editor);
      imageChipKeyRef.current = imageChipKey(snapshotOf(editor, imagesRef.current));
      syncChipTruncation(editor);
    }
    setThumbs(current => current.map(thumb => ({ ...thumb, label: localizeImageChipLabel(thumb.label, zh) })));
  }, [zh]);

  /* Capsule truncation depends on the editor's content width; typing only moves
     the height. A width-only ResizeObserver re-measures when the box actually
     changes (window resize, scrollbar appearing) without reading layout on the
     keystroke path, which is where the per-character measurement used to be. */
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || typeof ResizeObserver === "undefined") return undefined;
    let width = editor.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? editor.clientWidth;
      if (Math.abs(next - width) < 0.5) return;
      width = next;
      scheduleTruncation();
    });
    observer.observe(editor);
    return () => observer.disconnect();
  }, [scheduleTruncation]);

  useImperativeHandle(ref, () => ({
    setDictationBinding(binding) {
      dictationBindingRef.current = binding;
      const nextActive = Boolean(binding?.active);
      setDictationBindingActive((prev) => (prev === nextActive ? prev : nextActive));
      dictationKeyboardRef.current?.bindingChanged();
    },
    beginDictation(id) {
      if (disabled) return false;
      invalidatePrediction();
      const ok = dictationEditorRef.current?.begin(id) ?? false;
      if (ok) setDictationSpanActive(true);
      return ok;
    },
    updateDictation(id, committedText, partialText) {
      dictationEditorRef.current?.update(id, committedText, partialText);
    },
    commitDictation(id, text) {
      committingDictationRef.current = true;
      try {
        const result = dictationEditorRef.current?.commit(id, text) ?? { applied: false, unchanged: false };
        setDictationSpanActive(false);
        if (result.applied) emit();
        return result;
      } finally {
        committingDictationRef.current = false;
      }
    },
    cancelDictation(id) {
      dictationEditorRef.current?.cancel(id);
      setDictationSpanActive(false);
    },
    focus(options) {
      editorRef.current?.focus(options);
    },
    clear() {
      attachmentEpoch.current++;
      setSessionPreview(undefined);
      setPreview(null);
      setAnnotatingId(null);
      const editor = editorRef.current;
      if (!editor) return;
      dictationEditorRef.current?.invalidate();
      setDictationSpanActive(false);
      imagesRef.current.clear();
      editor.replaceChildren();
      emit();
    },
    getSnapshot() {
      const editor = editorRef.current;
      if (!editor) return emptySnapshot();
      return snapshotOf(editor, imagesRef.current);
    },
    setSnapshot(snapshot, options) {
      attachmentEpoch.current++;
      setSessionPreview(undefined);
      setPreview(null);
      setAnnotatingId(null);
      const editor = editorRef.current;
      if (!editor) return;
      dictationEditorRef.current?.invalidate();
      setDictationSpanActive(false);
      imagesRef.current.clear();
      writeDoc(editor, snapshot.doc, imagesRef.current);
      refreshSessionChips(editor);
      emit();
      if (!options?.preserveFocus || editor.ownerDocument.activeElement === editor) placeCaretAtEnd(editor);
    },
    insertChip,
    insertText(text) {
      const editor = editorRef.current;
      if (!editor || disabled || text.length === 0) return;
      editor.focus();
      const caret = savedCaret.current;
      const selection = window.getSelection();
      if (caret && editor.contains(caret.commonAncestorContainer)) { selection?.removeAllRanges(); selection?.addRange(caret); }
      else if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) placeCaretAtEnd(editor);
      invalidatePrediction();
      dictationEditorRef.current?.beforeEdit();
      insertSerializedText(editor, text);
      emit();
      refreshMention();
    },
    removeSkillChip(name) {
      const editor = editorRef.current;
      if (!editor || !removeSkillChipsByName(editor, name)) return;
      emit();
    },
    openFilePicker() {
      fileRef.current?.click();
    },
    async waitForAttachments() {
      let pending = pendingAttachments.current;
      while (pending) {
        if (!await pending) return false;
        if (pendingAttachments.current === pending) return true;
        pending = pendingAttachments.current;
      }
      return true;
    },
    openMention(trigger: "@" | "^") {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      insertNodesAtCaret(editor, [document.createTextNode(trigger)]);
      emit();
      setMention({ trigger, query: "" });
    },
    openCommandMenu() {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      setCommandDismissed(false);
      const snapshot = snapshotOf(editor, imagesRef.current);
      const typed = typedSlashSource(snapshot.doc);
      if (typed.length === 0) {
        if (snapshot.text.length === 0) {
          insertNodesAtCaret(editor, [document.createTextNode("/")]);
          emit();
          setDetachedCommand(false);
          return;
        }
        setDetachedCommand(true);
        setCommandIndex(0);
        return;
      }
      if (/^\/[^\s:]*$/u.test(typed)) {
        setSlashSource(typed);
        setDetachedCommand(false);
        return;
      }
      setDetachedCommand(true);
      setCommandIndex(0);
    },
    isEmpty() {
      return editorRef.current ? editorIsEmpty(editorRef.current) : true;
    },
  }));

  useEffect(() => {
    if (!mention || loadMentions === undefined) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void loadMentions(mention.trigger, mention.query).then((items) => {
      if (cancelled) return;
      setCandidates([...items]);
      setActiveIndex(0);
    });
    return () => {
      cancelled = true;
    };
  }, [mention, loadMentions]);

  const acceptMention = (item: MentionCandidate): void => {
    const editor = editorRef.current;
    if (!editor) return;
    // Toolbar `@` often leaves the caret outside the token; still fold `@` into the capsule.
    const at = mentionAtCaret(editor) ?? (mention ? findMentionToken(editor, mention.query, mention.trigger) : null);
    const chip: ComposerChip = {
      id: newChipId(),
      kind: item.kind,
      label: item.label,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.name === undefined ? {} : { name: item.name }),
    };
    const el = createChipElement(chip, document);
    if (at) replaceMention(at, el);
    else insertNodesAtCaret(editor, [el, document.createTextNode(" ")]);
    setMention(null);
    emit();
  };

  const insertModeChip = (name: string): void => {
    insertChip({ kind: "mode", label: name, name });
  };

  const clearCommandDraft = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    dictationEditorRef.current?.invalidate();
    setDictationSpanActive(false);
    imagesRef.current.clear();
    editor.replaceChildren();
    emit();
    placeCaretAtEnd(editor);
  };

  const replaceSlashCommand = (
    replacement: string,
    mode: "prefix" | "bare-slash" | "overlay" = "prefix",
  ): void => {
    const editor = editorRef.current;
    if (!editor) return;
    dictationEditorRef.current?.invalidate();
    setDictationSpanActive(false);
    const currentDoc = readDoc(editor, imagesRef.current);
    const nextNodes: ComposerNode[] = [];
    if (mode === "overlay") {
      for (const node of currentDoc.nodes) {
        if (node.type === "chip" && node.chip.kind === "mode") nextNodes.push(node);
      }
      if (replacement.length > 0) nextNodes.push({ type: "text", value: replacement });
      for (const node of currentDoc.nodes) {
        if (node.type === "chip" && node.chip.kind !== "mode") nextNodes.push(node);
      }
    } else {
      let replaced = false;
      for (const node of currentDoc.nodes) {
        if (!replaced && node.type === "chip" && node.chip.kind === "mode") {
          nextNodes.push(node);
          continue;
        }
        if (!replaced && node.type === "text") {
          replaced = true;
          const stripped = mode === "bare-slash"
            ? (node.value.startsWith("/") ? node.value.slice(1) : node.value)
            : node.value.replace(/^\/[^\s:\r\n]*[ \t:]*/u, "");
          const combined = `${replacement}${stripped}`;
          if (combined.length > 0) nextNodes.push({ type: "text", value: combined });
          continue;
        }
        nextNodes.push(node);
      }
      if (!replaced && replacement.length > 0) {
        nextNodes.unshift({ type: "text", value: replacement });
      }
    }
    writeDoc(editor, { nodes: nextNodes }, imagesRef.current);
    emit();
    if (replacement.length > 0) {
      for (const child of Array.from(editor.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains("cm-chip-mode")) continue;
        if (child.nodeType === Node.TEXT_NODE) {
          const textNode = child as Text;
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.setStart(textNode, Math.min(replacement.length, textNode.data.length));
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            return;
          }
        }
        break;
      }
    }
    placeCaretAtEnd(editor);
  };

  const slashDraft = parseSlashDraft(slashSource);
  const slashCompletion = /^\/[^\s:]*$/u.test(slashSource) ? slashDraft : null;
  const commandItems = detachedCommand
    ? filterSlashCommands("", slashCatalog)
    : slashCompletion
      ? filterSlashCommands(slashCompletion.name, slashCatalog)
      : [];
  const commandOpen = (detachedCommand || slashCompletion !== null) && mention === null && !commandDismissed;
  keyboardBlockedRef.current = !!disabled || !!mention || commandOpen || !!legacyPrediction;
  useEffect(()=>{
    setPrediction(null);
    if(!predict||disabled||composingRef.current||mention||commandOpen)return;
    const editor=editorRef.current;const selection=window.getSelection();
    if(!editor||document.activeElement!==editor||!selection?.isCollapsed||!selection.rangeCount||selection.anchorNode?.nodeType!==Node.TEXT_NODE||!editor.contains(selection.anchorNode))return;
    const range=selection.getRangeAt(0);const tail=range.cloneRange();tail.selectNodeContents(editor);tail.setStart(range.endContainer,range.endOffset);
    if(tail.toString()||tail.cloneContents().querySelector("[contenteditable=false]"))return;
    const text=snapshotOf(editor,imagesRef.current).text;
    const prefix=/[\p{L}\p{N}_-]*$/u.exec(text)?.[0]??"";
    if(prefix.length>256||!text.trim())return;
    const version=predictionVersion.current;let active=true;
    const timer=setTimeout(()=>{if(predictionBusy.current)return;predictionBusy.current=true;void predict(text.slice(0,text.length-prefix.length).slice(-8192),prefix,version).then(result=>{
      if(!active||predictionVersion.current!==version||result.version!==version||!result.suffix||composingRef.current||document.activeElement!==editor)return;
      const rect=range.getBoundingClientRect();const parent=editor.parentElement!.getBoundingClientRect();
      setPrediction({suffix:result.suffix,version,left:rect.right-parent.left,top:rect.top-parent.top});
    }).catch(()=>{}).finally(()=>{predictionBusy.current=false;});},200);
    return()=>{active=false;clearTimeout(timer);};
  },[documentVersion,predict,disabled,mention,commandOpen]);

  useEffect(() => {
    setCommandIndex(0);
  }, [slashDraft?.name, detachedCommand]);

  useEffect(() => {
    if (!commandOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (editorRef.current?.contains(target)) return;
      if (editorRef.current?.parentElement?.querySelector(".cm-command")?.contains(target)) return;
      closeCommandMenu();
    };
    const onSelectionChange = (): void => {
      if (detachedCommand) return;
      const editor = editorRef.current, selection = window.getSelection();
      if (!editor || !selection?.isCollapsed || !selection.rangeCount || !editor.contains(selection.anchorNode)) {
        closeCommandMenu();
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      range.selectNodeContents(editor);
      range.setEnd(selection.anchorNode!, selection.anchorOffset);
      const prefix = range.cloneContents();
      prefix.querySelectorAll(".cm-chip-mode").forEach(chip => chip.remove());
      if (!/^\/[^\s:]*$/u.test(prefix.textContent ?? "")) closeCommandMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [commandOpen, detachedCommand, document, window]);

  const acceptCommand = (item: StudioSlashCommand): void => {
    const args = slashDraft !== null && (slashDraft.name === item.name || item.aliases.includes(slashDraft.name))
      ? slashDraft.args
      : "";
    if (item.availability === "disabled") return;
    const overlay = detachedCommand;
    closeCommandMenu();
    if (item.select === "chip") {
      setDetachedCommand(false);
      if (!overlay) replaceSlashCommand("", "prefix");
      insertModeChip(item.name);
      return;
    }
    if (slashNeedsArgs(item, args) || (item.select === "complete-args" && args.length === 0)) {
      setDetachedCommand(false);
      replaceSlashCommand(`/${item.name} `, overlay ? "overlay" : "prefix");
      setCommandIndex(0);
      return;
    }
    if (!overlay && (item.name === "btw" || item.side) && editorRef.current) {
      onRunCommand?.(item, args, snapshotOf(editorRef.current, imagesRef.current).images);
    } else onRunCommand?.(item, args);
    setDetachedCommand(false);
    if (!overlay) clearCommandDraft();
  };

  const refreshMention = (): void => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const at = mentionAtCaret(editor);
    setMention(at ? { trigger: at.trigger, query: at.query } : null);
  };

  const dictationActive = Boolean(dictation?.active) || dictationBindingActive || dictationSpanActive;
  const predictionState = useWordPrediction(editorRef, prediction, !!disabled || !!mention || commandOpen || dictationActive);

  const onInput = (_event: FormEvent<HTMLDivElement>): void => {
    if (committingDictationRef.current) return;
    emit();
    refreshMention();
  };

  const sessionChipElements = (editor: HTMLElement) => [...editor.querySelectorAll<HTMLElement>(".cm-chip-session")];
  const existingSessionChip = (editor: HTMLElement, reference: SessionReference, matchExcerpts = false) =>
    sessionChipElements(editor).find(element => {
      const existing = parseChipPayload(element.dataset.chip ?? "")?.sessionReference;
      return existing?.sessionId === reference.sessionId && sameSessionSource(existing.source, reference.source)
        && (!matchExcerpts || JSON.stringify(existing.messages) === JSON.stringify(reference.messages));
    });

  const pasteSessionId = (editor: HTMLDivElement, text: string): boolean => {
    if (!lookupSessions) return false;
    const sessionId = text.trim();
    const copied = lookupSessions.copiedIdentity(sessionId);
    if (!copied && !isSessionIdCandidate(sessionId)) return false;
    const epoch = attachmentEpoch.current;
    const pasted = document.createTextNode(text);
    dictationEditorRef.current?.beforeEdit();
    insertNodesAtCaret(editor, [pasted]);
    emit();
    refreshMention();
    const replace = (reference: SessionReference) => {
      if (epoch !== attachmentEpoch.current || !editor.contains(pasted) || pasted.data !== text) return;
      const existing = existingSessionChip(editor, reference);
      if (existing) pasted.remove();
      else {
        const selection = window.getSelection();
        const caretWasInPaste = selection?.isCollapsed && (
          selection.anchorNode === pasted || selection.anchorNode?.childNodes[selection.anchorOffset - 1] === pasted
        );
        const chip = createChipElement(sessionReferenceChip(reference, zh), document);
        const space = document.createTextNode(" ");
        pasted.replaceWith(chip, space);
        if (caretWasInPaste) placeCaretAfter(space);
      }
      emit();
      refreshMention();
    };
    if (copied) replace({ ...copied, messages: [] });
    else void lookupSessions.locate(sessionId).then(matches => {
      if (matches.length === 1) replace({ sessionId, source: matches[0], messages: [] });
      if (matches.length > 1) replace({ sessionId, matches, messages: [] });
    });
    return true;
  };

  /** Serialized references keep their capsules; everything else is plain text. */
  const insertSerializedText = (editor: HTMLDivElement, text: string): void => {
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (hasSerializedReference(normalized)) {
      const doc = displayDocFromSerializedText(normalized, undefined, zh);
      const seenReferences = new Map<string, HTMLElement>();
      for (const element of editor.querySelectorAll<HTMLElement>(".cm-chip")) {
        const prior = parseChipPayload(element.dataset.chip ?? "");
        if (prior?.reference?.key) seenReferences.set(prior.reference.key, element);
      }
      const nodes: Node[] = [];
      doc.nodes.forEach((node, index) => {
        if (node.type === "text") {
          const lines = node.value.split("\n");
          lines.forEach((line, at) => {
            if (line.length > 0) nodes.push(document.createTextNode(line));
            if (at < lines.length - 1) nodes.push(document.createElement("br"));
          });
          return;
        }
        const chip = node.chip;
        if (chip.sessionReference) {
          if (existingSessionChip(editor, chip.sessionReference)) return;
          nodes.push(createChipElement(chip, document));
          return;
        }
        if ((chip.kind === "github" || chip.kind === "git-commit" || chip.kind === "browser") && chip.reference) {
          const existing = seenReferences.get(chip.reference.key);
          if (existing) {
            const prior = parseChipPayload(existing.dataset.chip ?? "");
            const replacement = createChipElement({ ...chip, id: prior?.id ?? chip.id }, document);
            existing.replaceWith(replacement);
            seenReferences.set(chip.reference.key, replacement);
            return;
          }
          const created = createChipElement(chip, document);
          seenReferences.set(chip.reference.key, created);
          nodes.push(created);
          return;
        }
        if (chip.image) imagesRef.current.set(chip.id, chip.image);
        nodes.push(createChipElement(chip, document));
        const nextNode = doc.nodes[index + 1];
        if (chip.kind !== "mode" && !(nextNode?.type === "text" && /^\s/u.test(nextNode.value))) {
          nodes.push(document.createTextNode(" "));
        }
      });
      if (nodes.length > 0) insertNodesAtCaret(editor, nodes);
    } else insertPlainText(editor, normalized);
  };

  /* Rich paste keeps the source order: text runs as Markdown, images as capsules.
     Bytes stay in this editor's image map, never in the client reducer. */
  const insertRich = (editor: HTMLDivElement, rich: RichPaste, fills: ReadonlyArray<PromptImage | null>): void => {
    dictationEditorRef.current?.beforeEdit();
    for (const part of rich.parts) {
      if (part.kind === "text") { insertPlainText(editor, part.text); continue; }
      const image = part.image ?? (part.slot === undefined ? null : fills[part.slot] ?? null);
      if (image) insertChip({ kind: "image", label: defaultImageChipLabel(), image });
      else if (part.alt) insertPlainText(editor, `[${part.alt}]`);
    }
    emit();
    refreshMention();
  };
  const pasteRich = (editor: HTMLDivElement, rich: RichPaste, files: readonly File[]): void => {
    // Nothing to read from clipboard files: insert at the caret now, like a plain paste.
    if (rich.slots === 0) { insertRich(editor, rich, []); return; }
    const selection = window.getSelection();
    const pasteRange = selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange() : null;
    void enqueueAttachment(async current => {
      const fills: Array<PromptImage | null> = [];
      for (let slot = 0; slot < rich.slots; slot += 1) {
        const file = files[slot];
        fills.push(file ? await fileToPromptImage(file).catch(() => null) : null);
        if (!current()) return false;
      }
      const target = editorRef.current;
      if (target !== editor) return false;
      if (pasteRange && editor.contains(pasteRange.commonAncestorContainer)) {
        const liveSelection = window.getSelection();
        liveSelection?.removeAllRanges(); liveSelection?.addRange(pasteRange);
      }
      insertRich(target, rich, fills);
      return true;
    });
  };

  // Files on the clipboard (Explorer Ctrl+C, screenshot) become capsules. Rich
  // HTML (documents, web pages) becomes Markdown with ordered images; code-editor
  // copies and Ctrl+Shift+V stay plain text, so a pasted path stays a path.
  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    const plainOnly = plainPasteRef.current;
    plainPasteRef.current = false;
    const editor = editorRef.current;
    const text = data.getData("text/plain");
    if (plainOnly) {
      if (!editor || text.length === 0) return;
      dictationEditorRef.current?.beforeEdit();
      insertPlainText(editor, text);
      emit();
      refreshMention();
      return;
    }
    const html = data.getData("text/html");
    const files = Array.from(data.files);
    if (editor && !files.length && text) {
      if (text.includes(SESSION_REFERENCE_START)) {
        dictationEditorRef.current?.beforeEdit();
        insertSerializedText(editor, text);
        emit();
        refreshMention();
        return;
      }
      if (pasteSessionId(editor, text)) return;
    }
    const rich = editor && html ? richPasteFromHtml(html, text) : null;
    if (files.length > 0 && !(rich && richPasteHasText(rich) && files.every(isImageFile))) {
      void ingestFiles(files);
      return;
    }
    if (editor && rich) {
      pasteRich(editor, rich, files);
      return;
    }
    if (!editor || text.length === 0) return;
    if (resolveImagePaste && /\.(?:png|jpe?g|gif|webp|svg|svgz|bmp|tiff?|avif|heic|heif)["']?\s*$/iu.test(text)) {
      void enqueueAttachment(async current => {
        let images: readonly PromptImage[] | undefined;
        try { images = await resolveImagePaste(text); }
        catch (cause) { if (current()) { insertPlainText(editor, text); emit(); } throw cause; }
        if (!current()) return false;
        if (images?.length) for (const image of images) insertChip({ kind: "image", label: defaultImageChipLabel(), image });
        else { insertPlainText(editor, text); emit(); }
        return true;
      });
      return;
    }
    dictationEditorRef.current?.beforeEdit();
    insertSerializedText(editor, text);
    emit();
    refreshMention();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (!event.dataTransfer?.files || event.dataTransfer.files.length === 0) return;
    // A drop needs no prior focus, and the collapsed running composer hides the
    // image strip; focusing expands it so the attachment stays visible.
    editorRef.current?.focus();
    void ingestFiles(event.dataTransfer.files);
  };

  const copySessionSelection = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = event.currentTarget;
    const selection = editor.ownerDocument.getSelection();
    if (!event.clipboardData || !selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) || !sessionChipElements(editor).some(chip => range.intersectsNode(chip))) return;
    const copied = editor.ownerDocument.createElement("div");
    copied.append(range.cloneContents());
    const snapshot = snapshotFromDoc(readDoc(copied, imagesRef.current));
    event.preventDefault();
    event.clipboardData.setData("text/plain", snapshot.text);
    if (event.type !== "cut") return;
    dictationEditorRef.current?.beforeEdit();
    range.deleteContents();
    emit();
    refreshMention();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.key === "Enter" || event.key === " ") && (event.target as Node).nodeType === 1) {
      const capsule = (event.target as Element).closest<HTMLElement>(".cm-chip-github, .cm-chip-git-commit, .cm-chip-browser, .cm-chip-session");
      const payload = capsule && parseChipPayload(capsule.dataset.chip ?? "");
      if (payload?.reference) { event.preventDefault(); setGithubPreview(payload.reference); return; }
      if (payload?.sessionReference) {
        event.preventDefault();
        setSessionPreview({ chipId: payload.id, reference: payload.sessionReference });
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v") {
      plainPasteRef.current = true;
      window.setTimeout(() => { plainPasteRef.current = false; }, 0);
    }
    if (dictationKeyboardRef.current?.keydown(event.nativeEvent)) { event.preventDefault(); return; }
    if(composingRef.current||event.nativeEvent.isComposing||event.keyCode===229)return;
    if(legacyPrediction&&!mention&&!commandOpen&&(event.key==="Tab"||event.key==="Escape")){
      event.preventDefault();const accepted=legacyPrediction;predictionVersion.current++;setPrediction(null);
      if(event.key==="Tab"&&!event.shiftKey&&accepted.version===predictionVersion.current-1&&editorRef.current){insertPlainText(editorRef.current,accepted.suffix);emit();}
      return;
    }
    if(event.key.startsWith("Arrow")||event.key==="Home"||event.key==="End")invalidatePrediction();
    if (commandOpen && commandItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((index) => (index + 1) % commandItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((index) => (index - 1 + commandItems.length) % commandItems.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (slashDraft && slashDraft.name.length === 0 && !detachedCommand) {
          event.preventDefault();
          return;
        }
        const exact = slashDraft ? lookupSlashCommand(slashDraft.name, slashCatalog) : undefined;
        if (detachedCommand || exact === undefined) {
          const item = commandItems[commandIndex];
          if (item) {
            event.preventDefault();
            acceptCommand(item);
          }
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCommandMenu();
        if (slashDraft && slashDraft.name.length === 0) replaceSlashCommand("", "bare-slash");
        return;
      }
      if (event.key === "Tab" && commandItems[commandIndex]) {
        event.preventDefault();
        const item = commandItems[commandIndex];
        if (!item) return;
        if (detachedCommand) {
          acceptCommand(item);
          return;
        }
        replaceSlashCommand(item.allowArgs ? `/${item.name} ` : `/${item.name}`, "prefix");
        closeCommandMenu();
        return;
      }
    }
    if (mention && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const item = candidates[activeIndex];
        if (item) {
          event.preventDefault();
          acceptMention(item);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if(!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.nativeEvent.isComposing&&predictionState.key(event.key)){event.preventDefault();return;}
    if (event.key === "Escape") {
      if (commandOpen) {
        event.preventDefault();
        closeCommandMenu();
        if (slashDraft && slashDraft.name.length === 0) replaceSlashCommand("", "bare-slash");
        return;
      }
      if (mention) {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (onEscape === undefined) return;
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (submitDisabled) return;
    event.preventDefault();
    if (isPrimaryModifier(event)) {
      onFollowUp?.();
      return;
    }
    const editor = editorRef.current;
    const slash = editor === null ? undefined : composerSlashExecute(snapshotOf(editor, imagesRef.current), slashCatalog);
    if (slash !== undefined) {
      onSubmit?.();
      return;
    }
    if (running) onQueue?.();
    else onSubmit?.();
  };

  const annotating = annotatingId === null ? null : (thumbs.find((thumb) => thumb.id === annotatingId) ?? null);

  return (
    <div ref={rootRef} className={`chip-composer${compact ? " is-compact" : ""}`} style={{position:"relative"}}>
      {thumbs.length > 0 ? (
        <div className="cm-thumbs" aria-label={zh ? "已附加的图片" : "Attached images"}>
          {thumbs.map((thumb) => (
            <figure key={thumb.id} className="cm-thumb">
              <button
                type="button"
                className="cm-thumb-open"
                aria-label={zh ? `预览${thumb.label}` : `Preview ${thumb.label}`}
                onClick={() => setPreview(thumb)}
              >
                <img src={thumb.url} alt="" />
              </button>
              <div
                className="cm-thumb-actions"
                role="group"
                aria-label={t("composer.imageAnnotate.thumbActionsAria", { label: thumb.label })}
              >
                <button
                  type="button"
                  className="cm-thumb-annotate"
                  aria-label={t("composer.imageAnnotate.actionAria", { label: thumb.label })}
                  data-tip={t("composer.imageAnnotate.action")}
                  disabled={!!disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!disabled) setAnnotatingId(thumb.id);
                  }}
                >
                  <Icon name="pencil" extra="sm" />
                </button>
                <button
                  type="button"
                  className="cm-thumb-remove"
                  aria-label={zh ? `移除${thumb.label}` : `Remove ${thumb.label}`}
                  data-tip={zh ? "移除" : "Remove"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeChip(thumb.id);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </figure>
          ))}
        </div>
      ) : null}
      <div
        ref={editorRef}
        id={id}
        className="chip-composer-editor"
        contentEditable={disabled ? false : true}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-placeholder={placeholder}
        aria-describedby={describedBy}
        data-placeholder={placeholder}
        data-empty={empty ? "true" : "false"}
        data-prediction-visible={predictionState.ghost ? "true" : undefined}
        onInput={onInput}
        onPaste={onPaste}
        onCopy={copySessionSelection}
        onCut={copySessionSelection}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        onMouseUp={() => { invalidatePrediction(); dictationEditorRef.current?.rememberSelection(); }}
        // The capsule × is a control, not a spot in the text: swallowing the
        // mousedown keeps the caret and the focus where the user left them.
        onMouseDown={(event) => {
          if (chipRemoveTarget(event.target) !== null) event.preventDefault();
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const capsule = target.closest<HTMLElement>(".cm-chip-github, .cm-chip-git-commit, .cm-chip-browser, .cm-chip-session");
          const payload = capsule ? parseChipPayload(capsule.dataset.chip ?? "") : null;
          if (payload?.reference && !target.closest(".cm-chip-x")) setGithubPreview(payload.reference);
          const chipId = chipRemoveTarget(event.target);
          if (payload?.sessionReference && chipId === null) setSessionPreview({ chipId: payload.id, reference: payload.sessionReference });
          if (chipId === null) return;
          event.preventDefault();
          removeChip(chipId);
        }}
        onFocus={(event) => {
          onFocus?.(event);
        }}
        onBlur={(event) => {
          dictationEditorRef.current?.rememberSelection();
          dictationKeyboardRef.current?.editorBlur();
          invalidatePrediction();
          setMention(null);
          const next = event.relatedTarget;
          if (next instanceof Node && (editorRef.current?.contains(next) || (next instanceof Element && next.closest(".cm-mention") !== null))) {
            onBlur?.(event);
            return;
          }
          closeCommandMenu();
          onBlur?.(event);
        }}
        onPointerDown={(event) => { onPointerDown?.(event); onCapsulePointerDown(event); }}
        onDragStart={(event) => { if ((event.target as Element).closest?.(".cm-chip")) event.preventDefault(); }}
        onCompositionStart={() => {
          dictationKeyboardRef.current?.compositionStart();
          composingRef.current = true;
          invalidatePrediction();
        }}
        onCompositionEnd={() => {
          dictationKeyboardRef.current?.compositionEnd();
          composingRef.current = false;
          invalidatePrediction();
          refreshMention();
        }}
      />
      {predictionState.ghost?<span className="cm-prediction" aria-hidden="true" style={{left:predictionState.ghost.left,top:predictionState.ghost.top,maxWidth:predictionState.ghost.width}}>{predictionState.ghost.suffix}<kbd>Tab</kbd></span>:null}
      {predictionState.menuChoices ? <div className="cm-prediction-options" role="listbox" aria-label="Message suggestions">{predictionState.menuChoices.map((text, index) => <button type="button" role="option" aria-selected={index === predictionState.choiceIndex} key={text} onMouseDown={event => event.preventDefault()} onClick={() => predictionState.choose(index)}>{text}</button>)}</div> : null}
      {predictionState.error?<span className="cm-prediction-error" role="status">{predictionState.error}</span>:null}
      {legacyPrediction?<span aria-hidden="true" data-prediction="true" style={{position:"absolute",left:legacyPrediction.left,top:legacyPrediction.top,opacity:0.45,pointerEvents:"none",whiteSpace:"pre"}}>{legacyPrediction.suffix}</span>:null}
      {commandOpen ? (
        <CommandMenu
          query={detachedCommand ? "" : (slashDraft?.name ?? "")}
          items={commandItems}
          activeIndex={commandIndex}
          onSelect={acceptCommand}
          onHover={setCommandIndex}
        />
      ) : mention ? (
        <MentionMenu
          trigger={mention.trigger}
          query={mention.query}
          items={candidates}
          activeIndex={activeIndex}
          onSelect={acceptMention}
          onHover={setActiveIndex}
        />
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept={fileAccept}
        hidden
        multiple
        onChange={(event) => {
          if (event.target.files) void ingestFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {preview !== null ? (
        <ImagePreview
          image={preview}
          onClose={() => setPreview(null)}
          {...(onError === undefined ? {} : { onError })}
        />
      ) : null}
      {annotating !== null ? (
        <ImageAnnotatorModal
          image={annotating}
          onClose={() => setAnnotatingId(null)}
          onConfirm={(nextImage) => {
            replaceChipImage(annotating.id, nextImage);
            setAnnotatingId(null);
          }}
          {...(onError === undefined ? {} : { onError })}
        />
      ) : null}
    {githubPreview ? <GitHubReferencePreview reference={githubPreview} onSaveBrowser={reference => { insertChip({ kind: "browser", label: reference.title, reference }); }} onClose={() => setGithubPreview(undefined)} /> : null}
    {sessionPreview ? <SessionReferenceDialog reference={sessionPreview.reference} initialSources={sessionPreview.reference.matches}
      onClose={() => setSessionPreview(undefined)}
      onSave={reference => {
        const editor = editorRef.current;
        const element = editor && sessionChipElements(editor).find(chip => parseChipPayload(chip.dataset.chip ?? "")?.id === sessionPreview.chipId);
        if (!editor || !element) return;
        element.dataset.chip = chipPayload({ ...sessionReferenceChip(reference, zh), id: sessionPreview.chipId });
        refreshSessionChips(editor);
        syncChipTruncation(editor);
        emit();
      }} /> : null}
    </div>
  );
});
