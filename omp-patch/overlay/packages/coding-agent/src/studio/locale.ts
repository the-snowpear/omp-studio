/**
 * Dynamic locale helper for Studio's Coding Agent runtime overlay.
 * Evaluates OMP_STUDIO_LOCALE per call and defaults to English when unset.
 */
export function isRuntimeLocaleZh(): boolean {
	return (process.env.OMP_STUDIO_LOCALE ?? "").toLowerCase().startsWith("zh");
}

export function runtimeText(zh: string, en: string): string {
	return isRuntimeLocaleZh() ? zh : en;
}

export function setRuntimeLocale(locale: "zh" | "en"): void {
	process.env.OMP_STUDIO_LOCALE = locale;
}
