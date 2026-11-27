import { bytesToBase64 } from "./ingest";
import type { ImageMimeType, PromptImage } from "./types";

export type AnnotationTool = "pen" | "rect" | "arrow" | "text";
export type AnnotationSizePreset = "small" | "medium" | "large";

export type AnnotationColorId = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "white" | "black";

export const ANNOTATION_COLORS: ReadonlyArray<{ readonly id: AnnotationColorId; readonly value: string }> = [
  { id: "red", value: "#ef4444" },
  { id: "orange", value: "#f97316" },
  { id: "yellow", value: "#eab308" },
  { id: "green", value: "#22c55e" },
  { id: "blue", value: "#3b82f6" },
  { id: "purple", value: "#a855f7" },
  { id: "white", value: "#ffffff" },
  { id: "black", value: "#111827" },
];

export const ANNOTATION_SIZES: ReadonlyArray<AnnotationSizePreset> = ["small", "medium", "large"];

export type AnnotationPoint = { readonly x: number; readonly y: number };

export type PenAnnotation = {
  readonly kind: "pen";
  readonly color: string;
  readonly strokeWidth: number;
  readonly points: ReadonlyArray<AnnotationPoint>;
};

export type RectAnnotation = {
  readonly kind: "rect";
  readonly color: string;
  readonly strokeWidth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ArrowAnnotation = {
  readonly kind: "arrow";
  readonly color: string;
  readonly strokeWidth: number;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
};

export type TextAnnotation = {
  readonly kind: "text";
  readonly color: string;
  readonly fontSize: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
};

export type AnnotationOp = PenAnnotation | RectAnnotation | ArrowAnnotation | TextAnnotation;

const SIZE_FACTORS: Record<AnnotationSizePreset, { readonly stroke: number; readonly font: number }> = {
  small: { stroke: 2.5, font: 16 },
  medium: { stroke: 5, font: 24 },
  large: { stroke: 9, font: 36 },
};

const TEXT_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export function clampAnnotationCoord(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Scale stroke and font sizes proportionally to the natural image dimensions. */
export function annotationMetrics(
  preset: AnnotationSizePreset,
  imageWidth: number,
  imageHeight: number,
): { readonly strokeWidth: number; readonly fontSize: number } {
  const longest = Math.max(imageWidth, imageHeight, 1);
  const scale = clampAnnotationCoord(longest / 1000, 0.75, 4);
  const factor = SIZE_FACTORS[preset];
  return {
    strokeWidth: Number((factor.stroke * scale).toFixed(2)),
    fontSize: Math.round(factor.font * scale),
  };
}

export function createRectOp(
  color: string,
  strokeWidth: number,
  start: AnnotationPoint,
  end: AnnotationPoint,
): RectAnnotation | null {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < 2 && height < 2) return null;
  return { kind: "rect", color, strokeWidth, x, y, width, height };
}

export function createArrowOp(
  color: string,
  strokeWidth: number,
  start: AnnotationPoint,
  end: AnnotationPoint,
): ArrowAnnotation | null {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 2) return null;
  return {
    kind: "arrow",
    color,
    strokeWidth,
    startX: start.x,
    startY: start.y,
    endX: end.x,
    endY: end.y,
  };
}

function isDarkColor(hex: string): boolean {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match?.[1]) return false;
  const num = Number.parseInt(match[1], 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

function drawPen(ctx: CanvasRenderingContext2D, op: PenAnnotation): void {
  const { points, color, strokeWidth } = op;
  if (points.length === 0) return;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    const point = points[0]!;
    ctx.beginPath();
    ctx.arc(point.x, point.y, strokeWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i]!;
    const next = points[i + 1]!;
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  const last = points[points.length - 1]!;
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawRect(ctx: CanvasRenderingContext2D, op: RectAnnotation): void {
  ctx.strokeStyle = op.color;
  ctx.lineWidth = op.strokeWidth;
  ctx.lineJoin = "round";
  ctx.strokeRect(op.x, op.y, op.width, op.height);
}

function drawArrow(ctx: CanvasRenderingContext2D, op: ArrowAnnotation): void {
  const dx = op.endX - op.startX;
  const dy = op.endY - op.startY;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return;
  const angle = Math.atan2(dy, dx);
  const headLength = Math.min(length * 0.45, Math.max(12, op.strokeWidth * 3.8));
  const headAngle = Math.PI / 6.5;
  const shaftEndX = op.endX - Math.cos(angle) * headLength * 0.72;
  const shaftEndY = op.endY - Math.sin(angle) * headLength * 0.72;

  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.strokeWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(op.startX, op.startY);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(op.endX, op.endY);
  ctx.lineTo(
    op.endX - headLength * Math.cos(angle - headAngle),
    op.endY - headLength * Math.sin(angle - headAngle),
  );
  ctx.lineTo(
    op.endX - headLength * Math.cos(angle + headAngle),
    op.endY - headLength * Math.sin(angle + headAngle),
  );
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx: CanvasRenderingContext2D, op: TextAnnotation): void {
  const lines = op.text.replaceAll("\r\n", "\n").split("\n");
  const lineHeight = op.fontSize * 1.25;
  ctx.font = `600 ${op.fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = op.color;
  ctx.strokeStyle = isDarkColor(op.color) ? "rgba(255, 255, 255, 0.88)" : "rgba(0, 0, 0, 0.68)";
  ctx.lineWidth = Math.max(2, op.fontSize * 0.14);
  ctx.lineJoin = "round";
  lines.forEach((line, index) => {
    if (line.length === 0) return;
    const y = op.y + index * lineHeight;
    ctx.strokeText(line, op.x, y);
    ctx.fillText(line, op.x, y);
  });
}

export function renderAnnotations(ctx: CanvasRenderingContext2D, ops: ReadonlyArray<AnnotationOp>): void {
  for (const op of ops) {
    ctx.save();
    switch (op.kind) {
      case "pen":
        drawPen(ctx, op);
        break;
      case "rect":
        drawRect(ctx, op);
        break;
      case "arrow":
        drawArrow(ctx, op);
        break;
      case "text":
        drawText(ctx, op);
        break;
    }
    ctx.restore();
  }
}

export function outputMimeTypeForAnnotation(sourceMime: ImageMimeType): "image/png" | "image/jpeg" {
  return sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("Unable to read encoded image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read encoded image."));
    reader.readAsArrayBuffer(blob);
  });
}

async function encodeCanvasToBase64(
  canvas: HTMLCanvasElement,
  mimeType: "image/png" | "image/jpeg",
): Promise<string> {
  const quality = mimeType === "image/jpeg" ? 0.92 : undefined;
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((next) => resolve(next), mimeType, quality);
    });
    if (blob !== null) {
      return bytesToBase64(await readBlobBytes(blob));
    }
  }
  if (typeof canvas.toDataURL === "function") {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const comma = dataUrl.indexOf(",");
    if (comma !== -1) return dataUrl.slice(comma + 1);
  }
  throw new Error("Unable to encode annotated image.");
}

export async function compositeImageAnnotations(input: {
  readonly source: CanvasImageSource;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly mimeType: ImageMimeType;
  readonly ops: ReadonlyArray<AnnotationOp>;
  readonly document?: Document;
}): Promise<PromptImage> {
  const ownerDocument = input.document ?? globalThis.document;
  const canvas = ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.round(input.naturalWidth));
  canvas.height = Math.max(1, Math.round(input.naturalHeight));
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    ctx.drawImage(input.source, 0, 0, canvas.width, canvas.height);
    renderAnnotations(ctx, input.ops);
    const outMime = outputMimeTypeForAnnotation(input.mimeType);
    const data = await encodeCanvasToBase64(canvas, outMime);
    return { type: "image", mimeType: outMime, data };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
