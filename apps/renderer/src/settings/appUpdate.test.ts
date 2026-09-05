import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetAppUpdateForTests, applyAppUpdate, checkForAppUpdates, downloadAndInstallAppUpdate, getAppUpdateState, skipAppUpdate } from "./appUpdate";
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
  vi.stubGlobal("ompStudioChrome", { applyUpdate: async () => ({ ok: true, deferred: true, message: "Sessions are running" }) });
  await expect(applyAppUpdate()).resolves.toBe(false);
  expect(getAppUpdateState()).toMatchObject({ readyToApply: true, downloading: false, downloadError: "Sessions are running" });
});
