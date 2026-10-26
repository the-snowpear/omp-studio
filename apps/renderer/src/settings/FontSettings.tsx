import { useEffect, useState, type CSSProperties } from "react";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { PREVIEW_FONT_FAMILIES } from "../preview/settingsPreview";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "./appSettings";
import { SettingSection, SourceBadge } from "./SettingRow";
import type { SettingsCtl } from "./tabs";
import { cachedFontFamilies, canLoadFontFamilies, loadFontFamilies, typographyStyles } from "./typography";
import "./fonts.css";

const GROUPS = [
  { id: "ui", family: "uiFontFamily", size: "uiFontSize", min: 12, max: 20 },
  { id: "terminal", family: "terminalFontFamily", size: "terminalFontSize", min: 8, max: 32 },
  { id: "output", family: "outputFontFamily", size: "outputFontSize", min: 8, max: 32 },
] as const;
type FontGroup = typeof GROUPS[number];
const CUSTOM = "__custom_font__";

function FontGroupSettings({ group, app, families, update, reset }: {
  group: FontGroup;
  app: AppSettings;
  families: readonly string[];
  update: SettingsCtl["updateApp"];
  reset: SettingsCtl["resetApp"];
}) {
  const { t } = useI18n();
  const family = app[group.family];
  const size = app[group.size];
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(family);
  const [sizeDraft, setSizeDraft] = useState(String(size));
  useEffect(() => { setDraft(family); }, [family]);
  useEffect(() => { setSizeDraft(String(size)); }, [size]);
  const manual = custom || (family !== "" && !families.includes(family));
  const label = t(`settings.fonts.${group.id}`);
  const commitFamily = () => update({ [group.family]: draft.trim() });
  const user = family !== DEFAULT_APP_SETTINGS[group.family] || size !== DEFAULT_APP_SETTINGS[group.size];
  return (
    <div className="font-group" role="group" aria-label={label}>
      <div className="font-group-heading"><strong>{label}</strong><SourceBadge source={user ? "user" : "default"} />
        <button type="button" className="btn ghost sm" onClick={() => { setCustom(false); reset([group.family, group.size]); }} aria-label={t("settings.fonts.resetGroup", { group: label })}>{t("settings.fonts.reset")}</button>
      </div>
      <p className="font-group-desc">{t(`settings.fonts.${group.id}Desc`)}</p>
      <div className="font-controls">
        <label><span>{t("settings.fonts.family")}</span>
          <AppSelect className="select" value={manual ? CUSTOM : family} aria-label={`${label} · ${t("settings.fonts.family")}`} onChange={event => {
            if (event.target.value === CUSTOM) { setCustom(true); return; }
            setCustom(false);
            update({ [group.family]: event.target.value });
          }}>
            <option value="">{t("settings.fonts.default")}</option>
            <option value={CUSTOM}>{t("settings.fonts.custom")}</option>
            {families.map(name => <option key={name} value={name}>{name}</option>)}
          </AppSelect>
        </label>
        <label className="font-size-control"><span>{t("settings.fonts.size")}</span>
          <input className="input" type="number" min={group.min} max={group.max} step={1} value={sizeDraft} aria-label={`${label} · ${t("settings.fonts.size")}`} onBlur={() => setSizeDraft(String(size))} onChange={event => {
            setSizeDraft(event.target.value);
            const next = event.target.valueAsNumber;
            if (event.target.value !== "" && event.target.validity.valid) update({ [group.size]: next });
          }} />
        </label>
      </div>
      {manual ? <input className="input font-custom-name" aria-label={`${label} · ${t("settings.fonts.customName")}`} placeholder={t("settings.fonts.customPlaceholder")} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitFamily} onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commitFamily(); }
      }} /> : null}
      <div className={`font-sample font-sample-${group.id}`} aria-label={t("settings.fonts.sampleAria", { group: label })}>
        <p>你好，OMP Studio · The quick brown fox 0123456789</p>
        {group.id !== "ui" ? <pre><code>{'const message = "字体预览 / Font preview";\n$ echo "Hello, 世界"'}</code></pre> : <span>{t("settings.fonts.uiSample")}</span>}
      </div>
    </div>
  );
}

export function FontSettings({ ctl }: { ctl: SettingsCtl }) {
  const { t } = useI18n();
  const [families, setFamilies] = useState<readonly string[]>(() => ctl.preview ? PREVIEW_FONT_FAMILIES : cachedFontFamilies() ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const supported = canLoadFontFamilies();
  const load = async () => {
    if (ctl.preview) { setFamilies(PREVIEW_FONT_FAMILIES); return; }
    setLoading(true); setError(false);
    try { setFamilies(await loadFontFamilies()); }
    catch { setError(true); }
    finally { setLoading(false); }
  };
  return <SettingSection title={t("settings.fonts.title")} desc={t("settings.fonts.desc")}>
    <div className="font-toolbar">
      <button type="button" className="btn outline sm" onClick={() => { void load(); }} disabled={loading || (!ctl.preview && !supported)}>{t(loading ? "settings.fonts.loading" : families.length ? "settings.fonts.refresh" : "settings.fonts.load")}</button>
      <span className="muted small" aria-live="polite">{ctl.preview ? t("settings.fonts.demo") : !supported ? t("settings.fonts.unsupported") : error ? t("settings.fonts.failed") : t("settings.fonts.localHint")}</span>
    </div>
    <div className="font-groups" style={typographyStyles(ctl.app) as CSSProperties}>
      {GROUPS.map(group => <FontGroupSettings key={group.id} group={group} app={ctl.app} families={families} update={ctl.updateApp} reset={ctl.resetApp} />)}
    </div>
  </SettingSection>;
}
