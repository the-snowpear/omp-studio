import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { PREVIEW_UPDATE_PREFS } from "../preview/settingsPreview";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import { useUpdates, type ChromeUpdatesPrefsSetInput } from "./updates";

export function UpdateAutomationSettings({ preview }: { preview: boolean }) {
  const { t } = useI18n();
  const updates = useUpdates();
  const [previewPrefs, setPreviewPrefs] = useState(PREVIEW_UPDATE_PREFS);
  const prefs = preview ? previewPrefs : updates.state.prefs;
  const available = preview || prefs !== null;

  useEffect(() => {
    if (!preview) void updates.fetchPrefs();
  }, [preview, updates.fetchPrefs]);

  const save = (patch: ChromeUpdatesPrefsSetInput) => {
    if (preview) setPreviewPrefs(current => ({ ...current, ...patch }));
    else void updates.savePrefs(patch);
  };

  return (
    <SettingSection title={`${t("updates.section")}${preview ? ` · ${t("common.demo")}` : ""}`}>
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
          onChange={autoCheck => save({ autoCheck })}
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
          onChange={autoDownload => save({ autoDownload })}
        />
      </SettingRow>
    </SettingSection>
  );
}
