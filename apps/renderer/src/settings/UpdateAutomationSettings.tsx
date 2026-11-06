import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_UPDATE_PREFS } from "../preview/settingsPreview";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import { useUpdates, type ChromeUpdatesPrefsSetInput } from "./updates";

export function UpdateAutomationSettings({ preview }: { preview: boolean }) {
  const { t, resolvedLanguage } = useI18n();
  const { marks } = usePreviewMode();
  const updates = useUpdates();
  const [previewPrefs, setPreviewPrefs] = useState(PREVIEW_UPDATE_PREFS);
  const [saveError, setSaveError] = useState("");
  const prefs = preview ? previewPrefs : updates.state.prefs;
  const available = preview || prefs !== null;

  useEffect(() => {
    if (!preview) void updates.fetchPrefs();
  }, [preview, updates.fetchPrefs]);

  const save = async (patch: ChromeUpdatesPrefsSetInput) => {
    setSaveError("");
    if (preview) setPreviewPrefs(current => ({ ...current, ...patch }));
    else if (!await updates.savePrefs(patch)) setSaveError(resolvedLanguage === "zh" ? "无法保存更新设置。" : "Could not save update settings.");
  };

  return (
    <SettingSection title={`${t("updates.section")}${preview && marks ? ` · ${t("common.demo")}` : ""}`}>
      <SettingRow
        label={t("updates.autoCheck")}
        desc={t("updates.autoCheckHint")}
        source={!available ? "unavailable" : prefs?.autoCheck === false ? "user" : "default"}
        {...(!available ? { reason: t("common.unavailable") } : {})}
      >
        <Switch
          label={t("updates.autoCheck")}
          checked={prefs?.autoCheck ?? true}
          disabled={!available}
          onChange={autoCheck => void save({ autoCheck })}
        />
      </SettingRow>
      <SettingRow
        label={t("updates.autoDownload")}
        desc={t("updates.autoDownloadHint")}
        source={!available ? "unavailable" : prefs?.autoDownload === false ? "user" : "default"}
        {...(!available ? { reason: t("common.unavailable") } : {})}
      >
        <Switch
          label={t("updates.autoDownload")}
          checked={prefs?.autoDownload ?? true}
          disabled={!available}
          onChange={autoDownload => void save({ autoDownload })}
        />
      </SettingRow>
      {saveError ? <p role="alert">{saveError}</p> : null}
    </SettingSection>
  );
}
