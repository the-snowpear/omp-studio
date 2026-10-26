import type { AppSettings } from "./appSettings";
import { resetRowHeightCache } from "../conversation/rowHeightCache";

export const TYPOGRAPHY_BEFORE_CHANGE = "omp-typography-before-change";
export const TYPOGRAPHY_CHANGE = "omp-typography-change";

export const FONT_SETTINGS_KEYS = [
  "uiFontFamily", "uiFontSize", "terminalFontFamily", "terminalFontSize", "outputFontFamily", "outputFontSize",
] as const satisfies readonly (keyof AppSettings)[];

/** Treat a user-entered name as one CSS string, including names containing quotes. */
export function fontFamilyStack(family: string, fallback: string): string {
  return family.trim() ? `${JSON.stringify(family.trim())}, ${fallback}` : fallback;
}

export function typographyStyles(settings: AppSettings): Record<string, string> {
  return {
    "--font-ui": fontFamilyStack(settings.uiFontFamily, "var(--font-ui-default)"),
    "--font-terminal": fontFamilyStack(settings.terminalFontFamily, "var(--font-mono-default)"),
    "--font-output": fontFamilyStack(settings.outputFontFamily, "var(--font-ui-default)"),
    "--font-output-code": fontFamilyStack(settings.outputFontFamily, "var(--font-mono-default)"),
    "--ui-font-scale": String(settings.uiFontSize / 14),
    "--output-font-scale": String(settings.outputFontSize / 14),
    "--terminal-font-size": `${settings.terminalFontSize}px`,
  };
}

let appliedLayoutKey: string | undefined;

/** Shared by the pre-mount entry and live settings; terminal-only edits do not remeasure conversations. */
export function applyTypography(settings: AppSettings): void {
  const layoutKey = JSON.stringify([settings.uiFontFamily, settings.uiFontSize, settings.outputFontFamily, settings.outputFontSize]);
  const changed = appliedLayoutKey !== undefined && appliedLayoutKey !== layoutKey;
  if (changed) window.dispatchEvent(new Event(TYPOGRAPHY_BEFORE_CHANGE));
  if (changed) resetRowHeightCache();
  const root = document.documentElement;
  for (const [name, value] of Object.entries(typographyStyles(settings))) root.style.setProperty(name, value);
  appliedLayoutKey = layoutKey;
  if (changed) window.dispatchEvent(new Event(TYPOGRAPHY_CHANGE));
}

type LocalFontWindow = Window & { queryLocalFonts?: () => Promise<readonly { family: string }[]> };
let localFamilies: readonly string[] | undefined;

export function cachedFontFamilies(): readonly string[] | undefined {
  return localFamilies;
}

/** Invoke directly from a click handler to preserve the browser's user activation. */
export async function loadFontFamilies(): Promise<readonly string[]> {
  const fonts = await (window as LocalFontWindow).queryLocalFonts!();
  localFamilies = [...new Set(fonts.map(font => font.family))].sort((a, b) => a.localeCompare(b));
  return localFamilies;
}

export function canLoadFontFamilies(): boolean {
  return typeof (window as LocalFontWindow).queryLocalFonts === "function";
}
