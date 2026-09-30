import { describe, expect, it } from "vitest";

import { detectPlatform, nativeMenuOwnsShortcuts } from "../platform";
import { SHORTCUTS, formatShortcut, isPrimaryModifier, shortcutSearchText } from "./shortcuts";

describe("platform shortcuts", () => {
  it("keeps the Windows labels exactly as the menus spelled them", () => {
    expect(formatShortcut(SHORTCUTS.newChat, "kbd", "win32")).toBe("Ctrl ⇧ O");
    expect(formatShortcut(SHORTCUTS.commandPalette, "kbd", "win32")).toBe("Ctrl K");
    expect(formatShortcut(SHORTCUTS.redo, "kbd", "win32")).toBe("Ctrl Y");
    expect(formatShortcut(SHORTCUTS.skills, "hint", "win32")).toBe("Ctrl+Shift+K");
    expect(formatShortcut(SHORTCUTS.followUp, "hint", "win32")).toBe("Ctrl+Enter");
  });

  it("uses macOS symbols and the macOS redo", () => {
    expect(formatShortcut(SHORTCUTS.newChat, "kbd", "darwin")).toBe("⇧⌘O");
    expect(formatShortcut(SHORTCUTS.commandPalette, "hint", "darwin")).toBe("⌘K");
    expect(formatShortcut(SHORTCUTS.redo, "kbd", "darwin")).toBe("⇧⌘Z");
    expect(formatShortcut(SHORTCUTS.followUp, "hint", "darwin")).toBe("⌘↩");
  });

  it("macOS reacts to ⌘ only, leaving Ctrl to text editing; Windows keeps Ctrl or Meta", () => {
    expect(isPrimaryModifier({ ctrlKey: false, metaKey: true }, "darwin")).toBe(true);
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: false }, "darwin")).toBe(false);
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: true }, "darwin")).toBe(false);
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: false }, "win32")).toBe(true);
    expect(isPrimaryModifier({ ctrlKey: false, metaKey: true }, "win32")).toBe(true);
    expect(isPrimaryModifier({ ctrlKey: false, metaKey: false }, "win32")).toBe(false);
  });

  it("palette search matches either spelling", () => {
    const text = shortcutSearchText(SHORTCUTS.newChat).toLowerCase();
    expect(text).toContain("ctrl+shift+o");
    expect(text).toContain("⇧⌘o");
    expect(text).toContain("cmd");
  });
});

describe("renderer platform", () => {
  it("trusts the desktop preload, then the browser report", () => {
    expect(detectPlatform({ platform: "darwin" }, { platform: "Win32" })).toBe("darwin");
    expect(detectPlatform(undefined, { userAgentData: { platform: "macOS" } })).toBe("darwin");
    expect(detectPlatform(undefined, { platform: "MacIntel" })).toBe("darwin");
    expect(detectPlatform(undefined, { platform: "Win32" })).toBe("win32");
    expect(detectPlatform(undefined, { platform: "Linux x86_64" })).toBe("linux");
    expect(detectPlatform(undefined, undefined)).toBe("linux");
  });

  it("only the desktop app on macOS has a menu bar that owns the shortcuts", () => {
    expect(nativeMenuOwnsShortcuts({ platform: "darwin" })).toBe(true);
    expect(nativeMenuOwnsShortcuts({ platform: "win32" })).toBe(false);
    expect(nativeMenuOwnsShortcuts(undefined)).toBe(false);
  });
});
