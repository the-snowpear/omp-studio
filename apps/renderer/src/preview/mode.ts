/** 发布时为 false：顶栏开关消失，并强制真实数据。 */
export const PREVIEW_MODE_SWITCH_ENABLED = false;
export const PREVIEW_MODE_STORAGE_KEY = "omp.previewMode";

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
