/**
 * 设置页顶部的效果预览卡。
 *
 * 用和真实背景层完全相同的媒体渲染与 CSS 变量；顶部/侧栏/输入区的透明度由
 * `--bd-shell` 系列驱动，所以拖动滑杆时这里能立刻看出「结构壳透出、卡片仍
 * 不透明」的差别。
 */

import type { CSSProperties } from "react";

import { useI18n } from "../i18n";
import { BackgroundMedia } from "./BackgroundMedia";
import type { BackgroundAsset } from "./backgroundLibrary";
import type { BackgroundSettings } from "./backgroundSettings";
import type { BackgroundTheme } from "./backgroundTint";
import { backgroundAssetKindKey, backgroundAssetName } from "./backgroundLabels";
import { backdropCssVars } from "./backgroundVars";

export function BackgroundPreview({
  asset,
  url,
  settings,
  scrim,
  strength,
  motion,
  enabled,
}: {
  readonly asset: BackgroundAsset | undefined;
  readonly url: string | null;
  readonly settings: BackgroundSettings;
  readonly scrim: number;
  readonly strength: number;
  readonly motion: boolean;
  readonly enabled: boolean;
}) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const style = backdropCssVars(settings, scrim, strength) as CSSProperties;
  const scopeLabel = settings.scope === "app"
    ? t("settings.background.scopeApp")
    : t("settings.background.scopeWorkbench");

  return (
    <div className="bg-preview">
      <div className="bg-preview-stage" style={style}>
        {asset === undefined
          ? <div className="bg-media bg-media-empty" />
          : <BackgroundMedia asset={asset} url={url} settings={settings} motion={motion} />}
        <div className="app-backdrop-scrim" />
        <div className="bg-preview-ui" aria-hidden="true">
          <div className="bg-preview-topbar" />
          <div className="bg-preview-body">
            {settings.scope === "app" ? <div className="bg-preview-sidebar" /> : null}
            <div className="bg-preview-main">
              <div className="bg-preview-bubble">{t("settings.background.previewBubble")}</div>
              <div className="bg-preview-composer" />
            </div>
          </div>
        </div>
        {enabled ? null : <div className="bg-preview-disabled">{t("settings.background.previewDisabled")}</div>}
      </div>
      <div className="bg-preview-caption">
        <span>{asset === undefined ? t("settings.background.notSet") : backgroundAssetName(asset, zh)}</span>
        <span className="spacer" />
        {asset === undefined ? null : <span>{t(`settings.background.${backgroundAssetKindKey(asset)}`)}</span>}
        <span aria-hidden="true">·</span>
        <span>{scopeLabel}</span>
      </div>
    </div>
  );
}
