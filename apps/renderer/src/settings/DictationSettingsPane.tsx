import { useCallback, useEffect, useState } from "react";
import type { DictationConfiguration } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { FeatureSettingsProps } from "./useFeatureSettings";
import { FeatureSettingsPane } from "./FeatureSettingsPane";
import { SettingRow } from "./SettingRow";
import { useAppSettings } from "./appSettings";
import { MicrophoneSetup } from "../media/MicrophoneSetup";
import { DictationDetails } from "../composer/DictationDetails";
import { dictationCommand } from "../composer/dictationClient";
import { isValidDictationShortcut } from "../composer/dictationKeyboard";
import { PREVIEW_DICTATION_CONFIGURATION } from "../preview/dictationPreview";
import { DictationDemo } from "../preview/DictationDemo";
import { hostErrorMessage } from "../hostError";
import "../composer/dictation.css";

export function DictationSettingsPane(props: FeatureSettingsProps & { onModels?(): void }) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh", { preview, marks } = usePreviewMode();
  const t = (cn: string, en: string) => zh ? cn : en;
  const { settings, update } = useAppSettings();
  const [revision, setRevision] = useState(0);
  const saved = useCallback(() => setRevision(value => value + 1), []);
  const supports = props.context?.capabilities?.capabilities.some(row => row.id === "dictation.inspect" && row.grade !== "unavailable") === true;
  const [configuration, setConfiguration] = useState<DictationConfiguration>();
  const [shortcut, setShortcut] = useState(preview ? "" : settings.dictationToggleShortcut);
  const [error, setError] = useState("");
  useEffect(() => { setShortcut(preview ? "" : settings.dictationToggleShortcut); }, [settings.dictationToggleShortcut, preview]);
  useEffect(() => {
    let current = true;
    setError("");
    if (preview) setConfiguration(PREVIEW_DICTATION_CONFIGURATION);
    else if (props.visible && props.client && props.context?.sessionId && supports) {
      void dictationCommand(props.client, "dictation.inspect", { sessionId: props.context.sessionId }).then(value => { if (current) setConfiguration(value); }).catch(cause => { if (current) setError(hostErrorMessage(cause, t("无法读取有效听写配置", "Could not inspect dictation settings"))); });
    } else setConfiguration(undefined);
    return () => { current = false; };
  }, [preview, props.visible, props.client, props.context?.sessionId, supports, revision]);
  return <section aria-label={t("语音输入设置", "Voice input settings")}>
    <FeatureSettingsPane {...props} group="dictation" onSaved={saved} />
    <div className="dictation-settings-extras">
      {configuration ? <DictationDetails configuration={configuration} /> : null}
      {props.onModels ? <button type="button" className="btn small outline" onClick={props.onModels}>{t("配置 Dictation 模型角色", "Configure the Dictation model role")}</button> : null}
      <SettingRow label={t("切换录音快捷键", "Toggle recording shortcut")} desc={t("按住说话与切换录音沿用原生按键配置，这里可添加 Alt+H 等快捷键。仅在主输入框与 BTW 聚焦时生效。", "Native hold and toggle bindings are respected. Add a shortcut such as Alt+H here; it applies only in the focused composer or BTW.")}>
        <div className="dictation-shortcut"><input className="input" aria-label={t("听写切换快捷键", "Dictation toggle shortcut")} value={shortcut} placeholder="Alt+H" onChange={event => setShortcut(event.target.value)} /><button type="button" className="btn small outline" disabled={!isValidDictationShortcut(shortcut)} onClick={() => { if (!preview) update({ dictationToggleShortcut: shortcut.trim() }); }}>{t("应用", "Apply")}</button></div>
      </SettingRow>
      {!isValidDictationShortcut(shortcut) ? <p className="dictation-warning" role="alert">{t("请输入有效组合键，避免占用系统编辑快捷键；留空可取消绑定。", "Choose a valid combination without taking a standard editing shortcut. Leave empty to unassign.")}</p> : null}
      <MicrophoneSetup visible={props.visible} demo={preview} />
      {error ? <p className="dictation-warning" role="alert">{error}</p> : null}
      <p className="tiny muted">{t("每次最长 10 分钟，仅保留一份内存恢复录音。切换会话或隐藏窗口立即停麦；退出应用、成功插入或主动丢弃后清除。不会自动重试或把本地录音切换到云端。", "Each recording is limited to 10 minutes, with one in-memory recovery slot. Switching conversations or hiding stops the microphone. App exit, successful insertion or discard clears it. Retries and cloud fallback are never automatic.")}</p>
      {preview && marks ? <DictationDemo /> : null}
    </div>
  </section>;
}
