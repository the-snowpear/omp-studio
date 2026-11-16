/**
 * Dynamic locale helper for @omp-studio/host-client-api.
 * Evaluates OMP_STUDIO_LOCALE per call so Desktop Main updates take effect
 * immediately without restarting in-process adapters; defaults to English.
 */
export function isHostLocaleZh(): boolean {
  return (process.env.OMP_STUDIO_LOCALE ?? "").toLowerCase().startsWith("zh");
}

export function hostText(zh: string, en: string): string {
  return isHostLocaleZh() ? zh : en;
}
