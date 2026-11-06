import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { DockSettings } from "../dock/DockSettings";
import { ConversationWidthSettings } from "./ConversationWidthSettings";
import { FontSettings } from "./FontSettings";
import { UpdateAutomationSettings } from "./UpdateAutomationSettings";
import { CONVERSATION_WIDTH_KEYS, DEFAULT_APP_SETTINGS, type AppSettings } from "./appSettings";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import type { SettingsCtl } from "./tabs";

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange(value: T): void }) {
  return <AppSelect className="select" aria-label={label} value={value} onChange={event => onChange(event.target.value as T)}>
    {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
  </AppSelect>;
}

export function LocalSettings({ ctl, section }: { ctl: SettingsCtl; section: "general" | "appearance" | "interaction" | "maintenance" }) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { app, updateApp } = ctl;
  const source = (key: keyof AppSettings) => app[key] === DEFAULT_APP_SETTINGS[key] ? "default" as const : "user" as const;
  const reset = (keys: readonly (keyof AppSettings)[], name: string) => <div className="set-toolbar"><button type="button" className="btn small outline" onClick={() => ctl.resetApp(keys)}>{name}</button></div>;

  if (section === "maintenance") return <UpdateAutomationSettings key={String(ctl.preview)} preview={ctl.preview} />;
  if (section === "appearance") return <>
    <SettingSection title={zh ? "外观" : "Appearance"}>
      {reset(["theme", "density", "fileTypePalette"], zh ? "恢复外观默认值" : "Reset appearance")}
      <SettingRow label={t("settings.general.theme")} desc={t("settings.general.themeDesc")} source={source("theme")}>
        <Select label={t("settings.general.theme")} value={app.theme} options={[["light", t("settings.general.themeLight")], ["dark", t("settings.general.themeDark")]]} onChange={theme => updateApp({ theme })} />
      </SettingRow>
      <SettingRow label={t("settings.general.density")} desc={t("settings.general.densityDesc")} source={source("density")}>
        <Select label={t("settings.general.density")} value={app.density} options={[["compact", t("settings.general.densityCompact")], ["standard", t("settings.general.densityStandard")], ["cozy", t("settings.general.densityCozy")]]} onChange={density => updateApp({ density })} />
      </SettingRow>
      <SettingRow label={t("settings.general.fileTypePalette")} desc={t("settings.general.fileTypePaletteDesc")} source={source("fileTypePalette")}>
        <Switch label={t("settings.general.fileTypePalette")} checked={app.fileTypePalette === "cat"} onChange={on => updateApp({ fileTypePalette: on ? "cat" : "tri" })} />
      </SettingRow>
    </SettingSection>
    {reset(CONVERSATION_WIDTH_KEYS, zh ? "恢复阅读宽度默认值" : "Reset reading width")}
    <ConversationWidthSettings />
    <FontSettings key={String(ctl.preview)} ctl={ctl} />
    <DockSettings />
  </>;

  if (section === "interaction") return <SettingSection title={zh ? "对话显示" : "Conversation display"}>
    <SettingRow label={t("settings.general.streaming")} desc={t("settings.general.streamingDesc")} source={source("streaming")}>
      <Switch label={t("settings.general.streaming")} checked={app.streaming} onChange={streaming => updateApp({ streaming })} />
    </SettingRow>
    <SettingRow label={t("settings.general.streamingCadence")} desc={t("settings.general.streamingCadenceDesc")} source={source("streamingCadenceHz")}>
      <Select label={t("settings.general.streamingCadence")} value={String(app.streamingCadenceHz)} options={["30", "60", "90", "120"].map(value => [value, t("settings.general.streamingCadence" + value)] as const)} onChange={value => updateApp({ streamingCadenceHz: Number(value) as AppSettings["streamingCadenceHz"] })} />
    </SettingRow>
    <SettingRow label={t("settings.general.toolActivity")} desc={t("settings.general.toolActivityDesc")} source={source("toolActivity")}>
      <Select label={t("settings.general.toolActivity")} value={app.toolActivity} options={[["full", t("settings.general.toolFull")], ["concise", t("settings.general.toolConcise")], ["hidden", t("settings.general.toolHidden")]]} onChange={toolActivity => updateApp({ toolActivity })} />
    </SettingRow>
  </SettingSection>;

  return <>
    <SettingSection title={t("settings.general.sectionApp")}>
      <SettingRow label={t("settings.general.language")} desc={t("settings.general.languageDesc")} source={source("language")}>
        <Select label={t("settings.general.language")} value={app.language} options={[["system", t("settings.general.langSystem")], ["zh", t("settings.general.langZh")], ["en", t("settings.general.langEn")]]} onChange={language => updateApp({ language })} />
      </SettingRow>
    </SettingSection>
    <SettingSection title={t("settings.general.sectionStartup")}>
      {reset(["restoreLastProject", "restoreLastSession", "startupPage"], zh ? "恢复启动默认值" : "Reset startup settings")}
      <SettingRow label={t("settings.general.restoreLastProject")} desc={t("settings.general.restoreLastProjectDesc")} source={source("restoreLastProject")}>
        <Switch label={t("settings.general.restoreLastProject")} checked={app.restoreLastProject} onChange={restoreLastProject => updateApp({ restoreLastProject })} />
      </SettingRow>
      <SettingRow label={t("settings.general.restoreLastSession")} desc={t("settings.general.restoreLastSessionDesc")} source={source("restoreLastSession")}>
        <Switch label={t("settings.general.restoreLastSession")} checked={app.restoreLastSession} onChange={restoreLastSession => updateApp({ restoreLastSession })} />
      </SettingRow>
      <SettingRow label={t("settings.general.startupPage")} desc={t("settings.general.startupPageDesc")} source={source("startupPage")}>
        <Select label={t("settings.general.startupPage")} value={app.startupPage} options={[["home", t("settings.general.startupHome")], ["workbench", t("settings.general.startupWorkbench")], ["last", t("settings.general.startupLast")]]} onChange={startupPage => updateApp({ startupPage })} />
      </SettingRow>
    </SettingSection>
    <SettingSection title={t("settings.general.sectionNotify")} desc={t("settings.general.notifyDesc")}>
      {reset(["notifyTaskDone", "notifyErrors", "notifyConfirmations", "notifyLongTasks"], zh ? "恢复通知默认值" : "Reset notifications")}
      {(["notifyTaskDone", "notifyErrors", "notifyConfirmations", "notifyLongTasks"] as const).map(key => <SettingRow key={key} label={t("settings.general." + key)} desc={t("settings.general." + key + "Desc")} source={source(key)}>
        <Switch label={t("settings.general." + key)} checked={app[key]} onChange={value => updateApp({ [key]: value })} />
      </SettingRow>)}
    </SettingSection>
  </>;
}
