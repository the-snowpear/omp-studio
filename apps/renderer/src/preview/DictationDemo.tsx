import { useState } from "react";
import { useI18n } from "../i18n";
import { PREVIEW_DICTATION_TEXT } from "./dictationPreview";
import { usePreviewMode } from "./PreviewContext";

export function DictationDemo() {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const [phase, setPhase] = useState<"off" | "recording" | "complete">("off");
  const [draft, setDraft] = useState("");
  // 纯演示控件：按真实页面呈现时整块不渲染。
  if (!marks) return null;
  return <section className="dictation-demo" aria-label={zh ? "独立听写演示" : "Isolated dictation demo"}>
    <header><span className="chip gray xs">{zh ? "演示" : "Demo"}</span><span>{zh ? "不录音，不修改真实草稿" : "No microphone, no real draft changes"}</span></header>
    <textarea className="input" aria-label={zh ? "演示草稿" : "Demo draft"} value={draft} onChange={event => setDraft(event.target.value)} />
    <div className="dictation-actions"><button type="button" className="btn small outline" onClick={() => {
      if (phase === "recording") { setDraft(value => value + PREVIEW_DICTATION_TEXT); setPhase("complete"); }
      else setPhase("recording");
    }}>{phase === "recording" ? zh ? "停止并填入演示草稿" : "Finish into demo draft" : zh ? "试用听写交互" : "Try dictation interaction"}</button><button type="button" className="btn small ghost" onClick={() => setPhase("off")}>{zh ? "取消演示" : "Cancel demo"}</button></div>
    <p aria-live="polite" className="tiny muted">{phase === "recording" ? zh ? `演示临时文字：${PREVIEW_DICTATION_TEXT}` : "Demo temporary transcript is waiting for confirmation." : phase === "complete" ? zh ? "已填入独立演示草稿。" : "Added to the isolated demo draft." : zh ? "演示结果只留在此区域。" : "Demo results stay inside this area."}</p>
  </section>;
}
