import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { Icon } from "../icons";
import type { ImageMimeType } from "./types";

export type ImagePreviewSubject = {
  /** Display URL, including caller-owned blob URLs. The viewer never revokes it. */
  readonly url: string;
  readonly label: string;
  readonly mimeType: ImageMimeType;
  /** Legacy Composer base64, decoded only for an explicit copy/save. */
  readonly data?: string;
  readonly bytes?: Uint8Array;
  readonly loadBytes?: () => Promise<Uint8Array>;
};

export type ImagePreviewProps = {
  image: ImagePreviewSubject;
  onClose: () => void;
  onError?: (message: string) => void;
  /** Disable copy/save for caller-owned read-only or demonstration surfaces. */
  actionsEnabled?: boolean;
};

type Size = { width: number; height: number };
type MenuPos = { x: number; y: number };
type Zoom = "fit" | number;
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 8;

async function readBytes(image: ImagePreviewSubject, window: Window & typeof globalThis): Promise<Uint8Array> {
  if (image.bytes !== undefined) return image.bytes;
  if (image.loadBytes !== undefined) return image.loadBytes();
  if (image.data !== undefined) {
    const binary = window.atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  // URL-only subjects may be local Blob/artifact URLs. Do not fetch just to display.
  const response = await window.fetch(image.url);
  if (!response.ok) throw new Error("无法读取图片，请重新打开后重试。");
  return new Uint8Array(await response.arrayBuffer());
}

/** Keep the existing SVG-save and GIF/WebP-copy rasterization behavior. */
async function pngBytes(bytes: Uint8Array, mime: ImageMimeType, document: Document): Promise<Uint8Array> {
  const window = surfaceWindow(document);
  // Blob owns its snapshot; no base64 string is made for byte-backed images.
  const blob = new window.Blob([new Uint8Array(bytes).buffer], { type: mime });
  const url = window.URL.createObjectURL(blob);
  const img = document.createElement("img");
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("无法处理这张图片。"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 1024;
    canvas.height = img.naturalHeight || 1024;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理这张图片。");
    context.drawImage(img, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((next) => next ? resolve(next) : reject(new Error("无法编码图片。")), "image/png");
    });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
    window.URL.revokeObjectURL(url);
  }
}

export function ImagePreview({ image, onClose, onError, actionsEnabled = true }: ImagePreviewProps) {
  const document = useSurfaceDocument();
  const window = surfaceWindow(document);
  const chrome = window.ompStudioChrome;
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef(0);
  const bytesRef = useRef<Promise<Uint8Array> | null>(null);
  const busyRef = useRef(false);
  const pendingScrollRef = useRef<MenuPos | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [imageFailed, setImageFailed] = useState(false);

  // The opener and focus listeners belong to this surface, not the main window.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) closeRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (opener instanceof window.HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [document, window]);

  useLayoutEffect(() => {
    // Invalidate before paint, including replacements that reuse the display URL.
    epochRef.current += 1;
    bytesRef.current = null;
    busyRef.current = false;
    pendingScrollRef.current = null;
    dragRef.current = null;
    setBusy(null);
    setError("");
    setStatus("");
    setMenu(null);
    setZoom("fit");
    setDragging(false);
    setImageFailed(false);
    const img = imageRef.current;
    setSize(img?.complete && img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    closeRef.current?.focus({ preventScroll: true });
    return () => { epochRef.current += 1; bytesRef.current = null; };
  }, [document, image.url, image.label, image.mimeType, image.bytes, image.loadBytes, image.data, actionsEnabled]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = window.ResizeObserver ? new window.ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [window]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (menu !== null) {
          setMenu(null);
          viewportRef.current?.focus({ preventScroll: true });
        } else onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        if (menu !== null) {
          setMenu(null);
          viewportRef.current?.focus({ preventScroll: true });
          return;
        }
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']") ?? []);
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [document, window, menu, onClose]);

  useLayoutEffect(() => {
    if (!menu) return;
    const element = menuRef.current;
    if (!element) return;
    // Measure instead of assuming menu dimensions under font/density overrides.
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    (element.querySelector<HTMLElement>("button:not(:disabled)") ?? element).focus({ preventScroll: true });
  }, [menu, window]);

  const fitScale = size && viewport.width > 0 && viewport.height > 0
    ? Math.min(1, viewport.width / size.width, viewport.height / size.height) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const canPan = size !== null && (size.width * scale > viewport.width || size.height * scale > viewport.height);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    if (zoom === "fit") {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    } else if (pendingScrollRef.current) {
      element.scrollLeft = Math.max(0, pendingScrollRef.current.x);
      element.scrollTop = Math.max(0, pendingScrollRef.current.y);
    }
    pendingScrollRef.current = null;
  }, [scale, zoom]);

  const changeZoom = (next: Zoom) => {
    const element = viewportRef.current;
    if (!element || !size) return;
    const nextScale = next === "fit" ? fitScale : next;
    const x = element.scrollLeft + element.clientWidth / 2 - Math.max(0, (element.clientWidth - size.width * scale) / 2);
    const y = element.scrollTop + element.clientHeight / 2 - Math.max(0, (element.clientHeight - size.height * scale) / 2);
    pendingScrollRef.current = {
      x: x / scale * nextScale - element.clientWidth / 2,
      y: y / scale * nextScale - element.clientHeight / 2,
    };
    setZoom(next);
  };

  const getBytes = () => {
    if (!bytesRef.current) {
      const pending = readBytes(image, window);
      bytesRef.current = pending;
      void pending.catch(() => { if (bytesRef.current === pending) bytesRef.current = null; });
    }
    return bytesRef.current;
  };

  const runAction = async (action: "copy" | "save") => {
    setMenu(null);
    if (!actionsEnabled || busyRef.current) return;
    if (action === "copy" ? !chrome?.copyImage : !chrome?.saveImage) return;
    const epoch = epochRef.current;
    const current = () => epoch === epochRef.current;
    busyRef.current = true;
    setBusy(action);
    setError("");
    setStatus("");
    // Menu items disappear while their async action runs; never leave focus on body.
    closeRef.current?.focus({ preventScroll: true });
    try {
      let bytes = await getBytes();
      if (!current()) return;
      let mime = image.mimeType;
      if (mime === "image/svg+xml" || (action === "copy" && mime !== "image/png" && mime !== "image/jpeg")) {
        bytes = await pngBytes(bytes, mime, document);
        mime = "image/png";
      }
      if (!current()) return;
      const result = action === "copy"
        ? await chrome!.copyImage({ mime, bytes })
        : await chrome!.saveImage({ mime, bytes, suggestedName: image.label });
      if (!current()) return;
      if (result.ok) setStatus(action === "copy" ? "已复制图片" : "已保存图片");
      else if ("cancelled" in result && result.cancelled) setStatus("已取消保存");
      else if ("message" in result) {
        setError(result.message);
        onError?.(result.message);
      }
    } catch (cause) {
      if (!current()) return;
      const message = `${action === "copy" ? "复制" : "保存"}图片失败${(cause instanceof Error || cause instanceof window.Error) ? `：${cause.message}` : "，请重试。"}`;
      setError(message);
      onError?.(message);
    } finally {
      if (current()) { busyRef.current = false; setBusy(null); }
    }
  };

  const openMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const copyUnavailable = !chrome?.copyImage;
  const saveUnavailable = !chrome?.saveImage;

  return createPortal(
    <div
      className="img-preview-backdrop"
      role="presentation"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (menu !== null && !menuRef.current?.contains(event.target as Node)) {
          setMenu(null);
          viewportRef.current?.focus({ preventScroll: true });
          return;
        }
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div ref={dialogRef} className="img-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览${image.label}`} aria-describedby={hintId}>
        <header className="img-preview-header">
          <span className="img-preview-title" data-tip={image.label}>{image.label}</span>
          <div className="img-preview-actions" role="group" aria-label="图片操作">
            <button type="button" className="btn" disabled={!actionsEnabled || busy !== null || copyUnavailable} onClick={() => void runAction("copy")}>
              <Icon name="copy" extra="sm" />{busy === "copy" ? "复制中…" : "复制"}
            </button>
            <button type="button" className="btn" disabled={!actionsEnabled || busy !== null || saveUnavailable} onClick={() => void runAction("save")}>
              <Icon name="save" extra="sm" />{busy === "save" ? "保存中…" : "另存为"}
            </button>
            <button ref={closeRef} type="button" className="btn img-preview-close" aria-label="关闭预览" onClick={onClose}>
              <Icon name="x" extra="sm" />关闭
            </button>
          </div>
        </header>
        <div className="img-preview-zoom" role="group" aria-label="图片缩放">
          <button type="button" className="btn" disabled={!size} aria-pressed={zoom === "fit"} onClick={() => changeZoom("fit")}>适应窗口</button>
          <button type="button" className="btn" disabled={!size} aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>100%</button>
          <button type="button" className="btn" disabled={!size || scale <= MIN_ZOOM} onClick={() => changeZoom(Math.max(MIN_ZOOM, scale / 1.25))}>缩小</button>
          <output className="img-preview-scale" aria-label="缩放比例">{size ? `${Number((scale * 100).toFixed(1))}%` : "—"}</output>
          <button type="button" className="btn" disabled={!size || scale >= MAX_ZOOM} onClick={() => changeZoom(Math.min(MAX_ZOOM, scale * 1.25))}>放大</button>
        </div>
        <div
          ref={viewportRef}
          className={`img-preview-viewport${canPan ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}`}
          role="region"
          aria-label="图片查看区域"
          tabIndex={0}
          onContextMenu={openMenu}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left + 16, y: rect.top + 16 });
          }}
          onPointerDown={(event) => {
            // Only pan the local scrollbox. Touch keeps native scroll/pinch gestures.
            if (event.button !== 0 || event.pointerType === "touch" || !canPan || event.target === event.currentTarget) return;
            const element = event.currentTarget;
            event.preventDefault();
            element.focus({ preventScroll: true });
            element.setPointerCapture?.(event.pointerId);
            dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.id !== event.pointerId) return;
            event.currentTarget.scrollLeft = drag.left + drag.x - event.clientX;
            event.currentTarget.scrollTop = drag.top + drag.y - event.clientY;
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          <div className="img-preview-canvas">
            <img
              key={image.url}
              ref={imageRef}
              className="img-preview-image"
              src={image.url}
              alt={image.label}
              draggable={false}
              style={{ width: size ? size.width * scale : undefined, height: size ? size.height * scale : undefined }}
              onLoad={(event) => {
                setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                setImageFailed(false);
              }}
              onError={() => { setSize(null); setImageFailed(true); }}
            />
          </div>
        </div>
        <footer className="img-preview-footer">
          <p id={hintId}>100% 表示收到的图片原始尺寸{size ? `（${size.width} × ${size.height}）` : ""}，不代表显示器分辨率。滚动或拖动画面可平移。</p>
          {actionsEnabled && (copyUnavailable || saveUnavailable) ? <p>{copyUnavailable && saveUnavailable ? "当前环境不支持复制和另存为图片，请在桌面应用中使用。" : copyUnavailable ? "当前环境不支持复制图片。" : "当前环境不支持另存为图片。"}</p> : null}
          {imageFailed ? <p role="alert" className="img-preview-error">无法显示这张图片，请关闭后重新打开。</p> : null}
          {error ? <p role="alert" className="img-preview-error">{error}</p> : null}
          <p role="status">{busy ? (busy === "copy" ? "正在复制图片…" : "正在保存图片…") : status || (!size && !imageFailed ? "正在载入图片…" : "")}</p>
        </footer>
        {menu !== null ? (
          <div
            ref={menuRef}
            className="menu img-preview-menu"
            role="menu"
            aria-label="图片操作"
            tabIndex={-1}
            style={{ top: menu.y, left: menu.x }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            <button type="button" className="menu-item" role="menuitem" disabled={!actionsEnabled || busy !== null || copyUnavailable} onClick={() => void runAction("copy")}>
              <Icon name="copy" extra="sm" />复制
            </button>
            <button type="button" className="menu-item" role="menuitem" disabled={!actionsEnabled || busy !== null || saveUnavailable} onClick={() => void runAction("save")}>
              <Icon name="save" extra="sm" />保存
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
