// Isolated QA entry; excluded from packaged inputs and never connects to a Host.
import { ResumeScopePane } from "../history/ResumeScopePane";
import { AdvisorConfigPane } from "../settings/AdvisorConfigPane";
import { LocalFilesPane } from "../capabilities/LocalFilesPane";
import { DictationControl } from "../composer/DictationControl";
import { createContractFixtureApi } from "@omp-studio/testkit";
import { StudioClientImpl } from "@omp-studio/client";
import { ContextInspector } from "../conversation/ContextInspector";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { FeatureSettingsPane } from "../settings/FeatureSettingsPane";
import { SessionBudgetPane } from "../models/SessionBudgetPane";
import { AskBody } from "../deck/AskCard";
import type { DeckAskAnswer } from "../deck/types";
import { submitAskValue } from "../deck/askContent";
import { ApprovalCard } from "../deck/ApprovalCard";
import { approvalFromInteraction } from "../deck/approvalContent";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/pages.css";
import "../App.css";
import "../models/sessionOptions.css";

const client = new StudioClientImpl(createContractFixtureApi() as never);
function Surface() {
  const [contextOpen, setContextOpen] = useState(false);
  const [answer, setAnswer] = useState<DeckAskAnswer>({ picked: ["保留", "压缩"], custom: "", note: "只压缩旧日志", noteOption: "压缩" });
  const [result, setResult] = useState("");
  const view = approvalFromInteraction({ kind: "approval", interactionId: "qa", sessionId: "qa", leaseGeneration: 1, title: "受限目录操作", approvalType: "read", detail: { source: "restriction", path: "private/credentials", reason: "每次都需批准" } } as never);
  return <main style={{ padding: 24, maxWidth: 960, margin: "auto", display: "grid", gap: 24 }}>
    <h1>OMP 18.13.2 · 隔离迁移验收</h1><p>以下控件使用正式组件与预览 fixture；不连接 Host、不写真实配置、不调用模型。</p>
    <button className="btn outline" onClick={() => setContextOpen(true)}>打开上下文查看器</button><ContextInspector client={client} sessionId="demo-context" visible={contextOpen} onClose={() => setContextOpen(false)} />
    <ResumeScopePane client={client} />
    <AdvisorConfigPane client={client} visible />
    <LocalFilesPane client={client} available={false} />
    <DictationControl client={client} available={false} onText={setResult} />
    <SessionBudgetPane available={false} />
    <FeatureSettingsPane group="permissions" visible />
    <FeatureSettingsPane group="interaction" visible />
    <FeatureSettingsPane group="context" visible />
    <FeatureSettingsPane group="voice" visible />
    <section className="deck"><h2>多选备注归属</h2><AskBody question={{ id: "q", question: "本次处理哪些内容？", multi: true, acceptImages: false, options: [{ label: "保留" }, { label: "压缩" }] }} answer={answer} onPick={label => setAnswer(current => ({ ...current, picked: current.picked.includes(label) ? current.picked.filter(value => value !== label) : [...current.picked, label] }))} onCustom={custom => setAnswer(current => ({ ...current, custom }))} onPatch={patch => setAnswer(current => ({ ...current, ...patch }))} onSubmit={() => setResult(JSON.stringify(submitAskValue([{ id: "q", question: "Q", options: [], multiple: true }], { q: answer })))} /><button className="btn" onClick={() => setResult(JSON.stringify(submitAskValue([{ id: "q", question: "Q", options: [], multiple: true }], { q: answer })))}>显示提交内容</button><pre aria-label="提交结果">{result}</pre></section>
    <ApprovalCard view={view} demo onAllow={() => setResult("本次批准")} onAlways={() => setResult("不应出现")} onDeny={() => setResult("已拒绝")} />
  </main>;
}
const mounted = createRoot(document.getElementById("root")!);
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
mounted.render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled={new URLSearchParams(location.search).get("preview") === "1"}><Surface /></PreviewModeProvider></I18nProvider>);
import.meta.hot?.dispose(() => mounted.unmount());
