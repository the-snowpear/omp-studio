/** Exercise production viewers and dock hosts with the isolated preview fixtures. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { DockProvider } from "../dock/DockContext";
import { DockFloatingLayer, DockGroupRegion } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { ExecutionTargets } from "../workspaces/ExecutionTargets";
import { I18nProvider } from "../i18n";
import { FileDockInstances } from "../files/FileDockInstances";
import { useOpenFile } from "../files/fileLinks";
import { FileCloseDialog } from "../files/FileCloseDialog";
import { FileViewerSettings, OfficeComponentSettings } from "../files/FileViewerSettings";
import { MarkdownText } from "../conversation/markdown";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../App.css";
import "../dock/dock.css";
import "../dock/menus.css";
import "../dock/integration.css";
const client = { command: () => { throw new Error("Preview must not write to Host"); }, query: () => { throw new Error("Preview must not read Host"); } } as unknown as StudioClient;
const store = new DockStore(null); store.switchScope({ target: "local", project: "files-qa", session: "file-chat-a" }, true);
function Harness() {
  const open = useOpenFile(), [settings, setSettings] = useState(false);
  return <div data-dock-workbench style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: 20 }}>
    <header style={{ display: "flex", gap: 12, alignItems: "center" }}><strong>文件窗口验收</strong><button className="btn outline" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>切换主题</button><button className="btn outline" onClick={() => setSettings(value => !value)}>设置</button></header>
    <nav style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "18px 0" }}>{["README.md", "src/main.ts", "package.json", "report.pdf", "image.svg", "usage.csv", "report.xlsx", "sound.wav", "clip.webm", "report.docx", "slides.pptx"].map(path => <button className="btn small outline" key={path} onClick={() => open({ path, workspaceId: "files-qa" })}>{path}</button>)}</nav>
    <MarkdownText text={'[打开代码](src/main.ts:2) 和行内文件路径 `README.md`。'} />
    {settings ? <div style={{ maxWidth: 900 }}><FileViewerSettings /><OfficeComponentSettings /></div> : null}
    <aside style={{ position: "absolute", right: 0, top: 150, width: 440, height: "calc(100vh - 150px)" }}><DockGroupRegion region="right" visible /></aside>
    <FileDockInstances client={client} workspaceId="files-qa" targetId={null} onSettings={() => setSettings(true)} />
    <DockFloatingLayer /><FileCloseDialog />
  </div>;
}
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><ExecutionTargets client={client}>{() => <DockProvider definitions={WORKBENCH_PANELS} store={store}><Harness /></DockProvider>}</ExecutionTargets></I18nProvider></PreviewModeProvider>);
