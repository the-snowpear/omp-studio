// Local acceptance of production components; no Host, model, account or command ledger.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { PreviewChanges } from "../preview/surfaces";
import { PREVIEW_DIFF } from "../preview/fixtures";
import { previewJobInspections } from "../hubPreview";
import { JobInspector } from "../conversation/JobInspector";
import { WorkspaceTabs } from "../workspaces/Workspace";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../App.css";

const inspections = previewJobInspections();
function Surface() {
  const { preview, marks } = usePreviewMode();
  const params = new URLSearchParams(location.search);
  const [tab, setTab] = useState<"actions" | "changes">(params.get("surface") === "changes" ? "changes" : "actions");
  const [failed, setFailed] = useState(true), [process, setProcess] = useState(false), [large, setLarge] = useState(false);
  const [dark, setDark] = useState(params.get("theme") === "dark"), [show, setShow] = useState(true);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => { document.documentElement.style.setProperty("--ui-font-scale", large ? "1.3" : "1"); return () => { document.documentElement.style.removeProperty("--ui-font-scale"); }; }, [large]);
  useEffect(() => { if (params.get("reduced") === "1") document.documentElement.dataset.perfTier = "L1"; }, []);
  const id = failed ? "job-87" : "job-82";
  return <div style={{height:"100vh",display:"flex",flexDirection:"column",minHeight:0,color:"var(--text)",background:"var(--bg)"}}>
    <header style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:8,padding:"12px 20px",borderBottom:"1px solid var(--border)"}}>
      <strong>OMP 18.19.0 · Actions / Changes</strong>
      <button className="btn small outline" onClick={() => setDark(value => !value)}>明暗主题</button>
      <button className="btn small outline" aria-pressed={large} onClick={() => setLarge(value => !value)}>放大字号</button>
      {marks ? <span className="tiny muted">真实组件 / 本地 fixture，不连接 Host</span> : null}
    </header>
    <main style={{display:"flex",flexDirection:"column",flex:1,minHeight:0,width:"min(1040px, calc(100% - 32px))",margin:"16px auto",overflow:"hidden"}}>
      <WorkspaceTabs<"actions" | "changes"> id="qa-native" label="Native additions" value={tab} onChange={setTab} items={[{id:"actions",icon:"clock",label:"Actions 步骤"},{id:"changes",icon:"changes",label:"实际文件变更"}]} />
      {!preview ? <p role="status">此验收页未连接 Host，没有真实作业或会话变更。</p> : tab === "changes" ? <PreviewChanges focusPath={PREVIEW_DIFF.file} /> : <>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"12px 0"}}><button className="btn small outline" onClick={() => setFailed(value => !value)}>{failed ? "查看运行中作业" : "查看失败作业"}</button><button className="btn small outline" onClick={() => setProcess(value => !value)}>{process ? "详情呈现" : "进程呈现"}</button></div>
        {show ? <JobInspector job={{id,label:failed ? "Renderer checks · 失败" : "Renderer checks · 观察中",status:failed ? "failed" : "running",generation:1}} client={undefined} sessionId="qa-native" available={false} previewInspection={inspections[id]!} presentation={process ? "process" : "details"} onClose={() => setShow(false)} /> : <button className="btn outline" onClick={() => setShow(true)}>重新打开详情</button>}
      </>}
    </main>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><Surface /></PreviewModeProvider></I18nProvider>);
import.meta.hot?.dispose(() => root.unmount());
