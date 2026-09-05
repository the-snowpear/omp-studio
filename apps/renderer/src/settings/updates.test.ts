import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getUpdatesState,
  handleProgressEvent,
  checkForUpdates,
  importLocalUpdate,
  startRuntimeUpdate,
  downloadUpdateToReady,
  cancelUpdate,
  dismissUpdateError,
  fetchUpdatePrefs,
  saveUpdatePrefs,
  __resetUpdatesForTests,
  type UpdateProgressEvent,
} from "./updates.js";

describe("updates store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetUpdatesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("updates job on progress event and clears on terminal phase after delay", () => {
    const activeEvent: UpdateProgressEvent = {
      jobId: "job-1",
      kind: "runtime",
      phase: "downloading",
      step: 1,
      steps: 3,
      receivedBytes: 100,
      totalBytes: 1000,
    };

    handleProgressEvent(activeEvent);
    expect(getUpdatesState().job).toEqual(activeEvent);

    const doneEvent: UpdateProgressEvent = {
      jobId: "job-1",
      kind: "runtime",
      phase: "done",
      step: 3,
      steps: 3,
    };

    handleProgressEvent(doneEvent);
    expect(getUpdatesState().job).toEqual(doneEvent);

    // After 1 second, still visible (terminal state delay)
    vi.advanceTimersByTime(1000);
    expect(getUpdatesState().job).toEqual(doneEvent);

    // After 2.1 seconds, job is cleared to null
    vi.advanceTimersByTime(1100);
    expect(getUpdatesState().job).toBeNull();
  });

  it("checkForUpdates updates check state from chrome API", async () => {
    const mockCheckResult = {
      checkedAt: "2026-09-04T12:00:00.000Z",
      app: { plan: "none" as const },
      runtime: { plan: "available" as const, runtimeVersion: "1.2.3" },
    };

    const originalChrome = globalThis.ompStudioChrome;
    globalThis.ompStudioChrome = {
      ...originalChrome,
      checkUpdates: vi.fn().mockResolvedValue(mockCheckResult),
    } as unknown as typeof globalThis.ompStudioChrome;

    try {
      const res = await checkForUpdates({ silent: true });
      expect(res).toEqual(mockCheckResult);
      expect(getUpdatesState().check).toEqual(mockCheckResult);
      expect(getUpdatesState().checking).toBe(false);
    } finally {
      globalThis.ompStudioChrome = originalChrome;
    }
  });

  it("importLocalUpdate delegates to chrome API and captures errors", async () => {
    const originalChrome = globalThis.ompStudioChrome;
    globalThis.ompStudioChrome = {
      ...originalChrome,
      importLocalUpdate: vi.fn().mockResolvedValue({
        ok: false,
        message: "验签失败",
      }),
    } as unknown as typeof globalThis.ompStudioChrome;

    try {
      const res = await importLocalUpdate({ kind: "runtime", source: "directory" });
      expect(res.ok).toBe(false);
      expect(res.message).toBe("验签失败");
      expect(getUpdatesState().error).toBe("验签失败");
    } finally {
      globalThis.ompStudioChrome = originalChrome;
    }
  });

  it("fetchUpdatePrefs and saveUpdatePrefs update prefs in store", async () => {
    const mockPrefs = {
      mirrorPrefix: "https://mirror.example.com/",
      autoCheck: true,
      skippedAppVersion: "",
      runtimeChannel: "stable" as const,
      preferHotUpdate: true,
      lastIndexSequence: 10,
    };

    const originalChrome = globalThis.ompStudioChrome;
    globalThis.ompStudioChrome = {
      ...originalChrome,
      getUpdatePrefs: vi.fn().mockResolvedValue(mockPrefs),
      setUpdatePrefs: vi.fn().mockResolvedValue({ ...mockPrefs, runtimeChannel: "canary" }),
    } as unknown as typeof globalThis.ompStudioChrome;

    try {
      const loaded = await fetchUpdatePrefs();
      expect(loaded).toEqual(mockPrefs);
      expect(getUpdatesState().prefs).toEqual(mockPrefs);

      const saved = await saveUpdatePrefs({ runtimeChannel: "canary" });
      expect(saved?.runtimeChannel).toBe("canary");
      expect(getUpdatesState().prefs?.runtimeChannel).toBe("canary");
    } finally {
      globalThis.ompStudioChrome = originalChrome;
    }
  });

  it("startRuntimeUpdate calls chrome.startRuntime and manages error state", async () => {
    const originalChrome = globalThis.ompStudioChrome;

    // Bridge unavailable
    globalThis.ompStudioChrome = undefined as unknown as typeof globalThis.ompStudioChrome;
    const missingRes = await startRuntimeUpdate();
    expect(missingRes.ok).toBe(false);
    expect(missingRes.message).toBe("Desktop bridge interface unavailable");
    expect(getUpdatesState().error).toBe("Desktop bridge interface unavailable");

    // Success path
    globalThis.ompStudioChrome = {
      startRuntime: vi.fn().mockResolvedValue({ ok: true, jobId: "rt-123" }),
    } as unknown as typeof globalThis.ompStudioChrome;
    dismissUpdateError();
    expect(getUpdatesState().error).toBeNull();

    const okRes = await startRuntimeUpdate();
    expect(okRes.ok).toBe(true);
    expect(okRes.jobId).toBe("rt-123");
    expect(getUpdatesState().error).toBeNull();

    // Error result path
    globalThis.ompStudioChrome = {
      startRuntime: vi.fn().mockResolvedValue({ ok: false, message: "Disk full" }),
    } as unknown as typeof globalThis.ompStudioChrome;
    const failRes = await startRuntimeUpdate();
    expect(failRes.ok).toBe(false);
    expect(getUpdatesState().error).toBe("Disk full");

    // Exception path
    globalThis.ompStudioChrome = {
      startRuntime: vi.fn().mockRejectedValue(new Error("Network exploded")),
    } as unknown as typeof globalThis.ompStudioChrome;
    const throwRes = await startRuntimeUpdate();
    expect(throwRes.ok).toBe(false);
    expect(getUpdatesState().error).toBe("Network exploded");

    globalThis.ompStudioChrome = originalChrome;
  });

  it("cancelUpdate delegates to chrome API if present", async () => {
    const originalChrome = globalThis.ompStudioChrome;
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    globalThis.ompStudioChrome = {
      cancelUpdate: cancelMock,
    } as unknown as typeof globalThis.ompStudioChrome;

    try {
      await cancelUpdate("job-999");
      expect(cancelMock).toHaveBeenCalledWith("job-999");
    } finally {
      globalThis.ompStudioChrome = originalChrome;
    }

    // When chrome is unavailable, does not throw
    globalThis.ompStudioChrome = undefined as unknown as typeof globalThis.ompStudioChrome;
    await expect(cancelUpdate("job-999")).resolves.toBeUndefined();
    globalThis.ompStudioChrome = originalChrome;
  });

  it("dismissUpdateError clears error from store", () => {
    importLocalUpdate({ kind: "runtime", source: "directory" });
    dismissUpdateError();
    expect(getUpdatesState().error).toBeNull();
  });

  it("checkForUpdates handles missing chrome and non-silent errors", async () => {
    const originalChrome = globalThis.ompStudioChrome;

    // Missing chrome API
    globalThis.ompStudioChrome = undefined as unknown as typeof globalThis.ompStudioChrome;
    const res = await checkForUpdates({ silent: true });
    expect(res).toBeNull();

    // Thrown error with silent: false rethrows
    globalThis.ompStudioChrome = {
      checkUpdates: vi.fn().mockRejectedValue(new Error("Offline")),
    } as unknown as typeof globalThis.ompStudioChrome;

    await expect(checkForUpdates({ silent: false })).rejects.toThrow("Offline");

    globalThis.ompStudioChrome = originalChrome;
  });

  it("captures completion before start resolves and ignores another job", async () => {
    let listener!: (event: UpdateProgressEvent) => void;
    let start!: (value: { ok: boolean; jobId: string }) => void;
    const unsubscribe = vi.fn();
    vi.stubGlobal("ompStudioChrome", {
      subscribeUpdateProgress: (fn: typeof listener) => { listener = fn; return unsubscribe; },
      startRuntime: () => new Promise((resolve) => { start = resolve; }),
    });
    const result = downloadUpdateToReady("runtime");
    listener({ kind: "runtime", jobId: "other", phase: "failed", step: 1, steps: 1 });
    const ready: UpdateProgressEvent = { kind: "runtime", jobId: "runtime-1", phase: "awaiting-apply", step: 3, steps: 3 };
    listener(ready);
    start({ ok: true, jobId: "runtime-1" });
    await expect(result).resolves.toEqual(ready);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejected", "failed"])("cleans listener and timeout when start is %s", async (mode) => {
    const unsubscribe = vi.fn();
    vi.stubGlobal("ompStudioChrome", {
      subscribeUpdateProgress: () => unsubscribe,
      startApp: () => mode === "rejected" ? Promise.reject(new Error("busy")) : Promise.resolve({ ok: false, message: "busy" }),
    });
    await expect(downloadUpdateToReady("app")).rejects.toThrow("busy");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses an inactivity timeout and releases the listener after progress stops", async () => {
    let listener!: (event: UpdateProgressEvent) => void;
    const unsubscribe = vi.fn();
    vi.stubGlobal("ompStudioChrome", {
      subscribeUpdateProgress: (fn: typeof listener) => { listener = fn; return unsubscribe; },
      startRuntime: async () => ({ ok: true, jobId: "runtime-1" }),
    });
    const result = downloadUpdateToReady("runtime");
    const failure = expect(result).rejects.toThrow("timed out");
    await Promise.resolve();
    vi.advanceTimersByTime(100_000);
    listener({ kind: "runtime", jobId: "runtime-1", phase: "downloading", step: 1, steps: 3 });
    vi.advanceTimersByTime(100_000);
    expect(unsubscribe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_001);
    await failure;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
