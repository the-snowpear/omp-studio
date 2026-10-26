/**
 * 背景层：唯一把背景状态写到 DOM 的地方。
 *
 * - `visible` 同时受开关、作用范围、路由、透出强度与不透明度约束；不可见时
 *   卸载媒体元素（释放视频解码器），但 Provider 仍保留 object URL。
 * - 数值写到 `<html>` 的 `--bd-*` 上，结构壳 CSS 与预览卡共用同一组变量。
 * - 原生标题栏 tint 只在整个应用范围下发送；App 里不再有第二个 setTheme 调用。
 */

import { useEffect, useLayoutEffect } from "react";

import { useBackground } from "./BackgroundProvider";
import { BackgroundMedia } from "./BackgroundMedia";
import { titlebarTint, type BackgroundTheme } from "./backgroundTint";
import { BACKDROP_VARIABLES, backdropCssVars } from "./backgroundVars";

export function AppBackgroundLayer({
  route,
  theme,
}: {
  readonly route: string;
  readonly theme: BackgroundTheme;
}) {
  const background = useBackground();
  const {
    activeAsset,
    activeAvgColor,
    activeUrl,
    effectiveScrim,
    reducedMotion,
    reducedTransparency,
    settings,
  } = background;

  const strength = reducedTransparency ? Math.min(settings.strength, 10) : settings.strength;
  const visible = settings.enabled
    && activeAsset !== undefined
    && (settings.scope === "app" || route === "workbench")
    && strength > 0
    && settings.opacity > 0;
  const motion = settings.motion === "on" || (settings.motion === "auto" && !reducedMotion);

  useLayoutEffect(() => {
    if (!visible) return undefined;
    const root = document.documentElement;
    const variables = backdropCssVars(settings, effectiveScrim, strength);
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    root.dataset.backdrop = "on";
    root.dataset.backdropScope = settings.scope;
    return () => {
      delete root.dataset.backdrop;
      delete root.dataset.backdropScope;
      for (const name of BACKDROP_VARIABLES) root.style.removeProperty(name);
    };
  }, [effectiveScrim, settings, strength, visible]);

  useEffect(() => {
    const chrome = globalThis.ompStudioChrome;
    const tint = visible && settings.scope === "app" && activeAvgColor !== undefined
      ? titlebarTint(theme, activeAvgColor)
      : undefined;
    void chrome?.setTheme?.(theme, tint);
  }, [activeAvgColor, settings.scope, theme, visible]);

  if (!visible || activeAsset === undefined) return null;

  return (
    <div className="app-backdrop" data-backdrop-kind={activeAsset.kind} aria-hidden="true">
      <BackgroundMedia asset={activeAsset} url={activeUrl} settings={settings} motion={motion} />
      <div className="app-backdrop-scrim" />
    </div>
  );
}
