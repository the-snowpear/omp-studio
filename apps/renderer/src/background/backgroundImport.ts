/**
 * 导入本地图片 / 动图 / 视频：校验 → 解码探测 → 缩略图 + 平均色/亮度 → 写库。
 *
 * 默认实现依赖 DOM（createImageBitmap / canvas / video）。测量函数可通过
 * `deps` 注入，测试不需要真实解码器；校验与去重是纯逻辑，单独覆盖。
 */

import { BACKGROUND_LIMITS } from "./backgroundSettings";
import {
  canAddUpload,
  type BackgroundAssetMeta,
  type BackgroundLibrary,
} from "./backgroundLibrary";

export type BackgroundImportErrorCode =
  | "unsupported-type"
  | "too-large"
  | "library-full"
  | "decode-failed"
  | "quota"
  | "storage-unavailable"
  | "read-failed";

export type BackgroundImportResult =
  | { readonly ok: true; readonly meta: BackgroundAssetMeta; readonly deduped: boolean }
  | { readonly ok: false; readonly code: BackgroundImportErrorCode };

export type BackgroundFileKind = "image" | "video";

export interface MeasuredBackground {
  /** 实际入库的字节（静态大图可能已被重编码）。 */
  readonly blob: Blob;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly luma: number;
  readonly avgColor: string;
  readonly thumbDataUrl?: string;
}

export interface BackgroundImportDeps {
  readonly measureImage?: (file: File) => Promise<MeasuredBackground>;
  readonly measureVideo?: (file: File) => Promise<MeasuredBackground>;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface BackgroundImportOptions {
  readonly library: BackgroundLibrary;
  readonly uploads: readonly BackgroundAssetMeta[];
  readonly deps?: BackgroundImportDeps;
}

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const VIDEO_MIME_TYPES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
]);

const IMAGE_EXTENSIONS = /\.(png|apng|jpe?g|webp|gif|avif)$/iu;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|ogv|ogg|mov)$/iu;

export function backgroundFileKind(file: File): BackgroundFileKind | undefined {
  if (IMAGE_MIME_TYPES.has(file.type)) return "image";
  if (VIDEO_MIME_TYPES.has(file.type)) return "video";
  if (file.type === "") {
    if (IMAGE_EXTENSIONS.test(file.name)) return "image";
    if (VIDEO_EXTENSIONS.test(file.name)) return "video";
  }
  return undefined;
}

export function backgroundFingerprint(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function validateBackgroundFile(file: File): { readonly ok: true; readonly kind: BackgroundFileKind } | { readonly ok: false; readonly code: BackgroundImportErrorCode } {
  const kind = backgroundFileKind(file);
  if (kind === undefined) return { ok: false, code: "unsupported-type" };
  if (file.size <= 0) return { ok: false, code: "decode-failed" };
  const limit = kind === "image" ? BACKGROUND_LIMITS.imageBytes : BACKGROUND_LIMITS.videoBytes;
  if (file.size > limit) return { ok: false, code: "too-large" };
  return { ok: true, kind };
}

function isQuotaError(error: unknown): boolean {
  if (typeof DOMException === "function" && error instanceof DOMException) {
    return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
  }
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function defaultId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) return uuid;
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function canvasFor(width: number, height: number): HTMLCanvasElement | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob ?? undefined), type, quality);
    } catch {
      resolve(undefined);
    }
  });
}

function blobToDataUrl(blob: Blob): Promise<string | undefined> {
  if (typeof FileReader === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    } catch {
      resolve(undefined);
    }
  });
}

function analyzeCanvas(canvas: HTMLCanvasElement): { readonly luma: number; readonly avgColor: string } {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return { luma: 0.5, avgColor: "#808080" };
  let red = 0;
  let green = 0;
  let blue = 0;
  let luma = 0;
  let weight = 0;
  try {
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < data.length; index += 4) {
      const alpha = (data[index + 3] ?? 0) / 255;
      if (alpha <= 0) continue;
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      red += r * alpha;
      green += g * alpha;
      blue += b * alpha;
      const unit = (value: number): number => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      luma += (0.2126 * unit(r) + 0.7152 * unit(g) + 0.0722 * unit(b)) * alpha;
      weight += alpha;
    }
  } catch {
    return { luma: 0.5, avgColor: "#808080" };
  }
  if (weight <= 0) return { luma: 0.5, avgColor: "#808080" };
  const hex = (value: number): string => Math.max(0, Math.min(255, Math.round(value / weight))).toString(16).padStart(2, "0");
  return {
    luma: Math.max(0, Math.min(1, luma / weight)),
    avgColor: `#${hex(red)}${hex(green)}${hex(blue)}`,
  };
}

function drawToCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
): HTMLCanvasElement | undefined {
  if (sourceWidth <= 0 || sourceHeight <= 0) return undefined;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const canvas = canvasFor(sourceWidth * scale, sourceHeight * scale);
  if (canvas === undefined) return undefined;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
  return canvas;
}

async function thumbnailDataUrl(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): Promise<string | undefined> {
  const canvas = drawToCanvas(source, sourceWidth, sourceHeight, BACKGROUND_LIMITS.thumbEdge);
  if (canvas === undefined) return undefined;
  for (const type of ["image/webp", "image/jpeg"] as const) {
    const blob = await canvasToBlob(canvas, type, 0.72);
    if (blob === undefined) continue;
    if (type === "image/webp" && blob.type !== "image/webp") continue;
    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl !== undefined) return dataUrl;
  }
  try {
    return canvas.toDataURL("image/webp", 0.72);
  } catch {
    return undefined;
  }
}

function decodeFailure(): never {
  throw new Error("BACKGROUND_DECODE_FAILED");
}

async function measureImageWithDom(file: File): Promise<MeasuredBackground> {
  if (typeof createImageBitmap !== "function") decodeFailure();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    decodeFailure();
  }
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) decodeFailure();

    let blob: Blob = file;
    const encoderSafe = file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/avif";
    if (encoderSafe && Math.max(width, height) > BACKGROUND_LIMITS.maxImageEdge) {
      const scaled = drawToCanvas(bitmap, width, height, BACKGROUND_LIMITS.maxImageEdge);
      if (scaled !== undefined) {
        const encoded = await canvasToBlob(scaled, "image/webp", 0.9);
        if (encoded !== undefined && encoded.type === "image/webp" && encoded.size > 0 && encoded.size < file.size) {
          blob = encoded;
        }
      }
    }

    const analysis = drawToCanvas(bitmap, width, height, 48);
    const colors = analysis === undefined ? { luma: 0.5, avgColor: "#808080" } : analyzeCanvas(analysis);
    const thumbDataUrl = await thumbnailDataUrl(bitmap, width, height);

    return {
      blob,
      width,
      height,
      luma: colors.luma,
      avgColor: colors.avgColor,
      ...(thumbDataUrl === undefined ? {} : { thumbDataUrl }),
    };
  } finally {
    bitmap.close();
  }
}

function waitForMediaEvent(media: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      media.removeEventListener(event, onEvent);
      media.removeEventListener("error", onError);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("BACKGROUND_MEDIA_ERROR"));
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("BACKGROUND_MEDIA_TIMEOUT"));
    }, timeoutMs);
    media.addEventListener(event, onEvent, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

async function measureVideoWithDom(file: File): Promise<MeasuredBackground> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") decodeFailure();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    if (video.readyState < 1) await waitForMediaEvent(video, "loadedmetadata", 8_000);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) decodeFailure();
    const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined;

    let thumbDataUrl: string | undefined;
    let colors: { readonly luma: number; readonly avgColor: string } = { luma: 0.5, avgColor: "#808080" };
    try {
      video.currentTime = Math.min(1, Math.max(0.05, (video.duration || 2) / 3));
      await waitForMediaEvent(video, "seeked", 4_000);
      const frame = drawToCanvas(video, width, height, BACKGROUND_LIMITS.maxImageEdge);
      if (frame !== undefined) {
        const analysis = drawToCanvas(video, width, height, 48);
        if (analysis !== undefined) colors = analyzeCanvas(analysis);
        thumbDataUrl = await thumbnailDataUrl(video, width, height);
      }
    } catch {
      /* 抽帧失败不阻断导入：用占位缩略图，背景仍可播放。 */
    }

    return {
      blob: file,
      width,
      height,
      ...(durationMs === undefined ? {} : { durationMs }),
      luma: colors.luma,
      avgColor: colors.avgColor,
      ...(thumbDataUrl === undefined ? {} : { thumbDataUrl }),
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * 导入一个文件。去重按「文件名 + 大小 + 修改时间」；已存在时直接返回已有
 * 元数据，图库与配额都不重复占用。
 */
export async function importBackgroundFile(
  file: File,
  options: BackgroundImportOptions,
): Promise<BackgroundImportResult> {
  const validation = validateBackgroundFile(file);
  if (!validation.ok) return validation;

  const fingerprint = backgroundFingerprint(file);
  const existing = options.uploads.find((upload) => upload.fingerprint === fingerprint);
  if (existing !== undefined) return { ok: true, meta: existing, deduped: true };

  const capacity = canAddUpload(options.uploads, file.size);
  if (capacity !== "ok") return { ok: false, code: capacity };

  const deps = options.deps;
  let measured: MeasuredBackground;
  try {
    const measure = validation.kind === "image"
      ? deps?.measureImage ?? measureImageWithDom
      : deps?.measureVideo ?? measureVideoWithDom;
    measured = await measure(file);
  } catch {
    return { ok: false, code: "decode-failed" };
  }

  const now = deps?.now ?? Date.now;
  const id = deps?.randomId ?? defaultId;
  const meta: BackgroundAssetMeta = {
    id: id(),
    kind: validation.kind,
    name: (file.name.trim() || "background").slice(0, 120),
    mime: measured.blob.type || file.type || (validation.kind === "video" ? "video/mp4" : "image/png"),
    bytes: measured.blob.size,
    createdAt: now(),
    luma: Math.max(0, Math.min(1, measured.luma)),
    avgColor: /^#[0-9a-f]{6}$/iu.test(measured.avgColor) ? measured.avgColor : "#808080",
    fingerprint,
    ...(measured.width === undefined ? {} : { width: measured.width }),
    ...(measured.height === undefined ? {} : { height: measured.height }),
    ...(measured.durationMs === undefined ? {} : { durationMs: measured.durationMs }),
    ...(measured.thumbDataUrl === undefined ? {} : { thumbDataUrl: measured.thumbDataUrl }),
  };

  try {
    await options.library.put(meta, measured.blob);
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, code: "quota" };
    return { ok: false, code: "storage-unavailable" };
  }
  return { ok: true, meta, deduped: false };
}
