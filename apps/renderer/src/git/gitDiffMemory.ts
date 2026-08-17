const STORAGE_KEY = "omp.gitDiffHeight";

export const GIT_DIFF_MIN = 96;
export const GIT_DIFF_DEFAULT = 220;
const GIT_DIFF_ABS_MAX = 720;
const PANE_RESERVE = 160;

export function clampGitDiffHeight(px: number, paneHeight?: number): number {
  const max = paneHeight === undefined
    ? GIT_DIFF_ABS_MAX
    : Math.max(GIT_DIFF_MIN, paneHeight - PANE_RESERVE);
  return Math.min(max, Math.max(GIT_DIFF_MIN, Math.round(px)));
}

export function readGitDiffHeight(): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return GIT_DIFF_DEFAULT;
    const value = Number(raw);
    if (!Number.isFinite(value)) return GIT_DIFF_DEFAULT;
    return clampGitDiffHeight(value);
  } catch {
    return GIT_DIFF_DEFAULT;
  }
}

export function writeGitDiffHeight(px: number): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(clampGitDiffHeight(px)));
  } catch {
    /* storage blocked */
  }
}
