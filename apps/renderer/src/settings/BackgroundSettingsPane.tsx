/**
 * 设置 → 背景。
 *
 * 只改本机显示行为：图库、参数、预览卡都通过 `useBackground()` 的 Provider
 * 读写，不调 Host、不写 client-contract。滑杆使用「拖动只更新草稿、松手才
 * 提交」的语义，避免一次拖动产生几十次存储写入与工作台重渲染。
 */

import { useEffect, useRef, useState, type DragEvent } from "react";

import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { useBackground } from "../background/BackgroundProvider";
import { BackgroundPreview } from "../background/BackgroundPreview";
import {
  BACKGROUND_LIMITS,
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundSettings,
} from "../background/backgroundSettings";
import { autoScrim, estimateReadability } from "../background/backgroundTint";
import {
  backgroundAssetKindKey,
  backgroundAssetName,
  formatBackgroundBytes,
  formatBackgroundDuration,
} from "../background/backgroundLabels";
import type { BackgroundAsset } from "../background/backgroundLibrary";
import { SettingRow, SettingSection, Slider, Switch, type SettingSource } from "./SettingRow";
import type { SettingsCtl } from "./tabs";

const BACKGROUND_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/apng,video/mp4,video/webm,video/ogg,video/quicktime";

interface SliderDraft {
  readonly opacity: number;
  readonly strength: number;
  readonly scrim: number;
  readonly blur: number;
}

function sourceFor<K extends keyof BackgroundSettings>(settings: BackgroundSettings, key: K): SettingSource {
  return settings[key] === DEFAULT_BACKGROUND_SETTINGS[key] ? "default" : "user";
}

function AssetTile({
  asset,
  active,
  disabled,
  onActivate,
  onRemove,
}: {
  readonly asset: BackgroundAsset;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onActivate: () => void;
  readonly onRemove: () => void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const name = backgroundAssetName(asset, resolvedLanguage === "zh");
  return (
    <div className={`bg-tile${active ? " is-active" : ""}`}>
      <button
        type="button"
        className="bg-tile-main"
        aria-pressed={active}
        aria-label={name}
        onClick={onActivate}
        disabled={disabled}
      >
        <span className="bg-tile-thumb">
          {asset.presetCss === undefined ? null : (
            <span className="bg-tile-preset" style={{ background: asset.presetCss }} />
          )}
          {asset.presetCss === undefined && asset.thumbDataUrl !== undefined ? (
            <img src={asset.thumbDataUrl} alt="" loading="lazy" draggable={false} />
          ) : null}
          {asset.presetCss === undefined && asset.thumbDataUrl === undefined ? (
            <span className="bg-tile-fallback"><Icon name={asset.kind === "video" ? "play" : "image"} /></span>
          ) : null}
        </span>
        <span className="bg-tile-meta">
          <span className="bg-tile-name" title={name}>{name}</span>
          <span className="bg-tile-kind">{t(`settings.background.${backgroundAssetKindKey(asset)}`)}</span>
        </span>
      </button>
      {active ? (
        <span className="bg-tile-active"><Icon name="check" extra="sm" />{t("settings.background.activeLabel")}</span>
      ) : null}
      {asset.source !== "upload" ? null : confirming ? (
        <div className="bg-tile-confirm">
          <button type="button" className="btn small" onClick={() => { setConfirming(false); onRemove(); }}>
            {t("common.delete")}
          </button>
          <button type="button" className="btn small outline" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="bg-tile-remove"
          aria-label={`${t("settings.background.remove")}: ${name}`}
          data-tip={t("settings.background.remove")}
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" extra="sm" />
        </button>
      )}
    </div>
  );
}

export function BackgroundSettingsPane({
  ctl,
  visible,
  onDemoAction,
}: {
  readonly ctl: SettingsCtl;
  readonly visible: boolean;
  readonly onDemoAction?: () => void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const background = useBackground();
  const {
    settings,
    presets,
    uploads,
    activeAsset,
    activeAvgColor,
    activeUrl,
    reducedMotion,
    reducedTransparency,
    loading,
    storageAvailable,
    importing,
    errors,
    notice,
    usageBytes,
    actions,
    theme,
  } = background;
  const preview = ctl.preview;
  const zh = resolvedLanguage === "zh";
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [draft, setDraft] = useState<SliderDraft>(() => ({
    opacity: settings.opacity,
    strength: settings.strength,
    scrim: settings.scrim,
    blur: settings.blur,
  }));

  useEffect(() => {
    setDraft({
      opacity: settings.opacity,
      strength: settings.strength,
      scrim: settings.scrim,
      blur: settings.blur,
    });
  }, [settings.opacity, settings.blur, settings.scrim, settings.strength]);

  const effectiveStrength = reducedTransparency ? Math.min(draft.strength, 10) : draft.strength;
  const previewScrim = settings.scrimAuto && activeAvgColor !== undefined
    ? autoScrim(theme, {
      opacity: draft.opacity,
      strength: effectiveStrength,
      avgColor: activeAvgColor,
    })
    : draft.scrim;
  const motion = settings.motion === "on" || (settings.motion === "auto" && !reducedMotion);
  const readability = activeAsset === undefined
    ? undefined
    : estimateReadability({
      opacity: draft.opacity,
      strength: effectiveStrength,
      scrim: previewScrim,
      avgColor: activeAvgColor ?? activeAsset.avgColor,
    }, theme);
  const lowContrast = readability !== undefined && readability < 4.5 && settings.enabled;
  const activeName = activeAsset === undefined ? undefined : backgroundAssetName(activeAsset, zh);
  const activeDuration = activeAsset === undefined ? undefined : formatBackgroundDuration(activeAsset.durationMs);

  const commitOpacity = (): void => actions.set({ opacity: draft.opacity });
  const commitStrength = (): void => actions.set({ strength: draft.strength });
  const commitScrim = (): void => actions.set({ scrim: draft.scrim });
  const commitBlur = (): void => actions.set({ blur: draft.blur });

  const reset = (): void => {
    actions.resetParams();
    setDraft({
      opacity: DEFAULT_BACKGROUND_SETTINGS.opacity,
      strength: DEFAULT_BACKGROUND_SETTINGS.strength,
      scrim: DEFAULT_BACKGROUND_SETTINGS.scrim,
      blur: DEFAULT_BACKGROUND_SETTINGS.blur,
    });
    onDemoAction?.();
  };

  const importFiles = (files: FileList | readonly File[] | null): void => {
    if (files === null) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    void actions.importFiles(list);
  };

  const openPicker = (): void => {
    fileRef.current?.click();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (storageAvailable === false) return;
    importFiles(event.dataTransfer.files);
  };

  const importBlocked = storageAvailable === false;

  return (
    <>
      <h3>
        {t("settings.background.title")}
        {preview ? <span className="chip amber xs demo-chip">{t("common.demo")}</span> : null}
      </h3>
      <p className="desc">{t("settings.background.desc")}</p>
      <div className="set-toolbar">
        <button
          type="button"
          className="btn small outline"
          disabled={preview}
          data-tip={preview ? t("common.preview") : t("common.resetDefaults")}
          onClick={reset}
        >
          {t("common.resetDefaults")}
        </button>
      </div>

      <SettingSection title={t("settings.background.sectionSource")}>
        <SettingRow
          label={t("settings.background.enable")}
          desc={t("settings.background.enableDesc")}
          source={settings.enabled ? "user" : "default"}
        >
          <Switch
            checked={settings.enabled}
            onChange={actions.toggleEnabled}
            label={t("settings.background.enable")}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.background.scope")}
          desc={t("settings.background.scopeDesc")}
          source={sourceFor(settings, "scope")}
        >
          <AppSelect
            className="select"
            value={settings.scope}
            aria-label={t("settings.background.scope")}
            onChange={(event) => actions.set({ scope: event.target.value as BackgroundSettings["scope"] })}
          >
            <option value="workbench">{t("settings.background.scopeWorkbench")}</option>
            <option value="app">{t("settings.background.scopeApp")}</option>
          </AppSelect>
        </SettingRow>

        {visible ? (
          <BackgroundPreview
            asset={activeAsset}
            url={activeUrl}
            settings={settings}
            scrim={previewScrim}
            strength={effectiveStrength}
            motion={motion}
            enabled={settings.enabled}
          />
        ) : null}

        <div className="bg-summary">
          <span>
            {t("settings.background.current")}：
            <b>{activeName ?? t("settings.background.notSet")}</b>
          </span>
          {activeAsset === undefined ? null : (
            <span>{t(`settings.background.${backgroundAssetKindKey(activeAsset)}`)}</span>
          )}
          {activeAsset?.bytes === undefined ? null : <span>{formatBackgroundBytes(activeAsset.bytes)}</span>}
          {activeAsset !== undefined && activeAsset.width !== undefined && activeAsset.height !== undefined
            ? <span>{`${activeAsset.width}×${activeAsset.height}`}</span>
            : null}
          {activeDuration === undefined ? null : <span>{activeDuration}</span>}
        </div>

        {notice === undefined ? null : (
          <div className="bg-notice" role="status">
            <Icon name="alert-c" extra="sm" />
            <span>{t(`settings.background.${notice}`)}</span>
            <button type="button" className="icon-btn bg-notice-close" aria-label={t("common.close")} onClick={actions.dismissNotice}>
              <Icon name="x" extra="sm" />
            </button>
          </div>
        )}
      </SettingSection>

      <SettingSection title={t("settings.background.sectionGallery")} desc={t("settings.background.galleryDesc")}>
        {preview ? <p className="bg-preview-note">{t("settings.background.previewNote")}</p> : null}
        <div
          className={`bg-drop${dragging ? " is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!importBlocked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="bg-gallery">
            <div className="bg-gallery-head">
              <span className="bg-gallery-title">{t("settings.background.presets")}</span>
              <span className="bg-gallery-count">{presets.length}</span>
            </div>
            <div className="bg-grid">
              {presets.map((asset) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  active={asset.id === settings.activeId}
                  disabled={false}
                  onActivate={() => actions.activate(asset.id)}
                  onRemove={() => undefined}
                />
              ))}
            </div>

            <div className="bg-gallery-head">
              <span className="bg-gallery-title">{t("settings.background.uploads")}</span>
              <span className="bg-gallery-count">{uploads.length}</span>
            </div>
            {loading ? <p className="small muted">{t("common.loading")}</p> : null}
            {!loading && uploads.length === 0 ? (
              <div className="bg-empty">{t("settings.background.empty")}</div>
            ) : null}
            <div className="bg-grid">
              {uploads.map((asset) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  active={asset.id === settings.activeId}
                  disabled={importBlocked}
                  onActivate={() => actions.activate(asset.id)}
                  onRemove={() => { void actions.remove(asset.id); }}
                />
              ))}
              <button
                type="button"
                className="bg-add"
                onClick={openPicker}
                disabled={importBlocked}
                data-tip={importBlocked ? t("settings.background.storageUnavailable") : undefined}
              >
                <Icon name="plus" />
                <span>{t("settings.background.add")}</span>
                <span className="tiny muted">{t("settings.background.addHint")}</span>
              </button>
            </div>

            {importing.map((entry) => (
              <div className="bg-importing" role="status" key={entry.key}>
                <span className="spinner" />
                <span>{t("settings.background.importing", { name: entry.name })}</span>
              </div>
            ))}

            {errors.length === 0 ? null : (
              <div className="bg-errors">
                {errors.map((error) => (
                  <div className="bg-error" role="alert" key={error.key}>
                    <Icon name="alert" extra="sm" />
                    <span>
                      {error.name === "" ? null : <b>{error.name} · </b>}
                      {t(`settings.background.error.${error.code}`)}
                    </span>
                    <button
                      type="button"
                      className="icon-btn bg-error-close"
                      aria-label={t("common.close")}
                      onClick={() => actions.dismissError(error.key)}
                    >
                      <Icon name="x" extra="sm" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={BACKGROUND_ACCEPT}
          className="bg-file-input"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </SettingSection>

      <SettingSection title={t("settings.background.sectionDisplay")}>
        <SettingRow label={t("settings.background.opacity")} desc={t("settings.background.opacityDesc")} source={sourceFor(settings, "opacity")}>
          <Slider
            label={t("settings.background.opacity")}
            min={5}
            max={100}
            step={5}
            value={draft.opacity}
            display={`${draft.opacity}%`}
            onChange={(opacity) => setDraft((current) => ({ ...current, opacity }))}
            onCommit={commitOpacity}
          />
        </SettingRow>
        <SettingRow label={t("settings.background.strength")} desc={t("settings.background.strengthDesc")} source={sourceFor(settings, "strength")}>
          <Slider
            label={t("settings.background.strength")}
            min={0}
            max={100}
            step={5}
            value={draft.strength}
            display={`${draft.strength}%`}
            onChange={(strength) => setDraft((current) => ({ ...current, strength }))}
            onCommit={commitStrength}
          />
        </SettingRow>
        <SettingRow label={t("settings.background.scrimAuto")} desc={t("settings.background.scrimDesc")} source={sourceFor(settings, "scrimAuto")}>
          <Switch
            checked={settings.scrimAuto}
            onChange={(scrimAuto) => actions.set({ scrimAuto })}
            label={t("settings.background.scrimAuto")}
          />
        </SettingRow>
        <SettingRow label={t("settings.background.scrim")} desc={t("settings.background.scrimDesc")} source={settings.scrimAuto ? "default" : "user"}>
          <Slider
            label={t("settings.background.scrim")}
            min={0}
            max={95}
            step={5}
            value={settings.scrimAuto ? previewScrim : draft.scrim}
            display={`${settings.scrimAuto ? previewScrim : draft.scrim}%`}
            disabled={settings.scrimAuto}
            onChange={(scrim) => setDraft((current) => ({ ...current, scrim }))}
            onCommit={commitScrim}
          />
        </SettingRow>
        <SettingRow label={t("settings.background.blur")} desc={t("settings.background.blurDesc")} source={sourceFor(settings, "blur")}>
          <Slider
            label={t("settings.background.blur")}
            min={0}
            max={60}
            step={2}
            value={draft.blur}
            display={`${draft.blur}px`}
            onChange={(blur) => setDraft((current) => ({ ...current, blur }))}
            onCommit={commitBlur}
          />
        </SettingRow>
        <SettingRow label={t("settings.background.fit")} desc={t("settings.background.fitDesc")} source={sourceFor(settings, "fit")}>
          <AppSelect
            className="select"
            value={settings.fit}
            aria-label={t("settings.background.fit")}
            onChange={(event) => actions.set({ fit: event.target.value as BackgroundSettings["fit"] })}
          >
            <option value="cover">{t("settings.background.fitCover")}</option>
            <option value="contain">{t("settings.background.fitContain")}</option>
            <option value="tile">{t("settings.background.fitTile")}</option>
          </AppSelect>
        </SettingRow>
        <SettingRow label={t("settings.background.focus")} desc={t("settings.background.focusDesc")} source={sourceFor(settings, "focus")}>
          <AppSelect
            className="select"
            value={settings.focus}
            aria-label={t("settings.background.focus")}
            disabled={settings.fit === "tile"}
            onChange={(event) => actions.set({ focus: event.target.value as BackgroundSettings["focus"] })}
          >
            <option value="center">{t("settings.background.focusCenter")}</option>
            <option value="top">{t("settings.background.focusTop")}</option>
            <option value="bottom">{t("settings.background.focusBottom")}</option>
            <option value="left">{t("settings.background.focusLeft")}</option>
            <option value="right">{t("settings.background.focusRight")}</option>
          </AppSelect>
        </SettingRow>
        <SettingRow label={t("settings.background.motion")} desc={t("settings.background.motionDesc")} source={sourceFor(settings, "motion")}>
          <AppSelect
            className="select"
            value={settings.motion}
            aria-label={t("settings.background.motion")}
            onChange={(event) => actions.set({ motion: event.target.value as BackgroundSettings["motion"] })}
          >
            <option value="auto">{t("settings.background.motionAuto")}</option>
            <option value="on">{t("settings.background.motionOn")}</option>
            <option value="off">{t("settings.background.motionOff")}</option>
          </AppSelect>
        </SettingRow>

        {reducedMotion ? (
          <div className="bg-hint" role="status">
            <Icon name="info" extra="sm" />
            <span>{t("settings.background.reducedMotionHint")}</span>
          </div>
        ) : null}
        {reducedTransparency ? (
          <div className="bg-hint" role="status">
            <Icon name="info" extra="sm" />
            <span>{t("settings.background.reducedTransparencyHint")}</span>
          </div>
        ) : null}
        {lowContrast && readability !== undefined ? (
          <div className="bg-hint" role="status">
            <Icon name="alert" extra="sm" />
            <span>{t("settings.background.contrastWarn", { ratio: readability.toFixed(2) })}</span>
          </div>
        ) : null}
      </SettingSection>

      <SettingSection title={t("settings.background.sectionStorage")}>
        <div className="bg-storage">
          <span>{t("settings.background.storageUsage", { count: uploads.length, size: formatBackgroundBytes(usageBytes) })}</span>
          <span aria-hidden="true">·</span>
          <span>{t("settings.background.storageLimit", { size: formatBackgroundBytes(BACKGROUND_LIMITS.totalBytes) })}</span>
          <span className="spacer" />
          {confirmClear ? (
            <>
              <button
                type="button"
                className="btn small danger"
                onClick={() => { setConfirmClear(false); void actions.clearUploads(); }}
              >
                {t("common.confirm")}
              </button>
              <button type="button" className="btn small outline" onClick={() => setConfirmClear(false)}>
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn small outline"
              disabled={uploads.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              {t("settings.background.clearUploads")}
            </button>
          )}
        </div>
        {storageAvailable === false ? (
          <div className="bg-notice" role="alert">
            <Icon name="alert-c" extra="sm" />
            <span>{t("settings.background.storageUnavailable")}</span>
          </div>
        ) : null}
        <p className="bg-preview-note">{t("settings.background.storageNote")}</p>
      </SettingSection>
    </>
  );
}
