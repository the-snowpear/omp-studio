import type { DictationConfiguration } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";

export function DictationDetails({ configuration }: { configuration: DictationConfiguration }) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const t = (cn: string, en: string) => zh ? cn : en;
  const mode = configuration.mode === "streaming" ? t("边说边显示", "Live words") : configuration.mode === "segmented" ? t("停顿后分段显示", "Updates between phrases") : t("停止后转写", "Transcribes after stopping");
  return <div className="dictation-details">
    <div><span className="dictation-model">{configuration.model || t("未选择模型", "No model selected")}</span><span className="chip gray xs">{configuration.cloud ? t("云端", "Cloud") : t("本机", "Local")}</span></div>
    <p>{configuration.language || t("自动检测语言", "Detect language")} · {mode}</p>
    <p>{t("按住说话", "Hold to talk")}：{(configuration.hotkeys?.pushToTalk ?? ["space"]).join(" / ") || t("未绑定", "Unassigned")} · {t("切换录音", "Toggle recording")}：{configuration.hotkeys?.toggle.join(" / ") || t("未绑定", "Unassigned")}</p>
    {configuration.languageSupport === "unsupported" ? <p className="dictation-warning">{t("当前模型不支持所选语言，请更换模型或语言。", "This model does not support the selected language. Choose another model or language.")}</p> : configuration.languageSupport === "unknown" ? <p className="tiny muted">{t("该模型的语言覆盖尚未确认，请用短句测试后再长段听写。", "Language coverage is unverified. Test a short phrase before a longer recording.")}</p> : null}
    {configuration.credentials === "missing" ? <p className="dictation-warning">{t("请先在模型配置中添加转写服务的凭证。", "Add transcription credentials in model settings first.")}</p> : null}
    {configuration.downloadRequired ? <p>{t("首次使用需要下载本地模型", "First use downloads the local model")} {configuration.downloadSize ?? ""}。</p> : null}
    {configuration.cloud ? <p className="tiny muted">{t("录音会发送到此转写服务，可能计费。已有凭证不代表网络与额度已验证。", "Audio is sent to this transcription service and may be billed. Stored credentials do not verify connectivity or quota.")}</p> : <p className="tiny muted">{t("识别在本机进行；模型文件下载后可复用。", "Recognition runs locally; downloaded model files are reused.")}</p>}
  </div>;
}
