import { useCallback, useEffect, useState } from "react";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { PREVIEW_UPDATE_PREFS } from "../preview/settingsPreview";
import { SettingRow, SettingSection } from "./SettingRow";
import { useUpdates, type UpdatePrefs } from "./updates";
import { DesktopUpdateRecovery } from "./DesktopUpdateRecovery";
import type { RuntimeDemoApi, RuntimeSettingsCtl } from "./tabs";

export function AdvancedTab({ demo, runtime }: { demo?: RuntimeDemoApi | undefined; runtime?: RuntimeSettingsCtl | undefined }) {
  const { t, resolvedLanguage } = useI18n();
  const preview = runtime?.preview === true || demo !== undefined;
  const updates = useUpdates();
  const [previewPrefs, setPreviewPrefs] = useState<UpdatePrefs>(PREVIEW_UPDATE_PREFS);
  const prefs = preview ? previewPrefs : updates.state.prefs;
  const available = preview || prefs !== null;
  const disabled = !available;
  const [mirrorInput, setMirrorInput] = useState(prefs?.mirrorPrefix ?? "");
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!preview) {
      void updates.fetchPrefs();
    }
  }, [preview, updates.fetchPrefs]);

  useEffect(() => {
    if (prefs) {
      setMirrorInput(prefs.mirrorPrefix);
    }
  }, [prefs?.mirrorPrefix]);

  const handleMirrorBlur = useCallback(async () => {
    if (disabled) return;
    const trimmed = mirrorInput.trim();
    if (trimmed.length > 0) {
      try {
        const u = new URL(trimmed.includes("{url}") ? trimmed.replace("{url}", "https://github.com") : trimmed);
        if (u.protocol !== "https:") {
          setMirrorError(t("updates.mirrorInvalid"));
          return;
        }
      } catch {
        setMirrorError(t("updates.mirrorInvalid"));
        return;
      }
    }
    setMirrorError(null);
    if (preview) {
      setPreviewPrefs((prev) => ({ ...prev, mirrorPrefix: trimmed }));
    } else {
      if (!await updates.savePrefs({ mirrorPrefix: trimmed })) setMirrorError(resolvedLanguage === "zh" ? "无法保存镜像设置。" : "Could not save the mirror setting.");
    }
  }, [disabled, mirrorInput, preview, updates, t, resolvedLanguage]);

  return (
    <>

      <SettingSection title={t("updates.section")}>
        <SettingRow
          label={t("updates.mirrorLabel")}
          desc={t("updates.mirrorHint")}
          source={!available ? "unavailable" : (prefs?.mirrorPrefix ? "user" : "default")}
          {...(!available ? { reason: t("common.unavailable") } : {})}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", maxWidth: 360 }}>
            <input
              type="text"
              className="input"
              value={mirrorInput}
              aria-label={t("updates.mirrorLabel")}
              placeholder="https://mirror.example.com/"
              disabled={disabled}
              onChange={(e) => {
                setMirrorInput(e.target.value);
                setMirrorError(null);
              }}
            />
            <button type="button" className="btn small outline" disabled={disabled || mirrorInput.trim() === (prefs?.mirrorPrefix ?? "")} onClick={() => void handleMirrorBlur()}>{t("common.save")}</button>
            {mirrorError ? (
              <span role="alert" style={{ color: "var(--red)", fontSize: "0.8rem" }}>{mirrorError}</span>
            ) : null}
          </div>
        </SettingRow>
        <SettingRow
          label={t("updates.channel")}
          source={!available ? "unavailable" : (prefs?.runtimeChannel === "canary" ? "user" : "default")}
          {...(!available ? { reason: t("common.unavailable") } : {})}
        >
          <AppSelect
            className="select"
            aria-label={t("updates.channel")}
            value={prefs?.runtimeChannel ?? "stable"}
            disabled={disabled}
            onChange={(e) => {
              const channel = e.target.value as "stable" | "canary";
              if (preview) {
                setPreviewPrefs((prev) => ({ ...prev, runtimeChannel: channel }));
              } else {
                setSaveError("");
                void updates.savePrefs({ runtimeChannel: channel }).then(result => { if (!result) setSaveError(resolvedLanguage === "zh" ? "无法保存更新通道。" : "Could not save the update channel."); });
              }
            }}
          >
            <option value="stable">Stable</option>
            <option value="canary">Canary</option>
          </AppSelect>
        </SettingRow>
        {prefs?.skippedAppVersion ? (
          <SettingRow
            label={t("updates.skipVersion")}
            desc={`${t("updates.skipped")}: ${prefs.skippedAppVersion}`}
            source={!available ? "unavailable" : "user"}
            {...(!available ? { reason: t("common.unavailable") } : {})}
          >
            <button
              type="button"
              className="btn small outline"
              disabled={disabled}
              onClick={() => {
                if (preview) {
                  setPreviewPrefs((prev) => ({ ...prev, skippedAppVersion: "" }));
                } else {
                  void updates.savePrefs({ skippedAppVersion: "" });
                }
              }}
            >
              {t("common.clear")}
            </button>
          </SettingRow>
        ) : null}
      </SettingSection>
      {saveError ? <p role="alert">{saveError}</p> : null}
      <SettingSection title={t("updates.rollbackApp")}>
        <DesktopUpdateRecovery preview={preview} />
      </SettingSection>

    </>
  );
}
