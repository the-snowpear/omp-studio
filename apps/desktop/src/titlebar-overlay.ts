/**
 * Native Windows caption-button overlay.
 * Colors stay in lockstep with renderer `.app-titlebar` (`--bg` / `--text`).
 * This file is Main-only: preload must not import it (sandbox).
 */
import { BrowserWindow, ipcMain, nativeTheme, type WebContents } from "electron";

import {
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_CHANNEL,
  TITLEBAR_OVERLAY_HEIGHT,
  type TitlebarTheme,
} from "./titlebar-overlay-shared.js";

export {
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_CHANNEL,
  TITLEBAR_OVERLAY_HEIGHT,
  type TitlebarTheme,
} from "./titlebar-overlay-shared.js";

export function applyTitleBarOverlay(
  window: { setTitleBarOverlay?(options: { color: string; symbolColor: string; height: number }): void; setBackgroundColor?(color: string): void },
  theme: TitlebarTheme,
): void {
  const colors = TITLEBAR_OVERLAY[theme];
  window.setTitleBarOverlay?.({ ...colors, height: TITLEBAR_OVERLAY_HEIGHT });
  window.setBackgroundColor?.(colors.color);
  nativeTheme.themeSource = theme;
}

export function parseTitlebarTheme(value: unknown): TitlebarTheme | undefined {
  if (!value || typeof value !== "object" || !("theme" in value)) return undefined;
  const theme = (value as { theme?: unknown }).theme;
  if (theme === "light" || theme === "dark") return theme;
  return undefined;
}

export function registerTitleBarOverlayIpc(options: {
  readonly isTrustedSender: (sender: Pick<WebContents, "isDestroyed" | "getURL">) => boolean;
}): () => void {
  ipcMain.removeHandler(TITLEBAR_OVERLAY_CHANNEL);
  ipcMain.handle(TITLEBAR_OVERLAY_CHANNEL, (event, payload: unknown) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return;
    const theme = parseTitlebarTheme(payload);
    if (theme === undefined) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return;
    applyTitleBarOverlay(window, theme);
  });
  return () => {
    ipcMain.removeHandler(TITLEBAR_OVERLAY_CHANNEL);
  };
}
