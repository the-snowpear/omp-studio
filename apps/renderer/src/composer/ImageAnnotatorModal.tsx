import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { SHORTCUTS, formatShortcut, isPrimaryModifier } from "../keyboard/shortcuts";
import type { ImageMimeType, PromptImage } from "./types";
import {
  ANNOTATION_COLORS,
  ANNOTATION_SIZES,
  annotationMetrics,
  clampAnnotationCoord,
  compositeImageAnnotations,
  createArrowOp,
  createRectOp,
  renderAnnotations,
  type AnnotationOp,
  type AnnotationPoint,
  type AnnotationSizePreset,
  type AnnotationTool,
} from "./imageAnnotation";
import "./imageAnnotator.css";

export type ImageAnnotatorSubject = {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly mimeType: ImageMimeType;
};

export type ImageAnnotatorModalProps = {
  image: ImageAnnotatorSubject;
  onConfirm: (nextImage: PromptImage) => boolean | void;
  disabled?: boolean;
  onClose: () => void;
  onError?: (message: string) => void;
};

type Size = { readonly width: number; readonly height: number };
type TextDraft = { readonly x: number; readonly y: number; readonly value: string };

type ActiveDrag =
  | { readonly kind: "pen"; readonly pointerId: number; readonly color: string; readonly strokeWidth: number; readonly points: AnnotationPoint[] }
  | { readonly kind: "rect" | "arrow"; readonly pointerId: number; readonly color: string; readonly strokeWidth: number; readonly start: AnnotationPoint; readonly end: AnnotationPoint };

function ArrowToolIcon() {
  return (
    <svg className="icon sm" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 12.5 12.5 3.5M7 3.5h5.5V9" />
    </svg>
  );
}

function draftToOp(drag: ActiveDrag | null): AnnotationOp | null {
  if (drag === null) return null;
  if (drag.kind === "pen") {
    return { kind: "pen", color: drag.color, strokeWidth: drag.strokeWidth, points: drag.points };
  }
  if (drag.kind === "rect") {
    return createRectOp(drag.color, drag.strokeWidth, drag.start, drag.end);
  }
  return createArrowOp(drag.color, drag.strokeWidth, drag.start, drag.end);
}

export function ImageAnnotatorModal({ image, onConfirm, onClose, onError, disabled = false }: ImageAnnotatorModalProps) {
  const { t } = useI18n();
  const document = useSurfaceDocument();
  const window = surfaceWindow(document);
  const titleId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const mountedRef = useRef(true);
  const confirmRef = useRef({ disabled, onConfirm });
  confirmRef.current = { disabled, onConfirm };

  const [tool, setTool] = useState<AnnotationTool>("pen");
  const [sizePreset, setSizePreset] = useState<AnnotationSizePreset>("medium");
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]!.value);
  const [ops, setOps] = useState<AnnotationOp[]>([]);
  const [draftOp, setDraftOp] = useState<AnnotationOp | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        closeRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (opener instanceof window.HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [document, window]);

  useLayoutEffect(() => {
    dragRef.current = null;
    setDraftOp(null);
    setTextDraft(null);
    setOps([]);
    setLoadError(false);
    setError("");
    setBusy(false);
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight || 600 });
    } else {
      setNaturalSize(null);
    }
  }, [image.url]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setStageSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = window.ResizeObserver ? new window.ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [window]);

  const naturalWidth = naturalSize?.width ?? 0;
  const naturalHeight = naturalSize?.height ?? 0;
  const availWidth = Math.max(240, (stageSize.width > 0 ? stageSize.width : 800) - 32);
  const availHeight = Math.max(180, (stageSize.height > 0 ? stageSize.height : 520) - 32);
  const displayScale =
    naturalWidth > 0 && naturalHeight > 0
      ? Math.min(2, availWidth / naturalWidth, availHeight / naturalHeight)
      : 1;
  const displayWidth = naturalWidth > 0 ? Math.max(1, Math.round(naturalWidth * displayScale)) : 0;
  const displayHeight = naturalHeight > 0 ? Math.max(1, Math.round(naturalHeight * displayScale)) : 0;

  const metrics = annotationMetrics(sizePreset, naturalWidth || 1000, naturalHeight || 1000);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const source = imgRef.current;
    if (!canvas || !source || naturalWidth <= 0 || naturalHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const backingWidth = Math.max(1, Math.round(displayWidth * dpr));
    const backingHeight = Math.max(1, Math.round(displayHeight * dpr));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, backingWidth, backingHeight);
    ctx.setTransform(backingWidth / naturalWidth, 0, 0, backingHeight / naturalHeight, 0, 0);
    ctx.drawImage(source, 0, 0, naturalWidth, naturalHeight);
    renderAnnotations(ctx, ops);
    if (draftOp !== null) renderAnnotations(ctx, [draftOp]);
  }, [displayWidth, displayHeight, naturalWidth, naturalHeight, ops, draftOp, window]);

  useEffect(() => {
    if (textDraft !== null) {
      textInputRef.current?.focus();
    }
  }, [textDraft?.x, textDraft?.y]);

  const commitTextDraft = useCallback(() => {
    setTextDraft((current) => {
      if (current === null) return null;
      const trimmed = current.value.trim();
      if (trimmed.length > 0) {
        setOps((prev) => [
          ...prev,
          { kind: "text", color, fontSize: metrics.fontSize, x: current.x, y: current.y, text: trimmed },
        ]);
      }
      return null;
    });
  }, [color, metrics.fontSize]);

  const handleUndo = useCallback(() => {
    if (busy) return;
    setOps((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
  }, [busy]);

  const handleReset = useCallback(() => {
    if (busy) return;
    dragRef.current = null;
    setDraftOp(null);
    setTextDraft(null);
    setOps([]);
    setError("");
  }, [busy]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (textDraft !== null) {
          setTextDraft(null);
          canvasRef.current?.focus({ preventScroll: true });
          return;
        }
        if (dragRef.current !== null) {
          dragRef.current = null;
          setDraftOp(null);
          return;
        }
        if (!busy) onClose();
        return;
      }
      if (
        isPrimaryModifier(event) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z"
      ) {
        if (textDraft !== null && document.activeElement === textInputRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        handleUndo();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const focusables = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']",
          ) ?? [],
        );
        if (focusables.length === 0) return;
        const index = focusables.indexOf(document.activeElement as HTMLElement);
        const nextIndex = (index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        focusables[nextIndex]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, document, handleUndo, onClose, textDraft, window]);

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>): AnnotationPoint => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : Math.max(1, displayWidth);
    const height = rect.height > 0 ? rect.height : Math.max(1, displayHeight);
    return {
      x: clampAnnotationCoord(((event.clientX - rect.left) / width) * naturalWidth, 0, naturalWidth),
      y: clampAnnotationCoord(((event.clientY - rect.top) / height) * naturalHeight, 0, naturalHeight),
    };
  };

  const selectTool = (nextTool: AnnotationTool) => {
    if (textDraft !== null && nextTool !== "text") {
      commitTextDraft();
    }
    setTool(nextTool);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy || loadError || naturalSize === null || event.button !== 0) return;
    event.stopPropagation();
    const point = canvasPoint(event);
    if (tool === "text") {
      if (textDraft !== null) {
        commitTextDraft();
        return;
      }
      const x = clampAnnotationCoord(point.x, 0, Math.max(0, naturalWidth - metrics.fontSize * 2));
      const y = clampAnnotationCoord(point.y, 0, Math.max(0, naturalHeight - metrics.fontSize * 1.4));
      setTextDraft({ x, y, value: "" });
      return;
    }
    if (textDraft !== null) commitTextDraft();
    const pointerId = event.pointerId ?? 0;
    event.currentTarget.setPointerCapture?.(pointerId);
    const drag: ActiveDrag =
      tool === "pen"
        ? { kind: "pen", pointerId, color, strokeWidth: metrics.strokeWidth, points: [point] }
        : { kind: tool, pointerId, color, strokeWidth: metrics.strokeWidth, start: point, end: point };
    dragRef.current = drag;
    setDraftOp(draftToOp(drag));
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== (event.pointerId ?? 0)) return;
    event.stopPropagation();
    const point = canvasPoint(event);
    if (current.kind === "pen") {
      const prev = current.points[current.points.length - 1];
      if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) < 0.5) return;
      current.points.push(point);
      setDraftOp({ kind: "pen", color: current.color, strokeWidth: current.strokeWidth, points: [...current.points] });
      return;
    }
    const next: ActiveDrag = { ...current, end: point };
    dragRef.current = next;
    setDraftOp(draftToOp(next));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== (event.pointerId ?? 0)) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(current.pointerId)) {
      event.currentTarget.releasePointerCapture?.(current.pointerId);
    }
    dragRef.current = null;
    const committed = draftToOp(current);
    setDraftOp(null);
    if (committed !== null) {
      setOps((prev) => [...prev, committed]);
    }
  };

  const handleConfirm = async () => {
    if (busy || disabled || loadError || naturalSize === null || !imgRef.current) return;
    const pendingText = textDraft !== null ? textDraft.value.trim() : "";
    const finalOps: AnnotationOp[] =
      pendingText.length > 0 && textDraft !== null
        ? [...ops, { kind: "text", color, fontSize: metrics.fontSize, x: textDraft.x, y: textDraft.y, text: pendingText }]
        : ops;
    if (finalOps.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const nextImage = await compositeImageAnnotations({
        source: imgRef.current,
        naturalWidth,
        naturalHeight,
        mimeType: image.mimeType,
        ops: finalOps,
        document,
      });
      if (!mountedRef.current) return;
      if (confirmRef.current.disabled || confirmRef.current.onConfirm(nextImage) === false) {
        setBusy(false);
        return;
      }
    } catch {
      if (!mountedRef.current) return;
      const message = t("composer.imageAnnotate.exportFailed");
      setError(message);
      onError?.(message);
      setBusy(false);
    }
  };

  const onTextKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      commitTextDraft();
    }
  };

  const ready = naturalSize !== null && !loadError;
  const hasAnnotations = ops.length > 0 || textDraft !== null;
  const undoShortcut = formatShortcut(SHORTCUTS.undo, "hint");

  return createPortal(
    <div
      className="img-annotator-backdrop"
      role="presentation"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="img-annotator-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
      >
        <header className="img-annotator-header">
          <Icon name="pencil" />
          <h2 id={titleId} className="img-annotator-title">
            {t("composer.imageAnnotate.title", { label: image.label })}
          </h2>
          {ready ? (
            <span className="img-annotator-dims">{naturalWidth} × {naturalHeight}</span>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label={t("composer.imageAnnotate.close")}
            data-tip={t("composer.imageAnnotate.close")}
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>

        <div className="img-annotator-toolbar">
          <div className="img-annotator-group" role="group" aria-label={t("composer.imageAnnotate.toolsAria")}>
            <button
              type="button"
              className="btn img-annotator-tool"
              aria-pressed={tool === "pen"}
              aria-label={t("composer.imageAnnotate.toolPen")}
              data-tip={t("composer.imageAnnotate.toolPen")}
              disabled={busy || !ready}
              onClick={() => selectTool("pen")}
            >
              <Icon name="pencil" extra="sm" />
              <span>{t("composer.imageAnnotate.toolPen")}</span>
            </button>
            <button
              type="button"
              className="btn img-annotator-tool"
              aria-pressed={tool === "rect"}
              aria-label={t("composer.imageAnnotate.toolRect")}
              data-tip={t("composer.imageAnnotate.toolRect")}
              disabled={busy || !ready}
              onClick={() => selectTool("rect")}
            >
              <Icon name="box" extra="sm" />
              <span>{t("composer.imageAnnotate.toolRect")}</span>
            </button>
            <button
              type="button"
              className="btn img-annotator-tool"
              aria-pressed={tool === "arrow"}
              aria-label={t("composer.imageAnnotate.toolArrow")}
              data-tip={t("composer.imageAnnotate.toolArrow")}
              disabled={busy || !ready}
              onClick={() => selectTool("arrow")}
            >
              <ArrowToolIcon />
              <span>{t("composer.imageAnnotate.toolArrow")}</span>
            </button>
            <button
              type="button"
              className="btn img-annotator-tool"
              aria-pressed={tool === "text"}
              aria-label={t("composer.imageAnnotate.toolText")}
              data-tip={t("composer.imageAnnotate.toolText")}
              disabled={busy || !ready}
              onClick={() => selectTool("text")}
            >
              <Icon name="type" extra="sm" />
              <span>{t("composer.imageAnnotate.toolText")}</span>
            </button>
          </div>

          <span className="img-annotator-sep" aria-hidden="true" />

          <div className="img-annotator-group" role="group" aria-label={t("composer.imageAnnotate.sizesAria")}>
            {ANNOTATION_SIZES.map((preset) => {
              const labelKey =
                preset === "small"
                  ? "composer.imageAnnotate.sizeSmall"
                  : preset === "medium"
                    ? "composer.imageAnnotate.sizeMedium"
                    : "composer.imageAnnotate.sizeLarge";
              const label = t(labelKey);
              return (
                <button
                  key={preset}
                  type="button"
                  className="img-annotator-size"
                  aria-pressed={sizePreset === preset}
                  aria-label={label}
                  data-tip={label}
                  disabled={busy || !ready}
                  onClick={() => setSizePreset(preset)}
                >
                  <span className="img-annotator-size-dot" data-size={preset} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          <span className="img-annotator-sep" aria-hidden="true" />

          <div className="img-annotator-colors" role="group" aria-label={t("composer.imageAnnotate.colorsAria")}>
            {ANNOTATION_COLORS.map((entry) => {
              const colorName = t(`composer.imageAnnotate.colorNames.${entry.id}`);
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="img-annotator-swatch"
                  style={{ backgroundColor: entry.value }}
                  aria-pressed={color.toLowerCase() === entry.value.toLowerCase()}
                  aria-label={colorName}
                  data-tip={colorName}
                  disabled={busy || !ready}
                  onClick={() => setColor(entry.value)}
                />
              );
            })}
            <label
              className={`img-annotator-color-picker${busy || !ready ? " is-disabled" : ""}`}
              data-tip={t("composer.imageAnnotate.customColor")}
            >
              <Icon name="palette" extra="sm" />
              <input
                type="color"
                value={color}
                aria-label={t("composer.imageAnnotate.customColor")}
                disabled={busy || !ready}
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
          </div>

          <div className="img-annotator-group img-annotator-history">
            <button
              type="button"
              className="btn outline"
              aria-label={t("composer.imageAnnotate.undo")}
              data-tip={t("composer.imageAnnotate.undoTip", { shortcut: undoShortcut })}
              disabled={busy || ops.length === 0}
              onClick={handleUndo}
            >
              <Icon name="undo" extra="sm" />
              <span>{t("composer.imageAnnotate.undo")}</span>
            </button>
            <button
              type="button"
              className="btn outline"
              aria-label={t("composer.imageAnnotate.reset")}
              data-tip={t("composer.imageAnnotate.resetTip")}
              disabled={busy || !hasAnnotations}
              onClick={handleReset}
            >
              <Icon name="refresh" extra="sm" />
              <span>{t("composer.imageAnnotate.reset")}</span>
            </button>
          </div>
        </div>

        <div ref={stageRef} className="img-annotator-stage">
          <img
            ref={imgRef}
            className="img-annotator-source"
            src={image.url}
            alt=""
            aria-hidden="true"
            onLoad={(event) => {
              const img = event.currentTarget;
              setNaturalSize({
                width: img.naturalWidth || 800,
                height: img.naturalHeight || 600,
              });
              setLoadError(false);
            }}
            onError={() => {
              setNaturalSize(null);
              setLoadError(true);
            }}
          />

          {loadError ? (
            <div className="img-annotator-state is-error" role="alert">
              <Icon name="alert-c" />
              <p>{t("composer.imageAnnotate.loadFailed")}</p>
            </div>
          ) : naturalSize === null ? (
            <div className="img-annotator-state" role="status">
              <span className="spinner" aria-hidden="true" />
              <p>{t("composer.imageAnnotate.loading")}</p>
            </div>
          ) : (
            <div
              className="img-annotator-canvas-wrap"
              style={{ width: displayWidth, height: displayHeight }}
            >
              <canvas
                ref={canvasRef}
                className="img-annotator-canvas"
                data-tool={tool}
                tabIndex={0}
                role="img"
                aria-label={t("composer.imageAnnotate.canvasAria")}
                style={{ width: displayWidth, height: displayHeight }}
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
              />
              {textDraft !== null ? (
                <div
                  className="img-annotator-text-box"
                  style={{
                    left: `${Math.min(80, Math.max(0, (textDraft.x / naturalWidth) * 100))}%`,
                    top: `${Math.min(80, Math.max(0, (textDraft.y / naturalHeight) * 100))}%`,
                  }}
                >
                  <textarea
                    ref={textInputRef}
                    className="img-annotator-text-input"
                    value={textDraft.value}
                    rows={2}
                    placeholder={t("composer.imageAnnotate.textPlaceholder")}
                    aria-label={t("composer.imageAnnotate.textInputAria")}
                    style={{
                      color,
                      fontSize: `${Math.max(12, Math.round(metrics.fontSize * (displayWidth / naturalWidth)))}px`,
                    }}
                    onChange={(event) => {
                      const next = event.target.value;
                      setTextDraft((current) => (current === null ? null : { ...current, value: next }));
                    }}
                    onKeyDown={onTextKeyDown}
                  />
                  <span className="img-annotator-text-hint">{t("composer.imageAnnotate.textHint")}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <footer className="img-annotator-footer">
          {disabled ? <p id={hintId} role="status" className="img-annotator-status">{t("composer.imageAnnotate.saveUnavailable")}</p> : error ? (
            <p id={hintId} role="alert" className="img-annotator-status is-error">
              {error}
            </p>
          ) : (
            <p id={hintId} className="img-annotator-status">
              {!hasAnnotations && ready
                ? t("composer.imageAnnotate.emptyNotice")
                : t("composer.imageAnnotate.hint", { undoShortcut })}
            </p>
          )}
          <div className="img-annotator-actions">
            <button type="button" className="btn outline" disabled={busy} onClick={onClose}>
              {t("composer.imageAnnotate.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || disabled || !ready}
              onClick={() => void handleConfirm()}
            >
              <Icon name="check" extra="sm" />
              <span>{busy ? t("composer.imageAnnotate.confirming") : t("composer.imageAnnotate.confirm")}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
