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
  findMentionToken,
  insertNodesAtCaret,
  insertPlainText,
  mentionAtCaret,
  placeCaretAtEnd,
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
import { ImagePreview, type ImagePreviewSubject } from "./ImagePreview";
import { MentionMenu } from "./MentionMenu";
import {
  filterSlashCommands,
  lookupSlashCommand,
  parseSlashDraft,
  slashNeedsArgs,
  type StudioSlashCommand,
} from "./commands";

export type ChipComposerHandle = {
  focus(): void;
  clear(): void;
  getSnapshot(): ComposerSnapshot;
  setSnapshot(snapshot: ComposerSnapshot): void;
  insertChip(chip: Omit<ComposerChip, "id"> & { id?: string }): void;
  removeSkillChip(name: string): void;
  openFilePicker(): void;
  openMention(trigger: "@"): void;
  openCommandMenu(): void;
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
  onRunCommand?: (command: StudioSlashCommand, args: string) => void;
  onChange?: (snapshot: ComposerSnapshot) => void;
  onSubmit?: () => void;
  onQueue?: () => void;
  /** Ctrl+Enter / Cmd+Enter: Runtime follow-up (text + images). */
  onFollowUp?: () => void;
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
    onRunCommand,
    onChange,
    onSubmit,
    onQueue,
    onFollowUp,
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
  const [thumbs, setThumbs] = useState<Array<ImagePreviewSubject & { id: string }>>([]);
  const [preview, setPreview] = useState<(ImagePreviewSubject & { id: string }) | null>(null);
  const [mention, setMention] = useState<{ trigger: "@"; query: string } | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [draftText, setDraftText] = useState("");
  const [detachedCommand, setDetachedCommand] = useState(false);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);

  const closeCommandMenu = (): void => {
    setDetachedCommand(false);
    setCommandDismissed(true);
  };

  const emit = (): ComposerSnapshot => {
    const editor = editorRef.current;
    if (!editor) return emptySnapshot();
    renumberImageChips(editor);
    syncChipTruncation(editor);
    requestAnimationFrame(() => {
      if (editorRef.current === editor) syncChipTruncation(editor);
    });
    const snapshot = snapshotOf(editor, imagesRef.current);
    setDraftText(snapshot.text);
    if (snapshot.text.startsWith("/")) {
      setDetachedCommand(false);
      setCommandDismissed(false);
    }
    setEmpty(snapshotIsEmpty(snapshot));
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
    if (draft.kind === "mode") {
      const name = draft.name ?? draft.label.replace(/^\//u, "");
      removeConflictingModeChips(editor, name);
      const chip: ComposerChip = {
        ...draft,
        id: draft.id ?? newChipId(),
        name,
        label: draft.label.replace(/^\//u, "") || name,
      };
      editor.insertBefore(createChipElement(chip), editor.firstChild);
      placeCaretAtEnd(editor);
      emit();
      return;
    }
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
        // Disk-backed images travel as @path. Preview bytes are optional: a
        // read failure must not drop the capsule.
        if (image) {
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
            kind: "image",
            label: "图",
            path: meta.path,
          });
          continue;
        }
        skipped += 1;
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
        ? "有些文件读不到，未添加为胶囊：可能已被移动或是快捷方式。"
        : "当前环境无法解析磁盘路径，只有图片可以附件。");
    }
  };

  useEffect(() => {
    setPreview((current) => {
      if (current === null) return null;
      const live = thumbs.find((thumb) => thumb.id === current.id);
      return live ?? null;
    });
  }, [thumbs]);

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
    removeSkillChip(name) {
      const editor = editorRef.current;
      if (!editor || !removeSkillChipsByName(editor, name)) return;
      emit();
    },
    openFilePicker() {
      fileRef.current?.click();
    },
    openMention(trigger: "@") {
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
      const current = snapshotOf(editor, imagesRef.current).text;
      if (current.length === 0) {
        insertNodesAtCaret(editor, [document.createTextNode("/")]);
        emit();
        setDetachedCommand(false);
        return;
      }
      if (current.startsWith("/")) {
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
    if (!mention || mention.trigger !== "@" || loadMentions === undefined) {
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
    const at = mentionAtCaret(editor) ?? (mention ? findMentionToken(editor, mention.query) : null);
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

  const insertModeChip = (name: string): void => {
    insertChip({ kind: "mode", label: name, name });
  };

  const writeCommandText = (text: string): void => {
    const editor = editorRef.current;
    if (!editor) return;
    imagesRef.current.clear();
    writeDoc(editor, { nodes: [{ type: "text", value: text }] }, imagesRef.current);
    emit();
    placeCaretAtEnd(editor);
  };

  const slashDraft = parseSlashDraft(draftText);
  const commandItems = detachedCommand
    ? filterSlashCommands("")
    : slashDraft
      ? filterSlashCommands(slashDraft.name)
      : [];
  const commandOpen = (detachedCommand || slashDraft !== null) && mention === null && !commandDismissed;

  useEffect(() => {
    setCommandIndex(0);
  }, [slashDraft?.name, detachedCommand]);

  useEffect(() => {
    if (!commandOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (editorRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".cm-mention") !== null) return;
      closeCommandMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [commandOpen]);

  const acceptCommand = (item: StudioSlashCommand): void => {
    const args = slashDraft !== null && (slashDraft.name === item.name || item.aliases.includes(slashDraft.name))
      ? slashDraft.args
      : "";
    if (item.availability === "disabled") return;
    const overlay = detachedCommand;
    if (item.select === "chip") {
      setDetachedCommand(false);
      if (!overlay) writeCommandText(args);
      insertModeChip(item.name);
      return;
    }
    if (slashNeedsArgs(item, args) || (item.select === "complete-args" && args.length === 0)) {
      setDetachedCommand(false);
      writeCommandText(`/${item.name} `);
      setCommandIndex(0);
      return;
    }
    onRunCommand?.(item, args);
    setDetachedCommand(false);
    if (!overlay) writeCommandText("");
  };

  const refreshMention = (): void => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const at = mentionAtCaret(editor);
    setMention(at ? { trigger: "@", query: at.query } : null);
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
        const exact = slashDraft ? lookupSlashCommand(slashDraft.name) : undefined;
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
        if (slashDraft && slashDraft.name.length === 0) writeCommandText("");
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
        writeCommandText(item.allowArgs ? `/${item.name} ` : `/${item.name}`);
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
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      onFollowUp?.();
      return;
    }
    if (running) onQueue?.();
    else onSubmit?.();
  };

  return (
    <div className={`chip-composer${compact ? " is-compact" : ""}`}>
      {thumbs.length > 0 ? (
        <div className="cm-thumbs" aria-label="已附加的图片">
          {thumbs.map((thumb) => (
            <figure key={thumb.id} className="cm-thumb">
              <button
                type="button"
                className="cm-thumb-open"
                aria-label={`预览${thumb.label}`}
                onClick={() => setPreview(thumb)}
              >
                <img src={thumb.url} alt="" />
              </button>
              <button
                type="button"
                className="cm-thumb-remove"
                aria-label={`移除${thumb.label}`}
                title={`移除${thumb.label}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  removeChip(thumb.id);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
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
        onFocus={(event) => {
          if (editorRef.current && snapshotOf(editorRef.current, imagesRef.current).text.startsWith("/")) {
            setCommandDismissed(false);
          }
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setMention(null);
          const next = event.relatedTarget;
          if (next instanceof Node && (editorRef.current?.contains(next) || (next instanceof Element && next.closest(".cm-mention") !== null))) {
            onBlur?.(event);
            return;
          }
          closeCommandMenu();
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
    </div>
  );
});
