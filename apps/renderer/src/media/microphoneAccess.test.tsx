import { describe, expect, it, vi } from "vitest";

import { fileManagerName } from "../platformCopy";
import { MicrophoneDeniedError, ensureMicrophoneAccess, microphoneFailureMessage } from "./microphoneAccess";

describe("microphone consent", () => {
  it("asks only on the macOS desktop, so capture elsewhere starts in the same tick", () => {
    const requestMicrophoneAccess = vi.fn(async () => "granted" as const);
    expect(ensureMicrophoneAccess(true, { platform: "win32", requestMicrophoneAccess })).toBeUndefined();
    expect(ensureMicrophoneAccess(true, undefined)).toBeUndefined();
    expect(ensureMicrophoneAccess(true, { platform: "darwin" })).toBeUndefined();
    expect(requestMicrophoneAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "系统隐私设置", "system privacy settings"],
    ["NotFoundError", "没有找到所选麦克风", "not found"],
    ["NotReadableError", "其它应用占用", "another app"],
  ])("explains browser %s failures with a recovery action", (name, zh, en) => {
    const cause = new DOMException("Capture failed", name);
    expect(microphoneFailureMessage(cause, true)).toContain(zh);
    expect(microphoneFailureMessage(cause, false)).toContain(en);
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
