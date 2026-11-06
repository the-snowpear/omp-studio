import { useEffect, useState } from "react";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useAppSettings } from "../settings/appSettings";
import { MicrophoneSettingsButton } from "./microphoneAccess";
import { useMicrophoneTest } from "./useMicrophoneTest";

export function MicrophoneSetup({ visible, demo = false }: { visible: boolean; demo?: boolean }) {
  const { marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { settings, update } = useAppSettings();
  const [demoDevice, setDemoDevice] = useState("");
  const deviceId = demo ? demoDevice : settings.dictationDeviceId;
  const microphone = useMicrophoneTest(zh, deviceId, visible, demo);
  const t = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => { if (!visible) microphone.stop(); }, [visible, microphone.stop]);
  return <div className="dictation-device-setup">
    <label className="small">{t("输入设备", "Input device")}
      <AppSelect className="select" aria-label={t("听写麦克风", "Dictation microphone")} value={deviceId} disabled={microphone.testing} onChange={event => demo ? setDemoDevice(event.target.value) : update({ dictationDeviceId: event.target.value })}>
        <option value="">{t("系统默认麦克风", "System default microphone")}</option>
        {deviceId && !microphone.devices.some(device => device.deviceId === deviceId) ? <option value={deviceId}>{t("先前选择的设备（当前未找到）", "Previously selected device (not found)")}</option> : null}
        {microphone.devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${t("麦克风", "Microphone")} ${index + 1}`}</option>)}
      </AppSelect>
    </label>
    <div className="dictation-device-actions">
      <button type="button" className="btn small outline" disabled={demo} onClick={() => microphone.testing ? microphone.stop() : void microphone.start()}>{microphone.testing ? t("停止测试", "Stop test") : t("测试麦克风", "Test microphone")}</button>
      <button type="button" className="btn small ghost" disabled={demo || microphone.testing} onClick={() => void microphone.refresh()}>{t("刷新设备", "Refresh devices")}</button>
      <meter className="dictation-level" min={0} max={1} value={microphone.level} aria-label={t("麦克风输入电平", "Microphone input level")} />
    </div>
    <p className="tiny muted">{demo && marks ? t("演示设置不会申请麦克风权限。", "Demo settings never request microphone access.") : t("测试最多 10 秒，只显示本机输入电平，不上传、不保存录音。", "The test lasts up to 10 seconds. It only shows local input levels; nothing is uploaded or saved.")}</p>
    {microphone.error ? <><p className="dictation-warning" role="alert">{microphone.error}</p><MicrophoneSettingsButton zh={zh} /></> : null}
  </div>;
}
