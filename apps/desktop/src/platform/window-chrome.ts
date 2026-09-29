/**
 * Title bar per platform.
 *
 * Windows draws colored caption buttons in a Window Controls Overlay on the
 * right. macOS keeps its traffic lights on the left: the title bar is hidden,
 * the overlay only reserves the bar height so the renderer's
 * `env(titlebar-area-*)` CSS still describes the free area, and the lights are
 * centred in the bar. Only Windows and Linux can recolor the overlay.
 */
import { TITLEBAR_OVERLAY, TITLEBAR_OVERLAY_HEIGHT, type TitlebarTheme } from "../titlebar-overlay-shared.js";

/** macOS traffic lights are 12 px discs; centre them vertically in the bar. Calibrate on a real Mac. */
export const TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 14, y: Math.round((TITLEBAR_OVERLAY_HEIGHT - 12) / 2) });

export type WindowChromeOptions =
  | {
      readonly titleBarStyle: "hidden";
      readonly titleBarOverlay: { readonly color: string; readonly symbolColor: string; readonly height: number };
    }
  | {
      readonly titleBarStyle: "hidden";
      readonly titleBarOverlay: { readonly height: number };
      readonly trafficLightPosition: { readonly x: number; readonly y: number };
    };

export function windowChromeOptions(platform: NodeJS.Platform, theme: TitlebarTheme = "light"): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { height: TITLEBAR_OVERLAY_HEIGHT },
      trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
    };
  }
  const colors = TITLEBAR_OVERLAY[theme];
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: colors.color, symbolColor: colors.symbolColor, height: TITLEBAR_OVERLAY_HEIGHT },
  };
}

/** `setTitleBarOverlay` colors caption buttons; macOS has none to color. */
export function canRecolorTitleBarOverlay(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}
