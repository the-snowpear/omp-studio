/**
 * Caption-button overlay constants shared by Main and the sandboxed preload.
 * No Electron Main APIs — preload may import this file.
 */
export const TITLEBAR_OVERLAY_CHANNEL = "omp-studio:desktop:chrome-theme";
export const TITLEBAR_OVERLAY_HEIGHT = 36;

/** Matches renderer tokens: light `--bg/#fbfbfc` `--text/#1d2129`; dark `--bg/#121519` `--text/#e7e8eb`. */
export const TITLEBAR_OVERLAY = {
  light: { color: "#fbfbfc", symbolColor: "#1d2129" },
  dark: { color: "#121519", symbolColor: "#e7e8eb" },
} as const;

export type TitlebarTheme = keyof typeof TITLEBAR_OVERLAY;
