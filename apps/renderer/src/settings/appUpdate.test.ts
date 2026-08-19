import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForAppUpdates,
  downloadAndInstallAppUpdate,
  getAppUpdateState,
  __resetAppUpdateForTests,
} from "./appUpdate";

describe("appUpdate", () => {
  beforeEach(() => {
    __resetAppUpdateForTests();
    Reflect.deleteProperty(globalThis, "ompStudioChrome");
  });

  it("returns null safely when ompStudioChrome is missing", async () => {
    const result = await checkForAppUpdates({ silent: true });
    expect(result).toBeNull();
    expect(getAppUpdateState().checking).toBe(false);
  });

  it("checks updates silently on failure without throwing", async () => {
    globalThis.ompStudioChrome = {
      checkAppUpdate: vi.fn().mockRejectedValue(new Error("Network offline")),
    } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;

    const result = await checkForAppUpdates({ silent: true });
    expect(result).toBeNull();
    expect(getAppUpdateState().checking).toBe(false);
  });

  it("throws error when silent is false and check fails", async () => {
    globalThis.ompStudioChrome = {
      checkAppUpdate: vi.fn().mockRejectedValue(new Error("Network offline")),
    } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;

    await expect(checkForAppUpdates({ silent: false })).rejects.toThrow("Network offline");
    expect(getAppUpdateState().checking).toBe(false);
  });

  it("stores update info when update is available", async () => {
    const mockInfo = {
      available: true,
      currentVersion: "0.1.0",
      version: "0.2.0",
      downloadUrl: "https://example.com/setup.exe",
    };
    globalThis.ompStudioChrome = {
      checkAppUpdate: vi.fn().mockResolvedValue(mockInfo),
    } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;

    const result = await checkForAppUpdates();
    expect(result).toEqual(mockInfo);
    expect(getAppUpdateState().updateInfo).toEqual(mockInfo);
  });

  it("downloads and installs update package smoothly", async () => {
    const downloadAppUpdate = vi.fn().mockResolvedValue({ ok: true, filePath: "C:/temp/setup.exe" });
    const quitAndInstallUpdate = vi.fn().mockResolvedValue({ ok: true });

    globalThis.ompStudioChrome = {
      downloadAppUpdate,
      quitAndInstallUpdate,
    } as unknown as NonNullable<typeof globalThis.ompStudioChrome>;

    const success = await downloadAndInstallAppUpdate("https://example.com/setup.exe");
    expect(success).toBe(true);
    expect(downloadAppUpdate).toHaveBeenCalledWith("https://example.com/setup.exe");
    expect(quitAndInstallUpdate).toHaveBeenCalledWith("C:/temp/setup.exe");
  });
});
