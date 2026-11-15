import { createElement } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { detectSystemLanguage, formatTranslation, I18nProvider, resolveLanguage, translate } from "./I18nContext";
import { zh } from "./locales/zh";
import { en } from "./locales/en";

describe("i18n system tests", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it("detects Chinese when navigator.language starts with zh", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "zh-CN", languages: ["zh-CN", "zh"] },
      configurable: true,
      writable: true,
    });
    expect(detectSystemLanguage()).toBe("zh");
    expect(resolveLanguage("system")).toBe("zh");
  });

  it("detects English when navigator.language is English or other", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "en-US", languages: ["en-US", "en"] },
      configurable: true,
      writable: true,
    });
    expect(detectSystemLanguage()).toBe("en");
    expect(resolveLanguage("system")).toBe("en");

    Object.defineProperty(globalThis, "navigator", {
      value: { language: "ja-JP", languages: ["ja-JP"] },
      configurable: true,
      writable: true,
    });
    expect(detectSystemLanguage()).toBe("en");
  });

  it("explicit language setting overrides system language", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "zh-CN" },
      configurable: true,
      writable: true,
    });
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("zh")).toBe("zh");

    Object.defineProperty(globalThis, "navigator", {
      value: { language: "en-US" },
      configurable: true,
      writable: true,
    });
    expect(resolveLanguage("zh")).toBe("zh");
    expect(resolveLanguage("en")).toBe("en");
  });

  it("formats template parameters properly", () => {
    expect(formatTranslation("Hello {name}, you have {count} items", { name: "Alice", count: 3 })).toBe(
      "Hello Alice, you have 3 items",
    );
    expect(formatTranslation("No params")).toBe("No params");
  });

  it("translates keys for Chinese and English", () => {
    expect(translate("zh", "common.save")).toBe("保存");
    expect(translate("en", "common.save")).toBe("Save");
    expect(translate("zh", "settings.general.title")).toBe("常规");
    expect(translate("en", "settings.general.title")).toBe("General");
    expect(translate("zh", "history.messagesCount", { count: 5 })).toBe("5 条消息");
    expect(translate("en", "history.messagesCount", { count: 5 })).toBe("5 messages");
  });

  it("gracefully falls back when key is missing", () => {
    expect(translate("zh", "nonexistent.key.path")).toBe("nonexistent.key.path");
  });

  it("keeps complete key parity, matching placeholders, and no unexpected CJK in English locale", () => {
    const flatten = (obj: Record<string, unknown>, prefix = "", out = new Map<string, string>()): Map<string, string> => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
        else out.set(key, String(v));
      }
      return out;
    };
    const placeholders = (text: string): string => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");

    const zhMap = flatten(zh as unknown as Record<string, unknown>);
    const enMap = flatten(en as unknown as Record<string, unknown>);
    expect([...zhMap.keys()].filter(k => !enMap.has(k))).toEqual([]);
    expect([...enMap.keys()].filter(k => !zhMap.has(k))).toEqual([]);

    const allowedEnglishCjkKeys = new Set(["settings.general.langZh"]);
    const cjkFailures = [...enMap.entries()]
      .filter(([k, v]) => !allowedEnglishCjkKeys.has(k) && /[\u4e00-\u9fff]/.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(cjkFailures).toEqual([]);

    const placeholderMismatches = [...zhMap.entries()]
      .filter(([k, zv]) => placeholders(zv) !== placeholders(enMap.get(k) ?? ""))
      .map(([k, zv]) => `${k} (${placeholders(zv)} vs ${placeholders(enMap.get(k) ?? "")})`);
    expect(placeholderMismatches).toEqual([]);
  });

  it("syncs html lang, title, and desktop chrome language from I18nProvider", async () => {
    const setLanguage = vi.fn(async () => undefined);
    const originalChrome = globalThis.ompStudioChrome;
    globalThis.ompStudioChrome = { ...(originalChrome ?? {}), setLanguage } as typeof globalThis.ompStudioChrome;
    try {
      const { rerender } = render(createElement(I18nProvider, { forcedLanguage: "en", children: createElement("span", null, "en") }));
      expect(document.documentElement.lang).toBe("en");
      expect(document.title).toBe("OMP Studio — Workbench");
      expect(setLanguage).not.toHaveBeenCalled();

      rerender(createElement(I18nProvider, { forcedLanguage: "zh", children: createElement("span", null, "zh") }));
      expect(document.documentElement.lang).toBe("zh-CN");
      expect(document.title).toBe("OMP Studio — 工作台");

      Object.defineProperty(globalThis, "navigator", { value: { language: "en-US", languages: ["en-US"] }, configurable: true, writable: true });
      render(createElement(I18nProvider, { children: createElement("span", null, "sys") }));
      await waitFor(() => expect(setLanguage).toHaveBeenCalledWith("en"));
    } finally {
      globalThis.ompStudioChrome = originalChrome;
    }
  });
});
