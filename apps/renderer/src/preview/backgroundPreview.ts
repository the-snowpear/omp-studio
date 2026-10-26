/**
 * 背景功能的预览模式数据。
 *
 * 预览模式不读真实 localStorage / IndexedDB：设置用这里的演示值，媒体库用
 * 内存实现。演示模式默认关闭背景，避免影响既有页面截图；在设置里打开后
 * 可以完整走一遍切换、参数与预览卡。
 */

import { DEFAULT_BACKGROUND_SETTINGS, normalizeBackgroundSettings, type BackgroundSettings } from "../background/backgroundSettings";
import { createMemoryBackgroundLibrary, type BackgroundLibrary } from "../background/backgroundLibrary";

export const PREVIEW_BACKGROUND_SETTINGS: BackgroundSettings = {
  ...DEFAULT_BACKGROUND_SETTINGS,
  enabled: false,
  scope: "workbench",
};

export function createPreviewBackgroundLibrary(): BackgroundLibrary {
  return createMemoryBackgroundLibrary();
}

/**
 * 本地截图 / QA harness 用：把 `?wallpaper=1` 的背景参数放进 sessionStorage，
 * 预览模式读它，避免为了截图去动真实偏好。普通预览模式没有这个键。
 */
export const PREVIEW_BACKGROUND_STORAGE_KEY = "omp.previewBackground";

export function readPreviewBackgroundSettings(): BackgroundSettings {
  try {
    const raw = globalThis.sessionStorage?.getItem(PREVIEW_BACKGROUND_STORAGE_KEY);
    if (raw) return normalizeBackgroundSettings(JSON.parse(raw));
  } catch {
    /* sessionStorage blocked or bad JSON: fall back to the demo defaults */
  }
  return PREVIEW_BACKGROUND_SETTINGS;
}
