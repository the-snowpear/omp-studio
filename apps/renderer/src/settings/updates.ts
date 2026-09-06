/**
 * Desktop-chrome 统一更新状态管理（应用热更新与 Runtime 工件更新）。
 *
 * 维护在线检测、本地导入、断点下载与激活状态。
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type UpdateJobKind = "app" | "runtime";
export type UpdatePhase =
  | "resolving"
  | "downloading"
  | "verifying"
  | "extracting"
  | "installing"
  | "activating"
  | "awaiting-apply"
  | "done"
  | "failed"
  | "cancelled";

export interface UpdateProgressEvent {
  readonly jobId: string;
  readonly kind: UpdateJobKind;
  readonly phase: UpdatePhase;
  readonly step: number;
  readonly steps: number;
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
  readonly bytesPerSecond?: number;
  readonly message?: string;
  readonly runtimeChannel?: "stable" | "canary";
}

export interface UpdateCheckResult {
  readonly checkedAt: string;
  readonly app: {
    readonly currentVersion?: string;
    readonly plan: "none" | "hot" | "full";
    readonly version?: string;
    readonly reason?: string;
    readonly sizeBytes?: number;
    readonly releaseNotesUrl?: string;
  };
  readonly runtime: {
    readonly plan: "none" | "available" | "blocked";
    readonly runtimeVersion?: string;
    readonly reason?: string;
    readonly sizeBytes?: number;
  };
  readonly error?: string;
}

export interface UpdatePrefs {
  readonly mirrorPrefix: string;
  readonly autoCheck: boolean;
  readonly skippedAppVersion: string;
  readonly runtimeChannel: "stable" | "canary";
  readonly preferHotUpdate: boolean;
  readonly lastIndexSequence: number;
}

export interface ChromeUpdatesImportInput {
  readonly kind: UpdateJobKind;
  readonly source: "file" | "directory";
}

export interface ChromeUpdatesPrefsSetInput {
  readonly mirrorPrefix?: string;
  readonly autoCheck?: boolean;
  readonly skippedAppVersion?: string;
  readonly runtimeChannel?: "stable" | "canary";
  readonly preferHotUpdate?: boolean;
}

export interface UpdateImportResult {
  readonly ok: boolean;
  readonly jobId?: string;
  readonly cancelled?: boolean;
  readonly runtimeVersion?: string;
  readonly runtimeChannel?: "stable" | "canary";
  readonly message?: string;
}

export interface UpdateStartResult {
  readonly ok: boolean;
  readonly jobId?: string | undefined;
  readonly message?: string | undefined;
}

export interface UpdatesState {
  readonly checking: boolean;
  readonly check: UpdateCheckResult | null;
  readonly job: UpdateProgressEvent | null;
  readonly error: string | null;
  readonly prefs: UpdatePrefs | null;
}

let currentState: UpdatesState = {
  checking: false,
  check: null,
  job: null,
  error: null,
  prefs: null,
};

let cleanupJobTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateState(patch: Partial<UpdatesState>): void {
  currentState = { ...currentState, ...patch };
  notifyListeners();
}

export function getUpdatesState(): UpdatesState {
  return currentState;
}

export function subscribeUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function handleProgressEvent(event: UpdateProgressEvent): void {
  if (cleanupJobTimer !== null) {
    clearTimeout(cleanupJobTimer);
    cleanupJobTimer = null;
  }

  updateState({ job: event });

  if (event.phase === "done" || event.phase === "failed" || event.phase === "cancelled") {
    cleanupJobTimer = setTimeout(() => {
      cleanupJobTimer = null;
      if (currentState.job?.jobId === event.jobId) {
        updateState({ job: null });
      }
    }, 2000);
  }
}

// 模块初始化时绑定进度监听
const _progressUnsub = globalThis.ompStudioChrome?.subscribeUpdateProgress?.(handleProgressEvent);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _progressUnsub?.();
    if (cleanupJobTimer !== null) clearTimeout(cleanupJobTimer);
  });
}

export async function checkForUpdates(options?: {
  readonly silent?: boolean | undefined;
}): Promise<UpdateCheckResult | null> {
  const silent = options?.silent ?? true;
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.checkUpdates !== "function") {
    return null;
  }

  updateState({ checking: true, error: null });
  try {
    const result = await chrome.checkUpdates();
    if (result && typeof result === "object") {
      updateState({
        checking: false,
        check: result,
        error: result.error ?? null,
      });
      return result;
    }
    updateState({ checking: false, check: null });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({ checking: false, error: message });
    if (!silent) {
      throw error;
    }
    return null;
  }
}

export async function importLocalUpdate(input: ChromeUpdatesImportInput): Promise<UpdateImportResult> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.importLocalUpdate !== "function") {
    const message = "Desktop bridge interface unavailable";
    const res: UpdateImportResult = { ok: false, message };
    updateState({ error: message });
    return res;
  }

  try {
    const res = await chrome.importLocalUpdate(input);
    if (!res.ok && !res.cancelled && typeof res.message === "string") {
      updateState({ error: res.message });
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateState({ error: message });
    return { ok: false, message };
  }
}

export async function startRuntimeUpdate(): Promise<UpdateStartResult> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.startRuntime !== "function") {
    const message = "Desktop bridge interface unavailable";
    const res: UpdateStartResult = { ok: false, message };
    updateState({ error: message });
    return res;
  }
  try {
    const res = await chrome.startRuntime();
    if (!res.ok && typeof res.message === "string") {
      updateState({ error: res.message });
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateState({ error: message });
    return { ok: false, message };
  }
}

/** Subscribe before starting, retaining early events until the host returns the job ID. */
export async function downloadUpdateToReady(
  kind: UpdateJobKind,
  onProgress?: (event: UpdateProgressEvent) => void,
): Promise<UpdateProgressEvent> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome?.subscribeUpdateProgress || !(kind === "app" ? chrome.startApp : chrome.startRuntime)) {
    throw new Error("Desktop update bridge unavailable");
  }
  let jobId: string | undefined;
  const early = new Map<string, UpdateProgressEvent>();
  let cleanup: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  return new Promise<UpdateProgressEvent>((resolve, reject) => {
    const finish = (event?: UpdateProgressEvent, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup?.();
      if (event) resolve(event);
      else reject(error);
    };
    const armTimeout = () => {
      clearTimeout(timer);
      // An inactivity timeout, so a large download can run longer than two minutes.
      timer = setTimeout(() => finish(undefined, new Error("Update progress timed out")), 120_000);
    };
    const handle = (event: UpdateProgressEvent) => {
      if (settled || event.kind !== kind) return;
      if (!jobId) {
        early.set(event.jobId, event);
        return;
      }
      if (event.jobId !== jobId) return;
      armTimeout();
      onProgress?.(event);
      if (event.phase === "awaiting-apply") finish(event);
      else if (event.phase === "failed" || event.phase === "cancelled") {
        finish(undefined, new Error(event.message ?? `Update ${event.phase}`));
      }
    };
    armTimeout();
    try {
      cleanup = chrome.subscribeUpdateProgress(handle);
      void (kind === "app" ? chrome.startApp() : chrome.startRuntime()).then((result) => {
        if (settled) return;
        if (!result.ok || !result.jobId) {
          finish(undefined, new Error(result.message ?? "Unable to start update"));
          return;
        }
        jobId = result.jobId;
        const event = early.get(jobId);
        early.clear();
        if (event) handle(event);
      }, (error: unknown) => finish(undefined, error));
    } catch (error) {
      finish(undefined, error);
    }
  });
}

export async function cancelUpdate(jobId: string): Promise<void> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.cancelUpdate !== "function") {
    return;
  }
  await chrome.cancelUpdate(jobId);
}

export async function fetchUpdatePrefs(): Promise<UpdatePrefs | null> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.getUpdatePrefs !== "function") {
    return null;
  }
  try {
    const prefs = await chrome.getUpdatePrefs();
    updateState({ prefs });
    return prefs;
  } catch {
    return null;
  }
}

export async function saveUpdatePrefs(patch: ChromeUpdatesPrefsSetInput): Promise<UpdatePrefs | null> {
  const chrome = globalThis.ompStudioChrome;
  if (!chrome || typeof chrome.setUpdatePrefs !== "function") {
    return null;
  }
  try {
    const prefs = await chrome.setUpdatePrefs(patch);
    updateState({ prefs });
    return prefs;
  } catch {
    return null;
  }
}

export function dismissUpdateError(): void {
  updateState({ error: null });
}

export function __resetUpdatesForTests(initial?: Partial<UpdatesState>): void {
  if (cleanupJobTimer !== null) {
    clearTimeout(cleanupJobTimer);
    cleanupJobTimer = null;
  }
  currentState = {
    checking: false,
    check: null,
    job: null,
    error: null,
    prefs: null,
    ...initial,
  };
  notifyListeners();
}

export function useUpdates(): {
  readonly state: UpdatesState;
  readonly check: (silent?: boolean) => Promise<UpdateCheckResult | null>;
  readonly importLocal: (input: ChromeUpdatesImportInput) => Promise<UpdateImportResult>;
  readonly startRuntime: () => Promise<UpdateStartResult>;
  readonly cancel: (jobId: string) => Promise<void>;
  readonly fetchPrefs: () => Promise<UpdatePrefs | null>;
  readonly savePrefs: (patch: ChromeUpdatesPrefsSetInput) => Promise<UpdatePrefs | null>;
  readonly dismissError: () => void;
} {
  const state = useSyncExternalStore(subscribeUpdates, getUpdatesState, getUpdatesState);

  const check = useCallback((silent?: boolean) => checkForUpdates({ silent }), []);
  const importLocal = useCallback((input: ChromeUpdatesImportInput) => importLocalUpdate(input), []);
  const startRuntime = useCallback(() => startRuntimeUpdate(), []);
  const cancel = useCallback((jobId: string) => cancelUpdate(jobId), []);
  const fetchPrefs = useCallback(() => fetchUpdatePrefs(), []);
  const savePrefs = useCallback((patch: ChromeUpdatesPrefsSetInput) => saveUpdatePrefs(patch), []);
  const dismissError = useCallback(() => dismissUpdateError(), []);

  return useMemo(
    () => ({
      state,
      check,
      importLocal,
      startRuntime,
      cancel,
      fetchPrefs,
      savePrefs,
      dismissError,
    }),
    [state, check, importLocal, startRuntime, cancel, fetchPrefs, savePrefs, dismissError],
  );
}
