/** 发布时为 false：顶栏开关消失，并强制真实数据。 */
export const PREVIEW_MODE_SWITCH_ENABLED = false;
export const PREVIEW_MODE_STORAGE_KEY = "omp.previewMode";
/**
 * `?marks=off`：预览数据下隐藏所有「演示 / 预览」提示。
 * 「启动预览版」用它把演示数据当成真实页面展示；开发调试可省略该参数。
 */
export const PREVIEW_MARKS_QUERY_KEY = "marks";

export function previewMarksHidden(): boolean {
  try {
    return new URLSearchParams(window.location.search).get(PREVIEW_MARKS_QUERY_KEY) === "off";
  } catch {
    return false;
  }
}

export function readStoredPreviewMode(): boolean {
  try {
    const raw = localStorage.getItem(PREVIEW_MODE_STORAGE_KEY);
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
  } catch {
    /* localStorage may be blocked */
  }
  return false;
}

export function writeStoredPreviewMode(on: boolean): void {
  try {
    localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* localStorage may be blocked */
  }
}
