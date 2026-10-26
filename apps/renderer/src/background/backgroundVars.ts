/**
 * 背景层与预览卡共用的 CSS 变量映射。
 *
 * 数值只在这里换算一次，真实背景层写到 `<html>`，预览卡写到自己的容器；
 * 两边因此永远画同一套结果。
 */

import type { BackgroundSettings } from "./backgroundSettings";

export const FOCUS_POSITION: Record<BackgroundSettings["focus"], string> = {
  center: "center",
  top: "center top",
  bottom: "center bottom",
  left: "left center",
  right: "right center",
};

export function backdropCssVars(
  settings: BackgroundSettings,
  scrim: number,
  strength: number,
): Record<string, string> {
  return {
    "--bd-shell": `${100 - strength}%`,
    "--bd-media-opacity": String(settings.opacity / 100),
    "--bd-scrim": String(scrim / 100),
    "--bd-blur": `${settings.blur}px`,
    "--bd-fit": settings.fit === "tile" ? "cover" : settings.fit,
    "--bd-focus": FOCUS_POSITION[settings.focus],
  };
}

export const BACKDROP_VARIABLES = [
  "--bd-shell",
  "--bd-media-opacity",
  "--bd-scrim",
  "--bd-blur",
  "--bd-fit",
  "--bd-focus",
] as const;
