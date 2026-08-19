/**
 * Desktop-chrome 应用更新状态管理。
 *
 * 维护 GitHub Releases 全量更新检测、下载与安装状态。
 * 启动时支持静默检测（失败不报错、不弹扰人 toast）。
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export interface AppUpdateState {
  readonly checking: boolean;
  readonly downloading: boolean;
  readonly downloadError: string | null;
  readonly downloadedFilePath: string | null;
  readonly updateInfo: {
    readonly available: boolean;
    readonly currentVersion: string;
    readonly version?: string | undefined;
    readonly name?: string | undefined;
    readonly releaseNotes?: string | undefined;
    readonly publishedAt?: string | undefined;
    readonly htmlUrl?: string | undefined;
    readonly downloadUrl?: string | undefined;
    readonly assetName?: string | undefined;
    readonly assetSize?: number | undefined;
  } | null;
}

let currentState: AppUpdateState = {
  checking: false,
  downloading: false,
  downloadError: null,
  downloadedFilePath: null,
  updateInfo: null,
};

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateState(patch: Partial<AppUpdateState>): void {
  currentState = { ...currentState, ...patch };
  notifyListeners();
}

export function getAppUpdateState(): AppUpdateState {
  return currentState;
}

export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 启动或手动触发更新检测。silent 为 true 时失败完全静默。 */
export async function checkForAppUpdates(options?: {
  readonly silent?: boolean | undefined;
}): Promise<AppUpdateState["updateInfo"]> {
  const silent = options?.silent ?? true;
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.checkAppUpdate !== "function") {
    return null;
  }

  updateState({ checking: true });
  try {
    const result = await chrome.checkAppUpdate();
    if (result && typeof result === "object") {
      updateState({ checking: false, updateInfo: result });
      return result;
    }
    updateState({ checking: false, updateInfo: null });
    return null;
  } catch (error) {
    updateState({ checking: false });
    if (!silent) {
      throw error;
    }
    return null;
  }
}

/** 下载安装包并执行安装。 */
export async function downloadAndInstallAppUpdate(downloadUrl?: string): Promise<boolean> {
  const chrome = globalThis.ompStudioChrome;
  const url = downloadUrl ?? currentState.updateInfo?.downloadUrl;
  if (!chrome || !url) {
    updateState({ downloadError: "无可用的下载地址" });
    return false;
  }

  updateState({ downloading: true, downloadError: null });
  try {
    const res = await chrome.downloadAppUpdate(url);
    if (!res.ok) {
      updateState({ downloading: false, downloadError: res.message });
      return false;
    }
    updateState({ downloading: false, downloadedFilePath: res.filePath });
    const installRes = await chrome.quitAndInstallUpdate(res.filePath);
    if (!installRes.ok) {
      updateState({ downloadError: installRes.message });
      return false;
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateState({ downloading: false, downloadError: message });
    return false;
  }
}

export function dismissAppUpdate(): void {
  updateState({ updateInfo: null, downloadError: null });
}

export function __resetAppUpdateForTests(initial?: Partial<AppUpdateState>): void {
  currentState = {
    checking: false,
    downloading: false,
    downloadError: null,
    downloadedFilePath: null,
    updateInfo: null,
    ...initial,
  };
  notifyListeners();
}

export function useAppUpdate(): {
  readonly state: AppUpdateState;
  readonly check: (silent?: boolean) => Promise<AppUpdateState["updateInfo"]>;
  readonly downloadAndInstall: (downloadUrl?: string) => Promise<boolean>;
  readonly dismiss: () => void;
} {
  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState, getAppUpdateState);

  const check = useCallback((silent?: boolean) => checkForAppUpdates({ silent }), []);
  const downloadAndInstall = useCallback((url?: string) => downloadAndInstallAppUpdate(url), []);
  const dismiss = useCallback(() => dismissAppUpdate(), []);

  return useMemo(() => ({
    state,
    check,
    downloadAndInstall,
    dismiss,
  }), [state, check, downloadAndInstall, dismiss]);
}
