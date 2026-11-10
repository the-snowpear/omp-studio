import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AskImage } from "@omp-studio/studio-protocol";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { fileToPromptImage } from "../composer/ingest";
import { snapshotFromDoc } from "../composer/serialize";
import { newChipId, type ComposerDoc, type ComposerNode, type ComposerSnapshot, type PromptImage } from "../composer/types";
import { Icon } from "../icons";
import "./askImages.css";

export async function askImage(file:File):Promise<AskImage>{
 if(!["image/png","image/jpeg","image/gif","image/webp"].includes(file.type)||file.size>20*1024*1024)throw Error("Choose PNG, JPEG, GIF or WebP under 20 MB / 请选择 20 MB 以内的图片");
 if(file.size<=96*1024)return (await fileToPromptImage(file)) as AskImage;
 const bitmap=await createImageBitmap(file);try{const canvas=document.createElement("canvas");for(const edge of [1280,800,480]){const scale=Math.min(1,edge/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const context=canvas.getContext("2d")!;context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/jpeg",0.7));if(blob&&blob.size<=96*1024)return (await fileToPromptImage(new File([blob],"attachment.jpg",{type:"image/jpeg"}))) as AskImage;}throw Error("Image exceeds response budget / 图片超出回答容量");}finally{bitmap.close();}
}

export type AskEditorValue = Omit<ComposerSnapshot, "images"> & { readonly images: readonly AskImage[] };
const NO_COMMANDS = [] as const;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function sameImages(left: readonly PromptImage[], right: readonly PromptImage[]): boolean {
  return left.length === right.length && left.every((image, index) => image.mimeType === right[index]?.mimeType && image.data === right[index]?.data);
}

/** Keep the native Ask image budget, but reuse the main editor's inline document and preview. */
export function AskImages({
  text, images, doc, onChange, disabled, label, ariaLabel, describedBy, placeholder,
  onBusy, editorRef, onSubmit, heading, hint, multiline = false, allowImages = true,
}: {
  text: string;
  images: readonly AskImage[];
  doc?: ComposerDoc | undefined;
  onChange: (value: AskEditorValue) => void;
  disabled?: boolean | undefined;
  label: string;
  ariaLabel: string;
  describedBy?: string;
  placeholder: string;
  onBusy?: (busy: boolean) => void;
  editorRef?: RefObject<ChipComposerHandle | null>;
  onSubmit?: () => void;
  heading: ReactNode;
  hint?: ReactNode;
  multiline?: boolean;
  allowImages?: boolean;
}) {
  const ownEditor = useRef<ChipComposerHandle>(null);
  const composer = editorRef ?? ownEditor;
  const field = useRef<HTMLDivElement>(null);
  const caret = useRef<Range | null>(null);
  const epoch = useRef(0);
  const processing = useRef(false);
  const syncing = useRef(false);
  const focusAfterUpload = useRef(false);
  const last = useRef<{ text: string; images: readonly PromptImage[]; doc: ComposerDoc | undefined } | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;

  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy, onBusy]);
  useLayoutEffect(() => {
    const previous = last.current;
    if (previous && (doc ? doc === previous.doc : text === previous.text && sameImages(images, previous.images))) return;
    const nodes: ComposerNode[] = text ? [{ type: "text", value: text }] : [];
    if (!doc) for (const image of images) nodes.push({ type: "chip", chip: { id: newChipId(), kind: "image", label: "图", image } });
    epoch.current++;
    processing.current = false;
    setBusy(false);
    syncing.current = true;
    try {
      composer.current?.setSnapshot(snapshotFromDoc(doc ?? { nodes }), { preserveFocus: true });
      last.current = { text, images, doc };
    } finally { syncing.current = false; }
  }, [text, images, doc, composer]);
  useLayoutEffect(() => {
    if (!busy && focusAfterUpload.current) {
      focusAfterUpload.current = false;
      composer.current?.focus();
    }
  });

  const rememberCaret = () => {
    const editor = field.current?.querySelector(".chip-composer-editor");
    const selection = editor?.ownerDocument.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) caret.current = range.cloneRange();
  };
  const changed = (snapshot: ComposerSnapshot) => {
    if (syncing.current) return;
    last.current = snapshot;
    // Every binary attachment enters through askImage below, which only emits native Ask formats.
    onChange({ ...snapshot, images: snapshot.images as readonly AskImage[] });
  };
  const add = async (files: readonly File[]) => {
    if (disabled || processing.current || !files.length) return;
    if (!allowImages) { setError("当前问题不接受图片附件"); return; }
    const generation = epoch.current;
    const range = caret.current?.cloneRange();
    processing.current = true;
    setBusy(true);
    try {
      if ((composer.current?.getSnapshot().images.length ?? 0) + files.length > 4) throw Error("每个回答区最多 4 张图片");
      const added: AskImage[] = [];
      for (const file of files) added.push(await askImage(file));
      if (epoch.current !== generation) return;
      const editor = field.current?.querySelector(".chip-composer-editor");
      if (editor && range && editor.contains(range.commonAncestorContainer)) {
        const selection = editor.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      for (const image of added) composer.current?.insertChip({ kind: "image", label: "图", image });
      setError("");
      focusAfterUpload.current = true;
    } catch (cause) {
      if (epoch.current === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === generation) { processing.current = false; setBusy(false); }
    }
  };

  return (
    <div className={`ask-field${multiline ? " ask-field--note" : ""}`}>
      <div className="ask-field-head">{heading}{hint}</div>
      <div
        ref={field}
        className={`ask-input-box${allowImages ? " has-image-control" : ""}`}
        role="group" aria-label={label} aria-disabled={!!locked} aria-busy={busy}
        data-disabled={locked || undefined}
        onPasteCapture={event => {
          const data = event.clipboardData;
          const files = Array.from(data.files ?? []);
          if (!files.length) for (const item of Array.from(data.items ?? [])) {
            if (item.kind !== "file") continue;
            const file = item.getAsFile();
            if (file) files.push(file);
          }
          if (!files.length) return;
          event.preventDefault(); event.stopPropagation();
          rememberCaret(); void add(files);
        }}
        onDropCapture={event => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault(); event.stopPropagation();
          rememberCaret(); void add(Array.from(event.dataTransfer.files));
        }}
        onChangeCapture={event => {
          const input = event.target as HTMLInputElement;
          if (input.tagName !== "INPUT" || input.type !== "file") return;
          event.stopPropagation();
          const files = Array.from(input.files ?? []);
          input.value = "";
          void add(files);
        }}
        onClickCapture={event => {
          if (locked && (event.target as Element).closest?.(".cm-chip-x, .cm-thumb-remove")) {
            event.preventDefault(); event.stopPropagation();
          }
        }}
        onKeyDownCapture={event => {
          // Notes keep ordinary Enter/newline behavior; answer Enter still submits.
          if (multiline && event.key === "Enter" && (event.target as Element).closest?.(".chip-composer-editor")) event.stopPropagation();
        }}
      >
        <ChipComposer
          ref={composer} ariaLabel={ariaLabel} placeholder={placeholder}
          disabled={!!locked} fileAccept={IMAGE_ACCEPT} slashCatalog={NO_COMMANDS}
          {...(describedBy ? { describedBy } : {})}
          {...(onSubmit ? { onSubmit, onFollowUp: onSubmit } : {})}
          onChange={changed} onBlur={rememberCaret} onError={setError}
        />
        {allowImages ? <div className="ask-field-tools">
          <button type="button" className="ask-image-add" aria-label={`${label} + 图片 / Image`} aria-busy={busy}
            data-tip={busy ? "正在处理图片…" : `${label} · 添加图片，也可直接粘贴，最多 4 张`}
            disabled={!!locked} onMouseDown={event => { event.preventDefault(); rememberCaret(); }}
            onClick={() => { rememberCaret(); composer.current?.openFilePicker(); }}><Icon name="image" /></button>
        </div> : null}
      </div>
      {error ? <p className="ask-image-error" role="alert">{error}</p> : null}
    </div>
  );
}
