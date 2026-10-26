import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetAppUpdateForTests, applyAppUpdate, cancelAppUpdate, checkForAppUpdates, downloadAndInstallAppUpdate, getAppUpdateState, skipAppUpdate, prepareDesktopRollback } from "./appUpdate";
import { __resetUpdatesForTests, checkForUpdates, handleProgressEvent, type UpdateProgressEvent } from "./updates";

const prefs = { autoCheck: true, skippedAppVersion: "", mirrorPrefix: "", runtimeChannel: "stable", preferHotUpdate: true, lastIndexSequence: 1 };
const update = { checkedAt: "2026-09-05", app: { plan: "hot", currentVersion: "0.1.3", version: "0.1.4" }, runtime: { plan: "none" } };

beforeEach(() => { __resetUpdatesForTests(); __resetAppUpdateForTests(); });
afterEach(() => { __resetUpdatesForTests(); vi.unstubAllGlobals(); });

it("respects auto-check preferences and uses only the signed index for manual checks", async () => {
  const checkUpdates = vi.fn().mockResolvedValue(update);
  const oldCheck = vi.fn();
  vi.stubGlobal("ompStudioChrome", {
    getUpdatePrefs: async () => ({ ...prefs, autoCheck: false }), checkUpdates, checkAppUpdate: oldCheck,
  });
  await checkForAppUpdates({ silent: true });
  expect(checkUpdates).not.toHaveBeenCalled();
  await checkForAppUpdates({ silent: false });
  expect(getAppUpdateState().updateInfo).toMatchObject({ available: true, plan: "hot", currentVersion: "0.1.3" });
  expect(oldCheck).not.toHaveBeenCalled();
});

it("reflects checks made by diagnostics and keeps skipped versions hidden on progress", async () => {
  vi.stubGlobal("ompStudioChrome", {
    checkUpdates: async () => update,
    setUpdatePrefs: async (patch: object) => ({ ...prefs, ...patch }),
  });
  await checkForUpdates();
  expect(getAppUpdateState().updateInfo?.available).toBe(true);
  await skipAppUpdate();
  handleProgressEvent({ kind: "runtime", jobId: "runtime-1", phase: "downloading", step: 1, steps: 3 });
  expect(getAppUpdateState().updateInfo?.available).toBe(false);
});

it.each(["hot", "full"])("downloads %s updates using opaque jobs and waits for explicit apply", async (plan) => {
  let listener!: (event: UpdateProgressEvent) => void;
  const applyUpdate = vi.fn().mockResolvedValue({ ok: true });
  const legacyDownload = vi.fn();
  vi.stubGlobal("ompStudioChrome", {
    checkUpdates: async () => ({ ...update, app: { ...update.app, plan } }),
    subscribeUpdateProgress: (fn: typeof listener) => { listener = fn; return vi.fn(); },
    startApp: async () => {
      listener({ kind: "app", jobId: "app-1", phase: "awaiting-apply", step: 3, steps: 3 });
      return { ok: true, jobId: "app-1" };
    },
    applyUpdate, downloadAppUpdate: legacyDownload,
  });
  await checkForAppUpdates({ silent: false });
  await downloadAndInstallAppUpdate();
  expect(getAppUpdateState()).toMatchObject({ downloading: false, readyToApply: true });
  expect(applyUpdate).not.toHaveBeenCalled();
  expect(legacyDownload).not.toHaveBeenCalled();
  await expect(applyAppUpdate()).resolves.toBe(true);
  expect(applyUpdate).toHaveBeenCalledOnce();
});

it("keeps deferred application retryable and reports its reason", async () => {
  __resetAppUpdateForTests({ readyToApply: true });
  const prepareUpdates = vi.fn();
  const applyUpdate = vi.fn().mockResolvedValueOnce({ ok: true, deferred: true, message: "Sessions are running" }).mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("ompStudioChrome", { applyUpdate, prepareUpdates });
  await expect(applyAppUpdate()).resolves.toBe(false);
  expect(getAppUpdateState()).toMatchObject({ readyToApply: true, downloading: false, applying: false, applyNotice: "Sessions are running", downloadError: null, applyError: null });
  await expect(applyAppUpdate()).resolves.toBe(true);
  expect(applyUpdate).toHaveBeenCalledTimes(2);
  expect(prepareUpdates).not.toHaveBeenCalled();
  expect(getAppUpdateState().applyNotice).toBeNull();
});

it("reports application failures separately while keeping the verified update retryable", async () => {
  __resetAppUpdateForTests({ readyToApply: true });
  let rejectApply!: (reason: Error) => void;
  vi.stubGlobal("ompStudioChrome", { applyUpdate: () => new Promise((_resolve, reject) => { rejectApply = reject; }) });
  const result = applyAppUpdate();
  expect(getAppUpdateState()).toMatchObject({ applying: true, downloading: false });
  rejectApply(new Error("Installer could not start"));
  await expect(result).resolves.toBe(false);
  expect(getAppUpdateState()).toMatchObject({ readyToApply: true, applying: false, applyError: "Installer could not start", downloadError: null });
});

it("keeps the waiting notice across snapshots for the same prepared target", async () => {
  let version = "0.1.6";
  vi.stubGlobal("ompStudioChrome", {
    getUpdatePrefs: async () => prefs, checkUpdates: vi.fn(),
    getUpdateSnapshot: async () => ({ schema: 2, checking: false, app: { component: "app", currentVersion: "0.1.5", version, phase: "ready" }, runtime: { component: "runtime", phase: "idle" } }),
    applyUpdate: async () => ({ ok: true, deferred: true, message: "Review the pending interaction" }),
  });
  await checkForAppUpdates({ silent: true });
  await applyAppUpdate();
  await checkForAppUpdates({ silent: true });
  expect(getAppUpdateState()).toMatchObject({ readyToApply: true, applyNotice: "Review the pending interaction", downloadError: null });
  version = "0.1.7";
  await checkForAppUpdates({ silent: true });
  expect(getAppUpdateState().applyNotice).toBeNull();
});

it.each([
  ["check", "checkError"], ["prepare", "downloadError"], ["apply", "applyError"], ["recovery", "applyError"], [undefined, "checkError"],
] as const)("classifies %s snapshot errors without treating every failure as a download failure", async (errorStage, field) => {
  vi.stubGlobal("ompStudioChrome", {
    getUpdatePrefs: async () => prefs, checkUpdates: vi.fn(),
    getUpdateSnapshot: async () => ({ schema: 2, checking: false, errorStage, error: "Failure detail", app: { component: "app", currentVersion: "0.1.5", version: "0.1.6", phase: "ready" }, runtime: { component: "runtime", phase: "idle" } }),
  });
  await checkForAppUpdates({ silent: true });
  expect(getAppUpdateState()[field]).toBe("Failure detail");
  if (field !== "downloadError") expect(getAppUpdateState().downloadError).toBeNull();
  expect(getAppUpdateState().readyToApply).toBe(true);
});

it("labels cancellation failures separately from download failures", async () => {
  vi.stubGlobal("ompStudioChrome", {
    getUpdatePrefs: async () => prefs, checkUpdates: vi.fn(),
    getUpdateSnapshot: async () => ({ schema: 2, checking: false, app: { component: "app", currentVersion: "0.1.5", version: "0.1.6", phase: "downloading" }, runtime: { component: "runtime", phase: "idle" } }),
    cancelUpdate: async () => { throw new Error("Cancellation unavailable"); },
  });
  await checkForAppUpdates({ silent: true });
  await cancelAppUpdate();
  expect(getAppUpdateState()).toMatchObject({ cancelError: "Cancellation unavailable", downloadError: null });
});

it.each(["check", "prepare"] as const)("keeps a %s failure inside preparation in its Host-reported stage", async errorStage => {
  let failed = false;
  const failure = "HTTP 403 from update source";
  const snapshot = () => ({
    schema: 2, checking: false,
    ...(failed ? { error: failure, errorStage } : {}),
    app: { component: "app", currentVersion: "0.1.5", version: "0.1.6", phase: failed ? "failed" : "idle", ...(failed ? { message: failure, errorStage: "prepare" } : {}) },
    runtime: { component: "runtime", currentVersion: "18.0.0-studio.1", version: "18.0.0-studio.2", phase: "ready" },
  });
  __resetAppUpdateForTests({ updateInfo: { available: true, currentVersion: "0.1.5", version: "0.1.6" } });
  vi.stubGlobal("ompStudioChrome", {
    getUpdateSnapshot: async () => snapshot(),
    prepareUpdates: async () => { failed = true; throw new Error(failure); },
  });
  await expect(downloadAndInstallAppUpdate()).resolves.toBe(false);
  expect(getAppUpdateState()).toMatchObject({
    downloading: false, readyToApply: true, applyError: null,
    checkError: errorStage === "check" ? failure : null,
    downloadError: errorStage === "prepare" ? failure : null,
  });
});

it("prepares desktop rollback from the unified snapshot without installing until requested", async () => {
  const applyUpdate = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("ompStudioChrome", {
    rollbackUpdate: vi.fn().mockResolvedValue({ ok: true }), applyUpdate,
    getUpdateSnapshot: async () => ({ schema: 2, checking: false, rollbackAppVersion: "0.1.4", rollbackAppPending: true, app: { component: "app", currentVersion: "0.1.5", version: "0.1.4", phase: "ready" }, runtime: { component: "runtime", phase: "idle" } }),
  });
  expect(await prepareDesktopRollback()).toBe(true);
  expect(getAppUpdateState()).toMatchObject({ rollbackVersion: "0.1.4", rollbackReady: true, readyToApply: true, downloading: false });
  expect(applyUpdate).not.toHaveBeenCalled();
  expect(await applyAppUpdate()).toBe(true);
  expect(applyUpdate).toHaveBeenCalledOnce();
});

it("does not save a Runtime-only version as a skipped desktop version", async () => {
  const setUpdatePrefs = vi.fn();
  vi.stubGlobal("ompStudioChrome", {
    setUpdatePrefs, checkUpdates: vi.fn(), getUpdatePrefs: async () => prefs,
    getUpdateSnapshot: async () => ({ schema: 2, checking: false, app: { component: "app", currentVersion: "0.1.5", phase: "idle" }, runtime: { component: "runtime", currentVersion: "18.0.0-studio.1", version: "18.0.0-studio.2", phase: "idle" } }),
  });
  await checkForAppUpdates({ silent: true });
  expect(getAppUpdateState().updateInfo?.component).toBe("runtime");
  await skipAppUpdate();
  expect(setUpdatePrefs).not.toHaveBeenCalled();
  expect(getAppUpdateState().updateInfo?.available).toBe(true);
});
