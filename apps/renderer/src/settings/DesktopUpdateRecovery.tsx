import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { PREVIEW_DESKTOP_RECOVERY } from "../preview/fixtures";
import { useAppUpdate } from "./appUpdate";
import { SettingRow } from "./SettingRow";

export function DesktopUpdateRecovery({ preview }: { preview: boolean }) {
  const { t } = useI18n();
  const updates = useAppUpdate();
  const [demoReady, setDemoReady] = useState(false);
  const [demoDone, setDemoDone] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const version = preview ? PREVIEW_DESKTOP_RECOVERY.version : updates.state.rollbackVersion;
  const ready = preview ? demoReady : updates.state.rollbackReady === true;
  const busy = pending || (!preview && (updates.state.downloading || updates.state.checking));
  const available = version !== undefined && (preview || Boolean(globalThis.ompStudioChrome?.rollbackUpdate));
  const act = async () => {
    if (inFlight.current || busy || !available) return;
    if (preview) {
      setDemoDone(ready);
      setDemoReady(!ready);
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      if (ready) await updates.apply();
      else await updates.prepareRollback();
    } finally { inFlight.current = false; setPending(false); }
  };
  return <>
    <SettingRow
      label={`${t("updates.rollbackApp")}${preview ? ` · ${t("appUpdate.demoUpdate")}` : ""}`}
      desc={available ? `${t("updates.rollbackAppTarget")}: ${version} · ${t("updates.rollbackAppHint")}` : t("updates.rollbackAppUnavailable")}
      source={available ? "user" : "unavailable"}
      {...(!available ? { reason: t("updates.rollbackAppUnavailable") } : {})}
    >
      <button type="button" className="btn small outline" disabled={!available || busy} onClick={() => void act()}>
        {busy ? t("appUpdate.downloading") : ready ? t("updates.rollbackAppRestart") : t("updates.rollbackAppPrepare")}
      </button>
    </SettingRow>
    {ready ? <p className="small muted" role="status">{t("updates.readyToApply")}</p> : null}
    {preview && demoDone ? <p className="small muted" role="status">{t("updates.rollbackAppDemoDone")}</p> : null}
    {!preview && updates.state.downloadError ? <p className="small" role="alert">{updates.state.downloadError}</p> : null}
  </>;
}
