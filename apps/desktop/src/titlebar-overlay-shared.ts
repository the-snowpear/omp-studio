/**
 * Caption-button overlay constants shared by Main and the sandboxed preload.
 * No Electron Main APIs — preload may import this file.
 *
 * The renderer may accompany the theme with an optional caption tint derived
 * from the active background's average colour. Main validates both colours
 * and falls back to the stock theme palette when anything is off.
 */
export const TITLEBAR_OVERLAY_CHANNEL = "omp-studio:desktop:chrome-theme";
export const TITLEBAR_OVERLAY_HEIGHT = 36;

/** Matches renderer tokens: light `--bg/#fbfbfc` `--text/#1d2129`; dark `--bg/#121519` `--text/#e7e8eb`. */
export const TITLEBAR_OVERLAY = {
  light: { color: "#fbfbfc", symbolColor: "#1d2129" },
  dark: { color: "#121519", symbolColor: "#e7e8eb" },
} as const;

export type TitlebarTheme = keyof typeof TITLEBAR_OVERLAY;

export interface TitlebarTint {
  readonly color: string;
  readonly symbolColor: string;
}

export interface TitlebarThemePayload {
  readonly theme: TitlebarTheme;
  readonly tint?: TitlebarTint;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function parseTint(value: unknown): TitlebarTint | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { color?: unknown; symbolColor?: unknown };
  if (!isHexColor(record.color) || !isHexColor(record.symbolColor)) return undefined;
  return { color: record.color, symbolColor: record.symbolColor };
}

/** Parses the renderer payload; an invalid tint is dropped, an invalid theme rejects. */
export function parseTitlebarThemePayload(value: unknown): TitlebarThemePayload | undefined {
  if (value === null || typeof value !== "object" || !("theme" in value)) return undefined;
  const theme = (value as { theme?: unknown }).theme;
  if (theme !== "light" && theme !== "dark") return undefined;
  const tint = parseTint((value as { tint?: unknown }).tint);
  return tint === undefined ? { theme } : { theme, tint };
}
