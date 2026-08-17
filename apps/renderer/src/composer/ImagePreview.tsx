import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../icons";
import type { ImageMimeType } from "./types";

export type ImagePreviewSubject = {
  readonly url: string;
  readonly label: string;
  readonly mimeType: ImageMimeType;
  readonly data: string;
};

type Props = {
  image: ImagePreviewSubject;
  onClose: () => void;
  onError?: (message: string) => void;
};

type MenuPos = { readonly x: number; readonly y: number };

function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function blobToPngBytes(blob: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("无法处理这张图片。");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => {
      if (next) resolve(next);
      else reject(new Error("无法编码图片。"));
    }, "image/png");
  });
  return new Uint8Array(await png.arrayBuffer());
}

function bytesAsBlob(bytes: Uint8Array, mime: ImageMimeType): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type: mime });
}

async function bytesForClipboard(image: ImagePreviewSubject): Promise<{ mime: ImageMimeType; bytes: Uint8Array }> {
  const bytes = bytesFromBase64(image.data);
  if (image.mimeType === "image/png" || image.mimeType === "image/jpeg") {
    return { mime: image.mimeType, bytes };
  }
  return { mime: "image/png", bytes: await blobToPngBytes(bytesAsBlob(bytes, image.mimeType)) };
}

function clampMenu(x: number, y: number): MenuPos {
  const width = 168;
  const height = 88;
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

export function ImagePreview({ image, onClose, onError }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, [image.url]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (menu !== null) {
        setMenu(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, onClose]);

  const runCopy = async (): Promise<void> => {
    setMenu(null);
    const chrome = globalThis.ompStudioChrome;
    if (chrome?.copyImage === undefined) {
      onError?.("当前环境无法复制图片。");
      return;
    }
    setBusy(true);
    try {
      const payload = await bytesForClipboard(image);
      const result = await chrome.copyImage(payload);
      if (!result.ok) onError?.(result.message);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "复制图片失败。");
    } finally {
      setBusy(false);
    }
  };

  const runSave = async (): Promise<void> => {
    setMenu(null);
    const chrome = globalThis.ompStudioChrome;
    if (chrome?.saveImage === undefined) {
      onError?.("当前环境无法保存图片。");
      return;
    }
    setBusy(true);
    try {
      const result = await chrome.saveImage({
        mime: image.mimeType,
        bytes: bytesFromBase64(image.data),
        suggestedName: image.label,
      });
      if (result.ok) return;
      if ("cancelled" in result && result.cancelled) return;
      if ("message" in result) onError?.(result.message);
    } catch {
      onError?.("保存图片失败。");
    } finally {
      setBusy(false);
    }
  };

  const onImageContextMenu = (event: MouseEvent<HTMLImageElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(clampMenu(event.clientX, event.clientY));
  };

  return createPortal(
    <div
      className="img-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (menu !== null) {
          setMenu(null);
          return;
        }
        onClose();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="img-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览${image.label}`}>
        <button
          ref={closeRef}
          type="button"
          className="icon-btn img-preview-close"
          aria-label="关闭预览"
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
        <img
          className="img-preview-image"
          src={image.url}
          alt={image.label}
          draggable={false}
          onMouseDown={() => setMenu(null)}
          onContextMenu={onImageContextMenu}
        />
      </div>
      {menu !== null ? (
        <div
          className="menu img-preview-menu"
          role="menu"
          aria-label="图片操作"
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" className="menu-item" role="menuitem" disabled={busy} onClick={() => void runCopy()}>
            <Icon name="copy" extra="sm" />
            复制
          </button>
          <button type="button" className="menu-item" role="menuitem" disabled={busy} onClick={() => void runSave()}>
            <Icon name="save" extra="sm" />
            保存
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
