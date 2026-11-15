/**
 * Desktop UI language constants, active state, and payload parser.
 *
 * Pure TypeScript (no Electron or Node runtime imports), so preload, Main
 * services, remote helpers, and headless tests can all share it safely.
 */
export const DESKTOP_LANGUAGE_CHANNEL = "omp-studio:desktop:language";

export type DesktopLocale = "zh" | "en";

let currentLocale: DesktopLocale = normalizeDesktopLocale(
  typeof process !== "undefined" ? process.env.OMP_STUDIO_LOCALE : undefined,
);
const listeners = new Set<(locale: DesktopLocale) => void>();

export function normalizeDesktopLocale(locale: string | undefined | null): DesktopLocale {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function parseDesktopLanguagePayload(value: unknown): DesktopLocale | undefined {
  if (value === "zh" || value === "en") return value;
  if (value !== null && typeof value === "object" && "locale" in value) {
    const raw = (value as { locale?: unknown }).locale;
    if (raw === "zh" || raw === "en") return raw;
  }
  return undefined;
}

export function initDesktopLanguage(osLocale: string | undefined): DesktopLocale {
  const override = typeof process !== "undefined" ? process.env.OMP_STUDIO_LOCALE : undefined;
  currentLocale = normalizeDesktopLocale(override && override.length > 0 ? override : osLocale);
  if (typeof process !== "undefined" && process.env) process.env.OMP_STUDIO_LOCALE = currentLocale;
  return currentLocale;
}

export function getDesktopLanguage(): DesktopLocale {
  return currentLocale;
}

export function isDesktopZh(): boolean {
  return currentLocale === "zh";
}

export function desktopText<T>(zh: T, en: T): T {
  return currentLocale === "zh" ? zh : en;
}

export function setDesktopLanguage(next: DesktopLocale): boolean {
  if (next === currentLocale) {
    if (typeof process !== "undefined" && process.env) process.env.OMP_STUDIO_LOCALE = currentLocale;
    return false;
  }
  currentLocale = next;
  if (typeof process !== "undefined" && process.env) process.env.OMP_STUDIO_LOCALE = currentLocale;
  for (const listener of [...listeners]) listener(currentLocale);
  return true;
}

export function onDesktopLanguageChange(listener: (locale: DesktopLocale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
