// Locale helper shared across the site shell and interactive kit.
export type Locale = "zh" | "en";

export const isEn = (): boolean =>
  typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("en");

export const locale = (): Locale => (isEn() ? "en" : "zh");

export const t = <T>(zh: T, en: T): T => (isEn() ? en : zh);
