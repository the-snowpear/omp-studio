/**
 * 用户消息缩略图的降采样。
 *
 * `userMessageThumbs` 这个名字过去是假的：存进 IndexedDB 的是**原图** base64
 * （composer 侧允许单张 16 MiB），`load()` 又会把整个会话的图片一次性读进内存。
 * 一张 4K 截图光 base64 就是 6~7 MB，再加上每次渲染拼出的等长 data URL 与
 * 解码位图（宽×高×4 字节，4K 约 33 MB），几十张就是 GB 级。
 *
 * 这里在落盘前把图片压到「灯箱里看着还行、但比原图小两个数量级」的尺寸：
 * 最长边 1024、WebP q0.72，一张截图典型 60~150 KB。配合
 * `USER_IMAGE_BUDGET_BYTES` 的字节预算，保留的历史缩略图数量就有了实际意义
 * （原图尺寸下预算只装得下一两张）。
 *
 * 只存这一份，不再另存原图：这是纯渲染端的预览缓存（见 `userMessageThumbs` 头注释），
 * 留第二份全分辨率副本等于把刚拆掉的内存隐患原样搬到磁盘上，等下一次读取再引爆。
 * 未发送的草稿仍由 `ChipComposer` 持有原图，所以「粘贴 → 看一眼 → 发送」不受影响。
 */

import type { PromptImage } from "../composer/types";

/** 缩略图最长边。灯箱全屏看不出压缩痕迹，又远小于原图。 */
export const THUMBNAIL_MAX_EDGE = 1024;
/** WebP 质量。0.72 在截图这种大片纯色 + 细文字的内容上肉眼无损。 */
const THUMBNAIL_QUALITY = 0.72;
/**
 * 小于这个字节数直接原样留着：解码再编码一遍未必更小，还白付一次解码。
 * 64 KiB 已经装得下一张不小的 PNG 图标或短截图。
 */
export const THUMBNAIL_PASSTHROUGH_MAX_BYTES = 64 * 1024;

function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= THUMBNAIL_MAX_EDGE) return { width, height };
  const ratio = THUMBNAIL_MAX_EDGE / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/**
 * 返回可以安全长期保留的缩略图；无法降采样时返回 `undefined`。
 *
 * 失败时**不要**退回原图 —— 宁可这条历史消息只剩附件占位，也不要把一张
 * 16 MiB 的图钉在会话内存里。
 */
export async function toThumbnail(image: PromptImage): Promise<PromptImage | undefined> {
  if (image.data.length <= THUMBNAIL_PASSTHROUGH_MAX_BYTES) return image;
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    const bytes = bytesFromBase64(image.data);
    bitmap = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: image.mimeType }));
    const size = scaledSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    // WebP 不可用的环境退回 JPEG；两者都不行就放弃缩略图。
    for (const mimeType of ["image/webp", "image/jpeg"] as const) {
      try {
        const blob = await canvas.convertToBlob({ type: mimeType, quality: THUMBNAIL_QUALITY });
        if (blob.type !== mimeType) continue;
        const data = base64FromBytes(new Uint8Array(await blob.arrayBuffer()));
        // 压完反而更大（极小图或已高度压缩过）就用原图，前提是它本来就不算大。
        if (data.length >= image.data.length) return undefined;
        return { type: "image", mimeType, data };
      } catch {
        // 试下一种编码。
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}
