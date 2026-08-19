export type Locale = "zh" | "en";
export type AppLanguage = "system" | "zh" | "en";

export type TranslationParams = Record<string, string | number>;

export interface I18nContextValue {
  readonly language: AppLanguage;
  readonly resolvedLanguage: Locale;
  readonly t: (key: string, params?: TranslationParams) => string;
  readonly setLanguage: (language: AppLanguage) => void;
}
