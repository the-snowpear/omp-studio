import { createContext, useContext, useMemo, type ReactNode } from "react";
import { zh } from "./locales/zh";
import { en } from "./locales/en";
import type { AppLanguage, I18nContextValue, Locale, TranslationParams } from "./types";
import { useAppSettings } from "../settings/appSettings";

const dictionaries: Record<Locale, typeof zh> = {
  zh,
  en,
};

export function detectSystemLanguage(): Locale {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    const lang = (nav?.language || (nav?.languages && nav.languages[0]) || "").toLowerCase();
    if (lang.startsWith("zh")) {
      return "zh";
    }
    if (lang.startsWith("en")) {
      return "en";
    }
  } catch {
    /* fallback to English if navigator is not accessible */
  }
  return "en";
}

export function resolveLanguage(preference?: AppLanguage): Locale {
  if (preference === "zh" || preference === "en") {
    return preference;
  }
  return detectSystemLanguage();
}

function lookupKey(dict: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

export function formatTranslation(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in params ? String(params[key]) : match;
  });
}

export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  const dict = dictionaries[locale] ?? dictionaries.en;
  const direct = lookupKey(dict as unknown as Record<string, unknown>, key);
  if (direct !== undefined) {
    return formatTranslation(direct, params);
  }
  // Fallback to zh or en
  const fallbackDict = locale === "zh" ? dictionaries.en : dictionaries.zh;
  const fallback = lookupKey(fallbackDict as unknown as Record<string, unknown>, key);
  if (fallback !== undefined) {
    return formatTranslation(fallback, params);
  }
  // If key not found at all, return the key itself
  return key;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, forcedLanguage }: { children: ReactNode; forcedLanguage?: AppLanguage }) {
  const { settings, update } = useAppSettings();
  const language = forcedLanguage ?? settings.language;
  const resolvedLanguage = resolveLanguage(language);

  const value = useMemo<I18nContextValue>(() => {
    return {
      language,
      resolvedLanguage,
      t: (key: string, params?: TranslationParams) => translate(resolvedLanguage, key, params),
      setLanguage: (next: AppLanguage) => update({ language: next }),
    };
  }, [language, resolvedLanguage, update]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context !== null) {
    return context;
  }
  // Fallback when used outside provider
  const resolvedLanguage = detectSystemLanguage();
  return {
    language: "system",
    resolvedLanguage,
    t: (key: string, params?: TranslationParams) => translate(resolvedLanguage, key, params),
    setLanguage: () => undefined,
  };
}
