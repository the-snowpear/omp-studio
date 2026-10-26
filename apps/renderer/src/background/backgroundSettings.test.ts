import { afterEach, describe, expect, it } from "vitest";

import {
  BACKGROUND_RESET_KEYS,
  BACKGROUND_STORAGE_KEY,
  DEFAULT_BACKGROUND_SETTINGS,
  __resetBackgroundSettingsForTests,
  mergeBackgroundSettings,
  normalizeBackgroundSettings,
  parseBackgroundSettings,
  readBackgroundSettings,
  writeBackgroundSettings,
} from "./backgroundSettings";

afterEach(() => {
  __resetBackgroundSettingsForTests(null);
});

describe("background settings", () => {
  it("returns defaults for missing or corrupt storage", () => {
    expect(parseBackgroundSettings(null)).toEqual(DEFAULT_BACKGROUND_SETTINGS);
    expect(parseBackgroundSettings("{not json")).toEqual(DEFAULT_BACKGROUND_SETTINGS);
    expect(parseBackgroundSettings("null")).toEqual(DEFAULT_BACKGROUND_SETTINGS);
  });

  it("clamps numbers and rejects unknown enums", () => {
    const parsed = parseBackgroundSettings(JSON.stringify({
      enabled: true,
      activeId: "preset:aurora",
      scope: "everywhere",
      opacity: 999,
      strength: -10,
      scrim: 3.6,
      blur: 999,
      fit: "stretch",
      focus: "middle",
      motion: "sometimes",
    }));
    expect(parsed.enabled).toBe(true);
    expect(parsed.scope).toBe(DEFAULT_BACKGROUND_SETTINGS.scope);
    expect(parsed.opacity).toBe(100);
    expect(parsed.strength).toBe(0);
    expect(parsed.scrim).toBe(4);
    expect(parsed.blur).toBe(60);
    expect(parsed.fit).toBe(DEFAULT_BACKGROUND_SETTINGS.fit);
    expect(parsed.focus).toBe(DEFAULT_BACKGROUND_SETTINGS.focus);
    expect(parsed.motion).toBe(DEFAULT_BACKGROUND_SETTINGS.motion);
  });

  it("merges a patch without mutating the current object", () => {
    const current = { ...DEFAULT_BACKGROUND_SETTINGS };
    const next = mergeBackgroundSettings(current, { opacity: 40, enabled: true });
    expect(next.opacity).toBe(40);
    expect(next.enabled).toBe(true);
    expect(current.opacity).toBe(DEFAULT_BACKGROUND_SETTINGS.opacity);
    expect(current.enabled).toBe(false);
  });

  it("persists and reads back through localStorage", () => {
    writeBackgroundSettings({ ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, scope: "app" });
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toContain("\"scope\":\"app\"");
    expect(readBackgroundSettings()).toMatchObject({ enabled: true, scope: "app" });
  });

  it("keeps the active asset and enable flag out of the reset key list", () => {
    expect(BACKGROUND_RESET_KEYS).not.toContain("activeId");
    expect(BACKGROUND_RESET_KEYS).not.toContain("enabled");
    expect(BACKGROUND_RESET_KEYS).toContain("strength");
  });

  it("normalizes untrusted input without throwing", () => {
    expect(() => normalizeBackgroundSettings(undefined)).not.toThrow();
    expect(() => normalizeBackgroundSettings(42)).not.toThrow();
    expect(normalizeBackgroundSettings("x").activeId).toBe(DEFAULT_BACKGROUND_SETTINGS.activeId);
  });
});
