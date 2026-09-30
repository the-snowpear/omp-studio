import { describe, expect, it, vi } from "vitest";

import { fileManagerName } from "../platformCopy";
import { MicrophoneDeniedError, ensureMicrophoneAccess } from "./microphoneAccess";

describe("microphone consent", () => {
  it("asks only on the macOS desktop, so capture elsewhere starts in the same tick", () => {
    const requestMicrophoneAccess = vi.fn(async () => "granted" as const);
    expect(ensureMicrophoneAccess(true, { platform: "win32", requestMicrophoneAccess })).toBeUndefined();
    expect(ensureMicrophoneAccess(true, undefined)).toBeUndefined();
    expect(ensureMicrophoneAccess(true, { platform: "darwin" })).toBeUndefined();
    expect(requestMicrophoneAccess).not.toHaveBeenCalled();
  });

  it("resolves when macOS grants and rejects with the settings hint when it denies", async () => {
    await expect(ensureMicrophoneAccess(false, { platform: "darwin", requestMicrophoneAccess: async () => "granted" })).resolves.toBeUndefined();
    const denied = ensureMicrophoneAccess(false, { platform: "darwin", requestMicrophoneAccess: async () => "denied" });
    await expect(denied).rejects.toBeInstanceOf(MicrophoneDeniedError);
    await expect(denied).rejects.toThrow(/System Settings/u);
  });
});

describe("file manager copy", () => {
  it("names Finder on macOS and keeps File Explorer everywhere else", () => {
    const t = (key: string) => key;
    expect(fileManagerName(t, "darwin")).toBe("shell.fileManagerMac");
    expect(fileManagerName(t, "win32")).toBe("shell.fileManagerWindows");
    expect(fileManagerName(t, "linux")).toBe("shell.fileManagerWindows");
  });
});
