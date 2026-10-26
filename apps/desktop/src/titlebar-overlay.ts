/**
 * Native Windows caption-button overlay. macOS keeps its traffic lights, so
 * only the window background and native theme follow the renderer there.
 * Colors stay in lockstep with renderer `.app-titlebar` (`--bg` / `--text`)
 * unless the renderer sends a background-derived tint.
 * This file is Main-only: preload must not import it (sandbox).
 */
import { BrowserWindow, ipcMain, nativeTheme, type WebContents } from "electron";

import {
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_CHANNEL,
  TITLEBAR_OVERLAY_HEIGHT,
  parseTitlebarThemePayload,
  type TitlebarTheme,
  type TitlebarThemePayload,
} from "./titlebar-overlay-shared.js";
import { canRecolorTitleBarOverlay } from "./platform/window-chrome.js";

export {
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_CHANNEL,
  TITLEBAR_OVERLAY_HEIGHT,
  isHexColor,
  parseTitlebarThemePayload,
  type TitlebarTheme,
  type TitlebarThemePayload,
  type TitlebarTint,
} from "./titlebar-overlay-shared.js";

export function applyTitleBarOverlay(
  window: { setTitleBarOverlay?(options: { color: string; symbolColor: string; height: number }): void; setBackgroundColor?(color: string): void },
  payload: TitlebarThemePayload,
  platform: NodeJS.Platform = process.platform,
): void {
  const colors = payload.tint ?? TITLEBAR_OVERLAY[payload.theme];
  if (canRecolorTitleBarOverlay(platform)) window.setTitleBarOverlay?.({ ...colors, height: TITLEBAR_OVERLAY_HEIGHT });
  window.setBackgroundColor?.(colors.color);
  nativeTheme.themeSource = payload.theme;
}

export function registerTitleBarOverlayIpc(options: {
  readonly isTrustedSender: (sender: Pick<WebContents, "isDestroyed" | "getURL">) => boolean;
}): () => void {
  ipcMain.removeHandler(TITLEBAR_OVERLAY_CHANNEL);
  ipcMain.handle(TITLEBAR_OVERLAY_CHANNEL, (event, rawPayload: unknown) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return;
    const payload = parseTitlebarThemePayload(rawPayload);
    if (payload === undefined) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return;
    applyTitleBarOverlay(window, payload);
  });
  return () => {
    ipcMain.removeHandler(TITLEBAR_OVERLAY_CHANNEL);
  };
}
