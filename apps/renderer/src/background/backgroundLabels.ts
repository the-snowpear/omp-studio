/**
 * 背景图库的展示文案辅助：名称、类型、体积、时长。
 * 只做纯字符串拼装，i18n 键由调用方翻译。
 */

import type { BackgroundAsset } from "./backgroundLibrary";

export function backgroundAssetName(asset: BackgroundAsset, zh: boolean): string {
  if (asset.source === "preset") {
    return (zh ? asset.nameZh : asset.nameEn) ?? asset.name;
  }
  return asset.name;
}

export type BackgroundKindKey = "presetKind" | "imageKind" | "gifKind" | "videoKind";

export function backgroundAssetKindKey(asset: BackgroundAsset): BackgroundKindKey {
  if (asset.kind === "preset") return "presetKind";
  if (asset.kind === "video") return "videoKind";
  if (asset.mime === "image/gif") return "gifKind";
  return "imageKind";
}

export function formatBackgroundBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 100 ? 0 : 1)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

export function formatBackgroundDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
