import {
  forwardRef,
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

import type { ComposerChip, ComposerSnapshot, MentionCandidate, PromptImage } from "./types";
import { emptySnapshot, newChipId } from "./types";
import { snapshotFromDoc, snapshotIsEmpty } from "./serialize";
import { fileToPromptImage, imagePreviewUrl, isImageFile } from "./ingest";
import {
  chipRemoveTarget,
  createChipElement,
  editorIsEmpty,
  insertNodesAtCaret,
  insertPlainText,
  mentionAtCaret,
  placeCaretAtEnd,
  readDoc,
  removeChipById,
  renumberImageChips,
  syncChipTruncation,
  replaceMention,
  writeDoc,
} from "./editorDom";
import { MentionMenu } from "./MentionMenu";

export type ChipComposerHandle = {
  focus(): void;
  clear(): void;
  getSnapshot(): ComposerSnapshot;
  setSnapshot(snapshot: ComposerSnapshot): void;
  insertChip(chip: Omit<ComposerChip, "id"> & { id?: string }): void;
  openFilePicker(): void;
  openMention(trigger: "@" | "/"): void;
  isEmpty(): boolean;
};

type Props = {
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  workspaceId?: string;
  describedBy?: string;
  loadMentions?: (trigger: "@" | "/", query: string) => Promise<readonly MentionCandidate[]>;
  onChange?: (snapshot: ComposerSnapshot) => void;
  onSubmit?: () => void;
  onQueue?: () => void;
  running?: boolean;
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onError?: (message: string) => void;
};

function snapshotOf(editor: HTMLElement, images: Map<string, PromptImage>): ComposerSnapshot {
  return snapshotFromDoc(readDoc(editor, images));
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
    placeholder,
    disabled,
    compact,
    workspaceId,
    describedBy,
    loadMentions,
    onChange,
    onSubmit,
    onQueue,
    running,
    onFocus,
    onBlur,
    onPointerDown,
    onError,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imagesRef = useRef(new Map<string, PromptImage>());
  const composingRef = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [thumbs, setThumbs] = useState<Array<{ id: string; url: string; label: string }>>([]);
  const [mention, setMention] = useState<{ trigger: "@" | "/"; query: string } | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const emit = (): ComposerSnapshot => {
    const editor = editorRef.current;
    if (!editor) return emptySnapshot();
    renumberImageChips(editor);
    syncChipTruncation(editor);
    requestAnimationFrame(() => {
      if (editorRef.current === editor) syncChipTruncation(editor);
    });
    const snapshot = snapshotOf(editor, imagesRef.current);
    setEmpty(snapshotIsEmpty(snapshot));
    const nextThumbs = snapshot.doc.nodes.flatMap((node) => {
      if (node.type !== "chip" || node.chip.kind !== "image" || node.chip.image === undefined) return [];
      return [{ id: node.chip.id, url: imagePreviewUrl(node.chip.image), label: node.chip.label }];
    });
    setThumbs(nextThumbs);
    // Drop bytes for capsules the user deleted; base64 payloads are large.
    const live = new Set(nextThumbs.map((thumb) => thumb.id));
    for (const id of [...imagesRef.current.keys()]) {
      if (!live.has(id)) imagesRef.current.delete(id);
    }
    onChange?.(snapshot);
    return snapshot;
  };

  const insertChip = (draft: Omit<ComposerChip, "id"> & { id?: string }): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const chip: ComposerChip = { ...draft, id: draft.id ?? newChipId() };
    if (chip.image) imagesRef.current.set(chip.id, chip.image);
    insertNodesAtCaret(editor, [createChipElement(chip), document.createTextNode(" ")]);
    emit();
  };

  const removeChip = (chipId: string): void => {
    const editor = editorRef.current;
    if (!editor || !removeChipById(editor, chipId)) return;
    emit();
  };

  const ingestFiles = async (fileList: FileList | File[]): Promise<void> => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const resolved = workspaceId ? await resolveOsPaths(workspaceId, files) : new Map();
    let skipped = 0;
    for (const file of files) {
      const meta = resolved.get(file);
      // Main resolved the real kind by stat, so a folder named `foo.png` never
      // reaches the image branch; extension sniffing is only the fallback.
      if (meta ? meta.kind === "image" : isImageFile(file)) {
        const image = await fileToPromptImage(file).catch(() => null);
        if (!image) {
          skipped += 1;
          continue;
        }
        // `emit()` renumbers 图N in document order, so no counter is needed here.
        insertChip({
          kind: "image",
          label: "图",
          ...(meta ? { path: meta.path } : {}),
          image,
        });
        continue;
      }
      if (meta) {
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
      onError?.(workspaceId
        ? "有些文件读不到，未添加为胶囊：可能已被移动、是快捷方式，或图片超过 8MB。"
        : "当前环境无法解析磁盘路径，只有图片可以附件。");
    }
  };

  useImperativeHandle(ref, () => ({
    focus() {
      editorRef.current?.focus();
    },
    clear() {
      const editor = editorRef.current;
      if (!editor) return;
      imagesRef.current.clear();
      editor.replaceChildren();
      emit();
    },
    getSnapshot() {
      const editor = editorRef.current;
      if (!editor) return emptySnapshot();
      return snapshotOf(editor, imagesRef.current);
    },
    setSnapshot(snapshot) {
      const editor = editorRef.current;
      if (!editor) return;
      imagesRef.current.clear();
      writeDoc(editor, snapshot.doc, imagesRef.current);
      emit();
      placeCaretAtEnd(editor);
    },
    insertChip,
    openFilePicker() {
      fileRef.current?.click();
    },
    openMention(trigger: "@" | "/") {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      insertNodesAtCaret(editor, [document.createTextNode(trigger)]);
      emit();
      setMention({ trigger, query: "" });
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
    const at = mentionAtCaret(editor);
    const chip: ComposerChip = {
      id: newChipId(),
      kind: item.kind,
      label: item.label,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.name === undefined ? {} : { name: item.name }),
    };
    const el = createChipElement(chip);
    if (at) replaceMention(at, el);
    else insertNodesAtCaret(editor, [el, document.createTextNode(" ")]);
    setMention(null);
    emit();
  };

  const refreshMention = (): void => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const at = mentionAtCaret(editor);
    setMention(at ? { trigger: at.trigger, query: at.query } : null);
  };

  const onInput = (_event: FormEvent<HTMLDivElement>): void => {
    emit();
    refreshMention();
  };

  // Files on the clipboard (Explorer Ctrl+C, screenshot) become capsules; anything
  // else pastes as plain text, so a pasted path stays a path.
  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    if (data.files.length > 0) {
      void ingestFiles(data.files);
      return;
    }
    const editor = editorRef.current;
    const text = data.getData("text/plain");
    if (!editor || text.length === 0) return;
    insertPlainText(editor, text);
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
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
      if (event.key === "Enter" && !event.shiftKey) {
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
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (running) onQueue?.();
    else onSubmit?.();
  };

  return (
    <div className={`chip-composer${compact ? " is-compact" : ""}`}>
      {thumbs.length > 0 ? (
        <div className="cm-thumbs" aria-label="已附加的图片">
          {thumbs.map((thumb) => (
            <figure key={thumb.id} className="cm-thumb">
              <img src={thumb.url} alt={thumb.label} />
              <button
                type="button"
                className="cm-thumb-remove"
                aria-label={`移除${thumb.label}`}
                title={`移除${thumb.label}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeChip(thumb.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
              <figcaption>{thumb.label}</figcaption>
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
        aria-multiline="true"
        aria-placeholder={placeholder}
        aria-describedby={describedBy}
        data-placeholder={placeholder}
        data-empty={empty ? "true" : "false"}
        onInput={onInput}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        // The capsule × is a control, not a spot in the text: swallowing the
        // mousedown keeps the caret and the focus where the user left them.
        onMouseDown={(event) => {
          if (chipRemoveTarget(event.target) !== null) event.preventDefault();
        }}
        onClick={(event) => {
          const chipId = chipRemoveTarget(event.target);
          if (chipId === null) return;
          event.preventDefault();
          removeChip(chipId);
        }}
        onFocus={onFocus}
        onBlur={(event) => {
          setMention(null);
          onBlur?.(event);
        }}
        onPointerDown={onPointerDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          refreshMention();
        }}
      />
      {mention ? (
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
        hidden
        multiple
        onChange={(event) => {
          if (event.target.files) void ingestFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
});
