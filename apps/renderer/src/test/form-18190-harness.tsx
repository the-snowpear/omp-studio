// Local component acceptance only. No Host, account, reducer or production entrypoint.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { InteractionId, SessionId } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_FORM_LONG, PREVIEW_FORM_SHORT } from "../preview/formPreview";
import { FormSession } from "../deck/FormSession";
import { QueuedDeck, type QueuedDeckItem } from "../deck/QueuedDeck";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../App.css";

function Surface() {
  const { preview, marks } = usePreviewMode();
  const [long, setLong] = useState(true), [generation, reset] = useState(0), [result, setResult] = useState("");
  const [dark, setDark] = useState(new URLSearchParams(location.search).get("theme") === "dark");
  const form = long ? PREVIEW_FORM_LONG : PREVIEW_FORM_SHORT;
  const session = useMemo(() => new FormSession({ kind:"form", interactionId:`qa-${generation}-${long}` as InteractionId, sessionId:"form-qa" as SessionId, leaseGeneration:1, title:"确认交互参数", summary:"拖拽与缩放的原生表单", fieldCount:form.fields.length, sectionCount:form.sections.length }), [form,generation]);
  const items = useMemo<QueuedDeckItem[]>(() => [{kind:"form",id:session.interaction.interactionId,title:session.interaction.title,summary:session.interaction.summary,session}], [session]);
  useEffect(() => { if(preview)void session.load(() => Promise.resolve(form)); return () => session.close(); }, [session,form,preview]);
  useEffect(() => { document.documentElement.dataset.theme=dark?"dark":"light"; }, [dark]);
  return <div style={{display:"flex",flexDirection:"column",width:"100vw",height:"100vh",minWidth:0,minHeight:0}}>
    <header className="model-native-toolbar" style={{padding:"16px 24px",borderBottom:"1px solid var(--border)"}}><strong>OMP 18.19.0 · Form</strong><button className="btn small outline" onClick={()=>setLong(value=>!value)}>{long?"短表单":"长表单"}</button><button className="btn small outline" onClick={()=>{reset(value=>value+1);setResult("");}}>重新提问</button><button className="btn small outline" onClick={()=>setDark(value=>!value)}>明暗主题</button>{marks?<span className="small muted">真实组件 / 演示数据 · 不连接 Host</span>:null}</header>
    <main className="convo-wrap" style={{position:"relative",width:"min(960px, calc(100% - 32px))",height:"calc(100vh - 94px)",margin:"16px auto",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
      {preview?<QueuedDeck key={session.interaction.interactionId} items={items} demo={marks} regionLabel="待填写的原生表单" onFormRespond={async(_item,decision,value)=>{setResult(decision==="cancel"?"已取消":JSON.stringify(value,null,2));return true;}}/>:<p role="status">此验收页未连接 Host；没有真实待处理表单。</p>}
      {result?<pre aria-label="提交的命名数据" style={{whiteSpace:"pre-wrap",padding:16,background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--r-8)"}}>{result}</pre>:null}
    </main>
  </div>;
}
const root=createRoot(document.getElementById("root")!);
root.render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><Surface/></PreviewModeProvider></I18nProvider>);
import.meta.hot?.dispose(()=>root.unmount());
