/**
 * Desktop-chrome 应用更新状态管理。
 *
 * 从签名更新索引投影应用更新，保留完整安装包的安装路径。
 * 启动时支持静默检测（失败不报错、不弹扰人 toast）。
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { cancelUpdate, checkForUpdates, downloadUpdateToReady, fetchUpdatePrefs, getUpdatesState, saveUpdatePrefs, subscribeUpdates } from "./updates";

export interface AppUpdateState {
  readonly checking: boolean;
  readonly downloading: boolean;
  readonly downloadError: string | null;
  readonly readyToApply?: boolean;
  readonly rollbackVersion?: string | undefined;
  readonly rollbackReady?: boolean;
  readonly receivedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
  readonly updateInfo: {
    readonly available: boolean;
    readonly component?: "app" | "runtime";
    readonly currentVersion: string;
    readonly plan?: "none" | "hot" | "full";
    readonly reason?: string | undefined;
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

let unifiedSnapshot: import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot | undefined;
const unsubscribeUpdates = subscribeUpdates(() => {
  if (unifiedSnapshot) return;
  const { check, checking, job, prefs } = getUpdatesState();
  updateState({
    checking,
    updateInfo: check ? {
      available: !check.error && check.app.plan !== "none" && check.app.version !== prefs?.skippedAppVersion,
      currentVersion: check.app.currentVersion ?? currentState.updateInfo?.currentVersion ?? "",
      version: check.app.version,
      plan: check.app.plan,
      reason: check.app.reason,
      assetSize: check.app.sizeBytes,
      htmlUrl: check.app.releaseNotesUrl,
    } : null,
    ...(job?.kind === "app" ? {
      receivedBytes: job.receivedBytes,
      totalBytes: job.totalBytes,
      ...(job.phase === "failed" ? { downloadError: job.message ?? "Update failed", readyToApply: false } : {}),
    } : {}),
  });
});
function receiveUnifiedUpdate(snapshot: import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot): void {
  unifiedSnapshot = snapshot;
  const parts = [snapshot.app, snapshot.runtime];
  const downloading = parts.some(p => p.phase === "downloading" || p.phase === "verifying");
  const ready = !downloading && parts.some(p => p.phase === "ready");
  const current = snapshot.app.version ? snapshot.app : snapshot.runtime;
  updateState({
    checking: snapshot.checking, downloading, readyToApply: ready,
    rollbackVersion: snapshot.rollbackAppVersion,
    rollbackReady: snapshot.rollbackAppPending === true && snapshot.app.phase === "ready",
    downloadError: snapshot.error ?? parts.find(p => p.phase === "failed")?.message ?? null,
    receivedBytes: parts.reduce((n, p) => n + (p.receivedBytes ?? 0), 0),
    totalBytes: parts.reduce((n, p) => n + (p.totalBytes ?? 0), 0),
    updateInfo: {
      component: current.component,
      available: Boolean(current.version), currentVersion: current.currentVersion ?? "",
      version: current.version, name: current.component === "runtime" ? `OMP Runtime ${current.version ?? ""}` : `OMP Studio ${current.version ?? ""}`,
      reason: "restart-update", htmlUrl: snapshot.releaseNotesUrl,
      releaseNotes: parts.filter(p => p.version).map(p => `${p.component === "app" ? "OMP Studio" : "Runtime"}: ${p.currentVersion ?? "—"} → ${p.version}${p.method === "differential" ? " · 增量下载" : p.method === "reuse" ? " · 复用已下载工件" : p.method === "full" ? " · 完整下载" : ""}${p.message ? `\n${p.message}` : ""}`).join("\n\n"),
    },
  });
}
const unsubscribeUnified = globalThis.ompStudioChrome?.subscribeUpdates?.(receiveUnifiedUpdate);
void globalThis.ompStudioChrome?.getUpdateSnapshot?.().then(s => { if (s) receiveUnifiedUpdate(s); }).catch(() => {});
if (import.meta.hot) import.meta.hot.dispose(() => unsubscribeUnified?.());
if (import.meta.hot) import.meta.hot.dispose(unsubscribeUpdates);

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
  if (!chrome || typeof chrome.checkUpdates !== "function") {
    return null;
  }

  updateState({ checking: true });
  try {
    if (silent) {
      const prefs = await fetchUpdatePrefs();
      if (!prefs || !prefs.autoCheck) return null;
      const snapshot = await chrome.getUpdateSnapshot?.().catch(() => null);
      if (snapshot) { receiveUnifiedUpdate(snapshot); return currentState.updateInfo; }
    }
    const result = await checkForUpdates({ silent });
    if (result?.error && !silent) throw new Error(result.error);
    return currentState.updateInfo;
  } catch (error) {
    updateState({ checking: false });
    if (!silent) {
      throw error;
    }
    return null;
  } finally {
    updateState({ checking: false });
  }
}

/** 下载并验签；由用户另行确认应用并重启。 */
export async function downloadAndInstallAppUpdate(): Promise<boolean> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || !currentState.updateInfo?.available) {
    updateState({ downloadError: "No available update" });
    return false;
  }

  updateState({ downloading: true, downloadError: null, readyToApply: false });
  try {
    if (chrome.prepareUpdates && await chrome.getUpdateSnapshot?.().catch(() => null)) {
      receiveUnifiedUpdate(await chrome.prepareUpdates("all"));
      return false;
    }
    await downloadUpdateToReady("app");
    updateState({ readyToApply: true });
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateState({ downloading: false, downloadError: message });
    return false;
  } finally {
    updateState({ downloading: false });
  }
}

export async function applyAppUpdate(): Promise<boolean> {
  if (!currentState.readyToApply) return false;
  updateState({ downloading: true, downloadError: null });
  try {
    const result = await globalThis.ompStudioChrome?.applyUpdate();
    if (!result?.ok || result.deferred) {
      updateState({ downloadError: result?.message ?? "Update could not be applied; finish active sessions and retry" });
      return false;
    }
    return true;
  } catch (error) {
    updateState({ downloadError: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    updateState({ downloading: false });
  }
}

export async function skipAppUpdate(): Promise<void> {
  // Runtime skipping has no persisted policy yet; its dialog omits this action.
  if (currentState.updateInfo?.component === "runtime") return;
  const version = currentState.updateInfo?.version;
  if (version && await saveUpdatePrefs({ skippedAppVersion: version })) dismissAppUpdate();
}

export async function prepareDesktopRollback(): Promise<boolean> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome?.rollbackUpdate || !chrome.getUpdateSnapshot) return false;
  updateState({ downloading: true, downloadError: null });
  try {
    const result = await chrome.rollbackUpdate();
    if (!result.ok || result.deferred) throw new Error(result.message ?? "Desktop rollback could not be prepared");
    const snapshot = await chrome.getUpdateSnapshot();
    if (!snapshot) throw new Error("Update state unavailable");
    receiveUnifiedUpdate(snapshot);
    return currentState.rollbackReady === true;
  } catch (error) {
    updateState({ downloadError: error instanceof Error ? error.message : String(error) });
    return false;
  } finally { updateState({ downloading: false }); }
}

export async function cancelAppUpdate(): Promise<void> {
  if (unifiedSnapshot) { await globalThis.ompStudioChrome?.cancelUpdate("unified"); return; }
  const job = getUpdatesState().job;
  if (job?.kind !== "app") return;
  try {
    await cancelUpdate(job.jobId);
    updateState({ readyToApply: false });
  } catch (error) {
    updateState({ downloadError: error instanceof Error ? error.message : String(error) });
  }
}

export function dismissAppUpdate(): void {
  updateState({ updateInfo: null, downloadError: null });
}

export function __resetAppUpdateForTests(initial?: Partial<AppUpdateState>): void {
  unifiedSnapshot = undefined;
  currentState = {
    checking: false,
    downloading: false,
    downloadError: null,
    updateInfo: null,
    ...initial,
  };
  notifyListeners();
}

export function useAppUpdate(): {
  readonly state: AppUpdateState;
  readonly check: (silent?: boolean) => Promise<AppUpdateState["updateInfo"]>;
  readonly downloadAndInstall: () => Promise<boolean>;
  readonly dismiss: () => void;
  readonly apply: () => Promise<boolean>;
  readonly skip: () => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly prepareRollback: () => Promise<boolean>;
} {
  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState, getAppUpdateState);

  const check = useCallback((silent?: boolean) => checkForAppUpdates({ silent }), []);
  const downloadAndInstall = useCallback(() => downloadAndInstallAppUpdate(), []);
  const dismiss = useCallback(() => dismissAppUpdate(), []);

  return useMemo(() => ({
    state,
    check,
    downloadAndInstall,
    dismiss,
    apply: applyAppUpdate,
    skip: skipAppUpdate,
    cancel: cancelAppUpdate,
    prepareRollback: prepareDesktopRollback,
  }), [state, check, downloadAndInstall, dismiss]);
}
