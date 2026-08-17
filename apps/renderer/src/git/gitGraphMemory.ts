const STORAGE_KEY = "omp.gitGraphLayout";
const DEFAULT_RATIO = 0.58;

export interface GitGraphLayout {
  readonly open: boolean;
  readonly splitRatio: number;
}

export function readGitGraphLayout(): GitGraphLayout {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { open: false, splitRatio: DEFAULT_RATIO };
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      open: value.open === true,
      splitRatio: typeof value.splitRatio === "number" && Number.isFinite(value.splitRatio)
        ? Math.min(0.85, Math.max(0.15, value.splitRatio))
        : DEFAULT_RATIO,
    };
  } catch {
    return { open: false, splitRatio: DEFAULT_RATIO };
  }
}

export function writeGitGraphLayout(layout: GitGraphLayout): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage blocked */
  }
}
