import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ImagePreview, type ImagePreviewSubject } from "../composer/ImagePreview";
import { chipIconName, imagePreviewUrl } from "../composer/ingest";
import { chipCopyToken, displayDocForUserMessage, docHasDisplayChips } from "../composer/serialize";
import type { ComposerChip, ComposerDoc } from "../composer/types";
import { splitChipLabel } from "../composer/types";
import { Icon } from "../icons";
import { renderMagicKeywordText } from "../MagicKeywordText";
import { syncChipTruncation } from "../composer/editorDom";
import { MarkdownText } from "./markdown";
import { attachUserThumbs, type UserMessageThumb } from "./userMessageThumbs";

function ChipLabel({ label }: { label: string }) {
  const { stem, ext } = splitChipLabel(label);
  const inner = (
    <>
      <span className="cm-chip-stem">{stem}</span>
      {ext === "" ? null : <span className="cm-chip-ext">{ext}</span>}
    </>
  );
  return (
    <span className="cm-chip-label">
      <span className="cm-chip-sizer" aria-hidden="true">{inner}</span>
      <span className="cm-chip-clip">
        <span className="cm-chip-scroll">{inner}</span>
      </span>
    </span>
  );
}

function UserCapsule({
  chip,
  onOpenImage,
}: {
  chip: ComposerChip;
  onOpenImage?: (subject: ImagePreviewSubject) => void;
}) {
  const copy = chipCopyToken(chip);
  const clickable = chip.kind === "image" && chip.image !== undefined && onOpenImage !== undefined;
  return (
    <span
      className={`cm-chip cm-chip-${chip.kind} is-static`}
      title={chip.path ?? chip.name ?? chip.label}
      data-copy={copy}
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => {
              if (chip.image === undefined) return;
              onOpenImage({
                url: imagePreviewUrl(chip.image),
                label: chip.label,
                mimeType: chip.image.mimeType,
                data: chip.image.data,
              });
            },
            onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (chip.image === undefined) return;
              onOpenImage({
                url: imagePreviewUrl(chip.image),
                label: chip.label,
                mimeType: chip.image.mimeType,
                data: chip.image.data,
              });
            },
          }
        : {})}
    >
      {chip.kind === "mode" ? null : <Icon name={chipIconName(chip.kind)} extra="sm" />}
      <ChipLabel label={chip.label} />
    </span>
  );
}

function sliceTextNode(node: Text, range: Range): string {
  const text = node.data;
  let start = 0;
  let end = text.length;
  if (node === range.startContainer) start = range.startOffset;
  if (node === range.endContainer) end = range.endOffset;
  return text.slice(start, end);
}

/** Rebuild serialized @ / /skill: / [图N] tokens from a selection that includes capsules. */
export function serializedCopyFromHost(host: HTMLElement, range: Range): string {
  let out = "";
  const walk = (node: Node): void => {
    if (!range.intersectsNode(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      out += sliceTextNode(node as Text, range);
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.classList.contains("cm-chip")) {
        out += node.dataset.copy ?? "";
        return;
      }
      if (node.tagName === "BR") {
        out += "\n";
        return;
      }
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(host);
  return out;
}

function imageSubjectsFromDoc(doc: ComposerDoc): ImagePreviewSubject[] {
  const subjects: ImagePreviewSubject[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "chip" || node.chip.kind !== "image" || node.chip.image === undefined) continue;
    subjects.push({
      url: imagePreviewUrl(node.chip.image),
      label: node.chip.label,
      mimeType: node.chip.image.mimeType,
      data: node.chip.image.data,
    });
  }
  return subjects;
}

function RichUserText({
  doc,
  magicKeywords,
  bodyRef,
  onOpenImage,
}: {
  doc: ComposerDoc;
  magicKeywords: boolean;
  bodyRef: (node: HTMLDivElement | null) => void;
  onOpenImage: (subject: ImagePreviewSubject) => void;
}) {
  const nodes: ReactNode[] = [];
  doc.nodes.forEach((node, index) => {
    if (node.type === "text") {
      nodes.push(
        <span key={`t-${index}`}>
          {magicKeywords ? renderMagicKeywordText(node.value, true) : node.value}
        </span>,
      );
      return;
    }
    nodes.push(
      <UserCapsule
        key={node.chip.id}
        chip={node.chip}
        {...(node.chip.kind === "image" && node.chip.image !== undefined ? { onOpenImage } : {})}
      />,
    );
  });
  return <div ref={bodyRef} className="ev-body ev-user-rich">{nodes}</div>;
}

export function UserMessageBody({
  text,
  doc,
  thumbs,
  magicKeywords,
  copyText,
  actions,
}: {
  text: string;
  doc?: ComposerDoc;
  thumbs?: readonly UserMessageThumb[];
  magicKeywords?: boolean;
  copyText?: string;
  actions?: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<ImagePreviewSubject | null>(null);
  const display = useMemo(
    () => attachUserThumbs(displayDocForUserMessage(text, doc), thumbs ?? []),
    [text, doc, thumbs],
  );
    const chips = docHasDisplayChips(display);
    const subjects = imageSubjectsFromDoc(display);
    const paintKeywords = magicKeywords === true;

  useLayoutEffect(() => {
    if (bodyRef.current === null) return;
    syncChipTruncation(bodyRef.current);
  }, [display]);

  const onCopy = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (event.clipboardData === null) return;
    const selection = window.getSelection();
    const host = bodyRef.current;
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed || host === null) return;
    if (!host.contains(selection.anchorNode) && !host.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(host)) return;
    if (host.querySelector(".cm-chip") === null) return;
    const serialized = serializedCopyFromHost(host, range);
    if (serialized.length === 0) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", serialized);
  };

  const body = chips ? (
    <RichUserText
      doc={display}
      magicKeywords={paintKeywords}
      bodyRef={(node) => {
        bodyRef.current = node;
      }}
      onOpenImage={setPreview}
    />
  ) : (
    <MarkdownText text={text} {...(paintKeywords ? { magicKeywords: true } : {})} />
  );

  const thumbsRow = subjects.length === 0 ? null : (
    <div className="ev-thumbs cm-thumbs" aria-label="已附加的图片">
      {subjects.map((thumb) => (
        <figure key={`${thumb.label}-${thumb.data.slice(0, 12)}`} className="cm-thumb">
          <button
            type="button"
            className="cm-thumb-open"
            aria-label={`预览${thumb.label}`}
            onClick={() => setPreview(thumb)}
          >
            <img src={thumb.url} alt="" />
          </button>
        </figure>
      ))}
    </div>
  );

  const previewLayer = preview === null ? null : (
    <ImagePreview image={preview} onClose={() => setPreview(null)} />
  );

  if (actions === undefined && (copyText === undefined || copyText.length === 0) && thumbsRow === null) {
    return (
      <>
        {body}
        {previewLayer}
      </>
    );
  }
  return (
    <div className="ev-copy-host" onCopy={onCopy}>
      {thumbsRow}
      {body}
      {actions}
      {previewLayer}
    </div>
  );
}
