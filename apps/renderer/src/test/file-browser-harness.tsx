/** 文件浏览器验收：可拖宽度的舞台看三档视图，另可在真实 Dock 浮窗里打开。只用预览 fixture，不接 Host。 */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { DockProvider, useDock } from "../dock/DockContext";
import { DockFloatingLayer, DockGroupRegion } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { ExecutionTargets } from "../workspaces/ExecutionTargets";
import { I18nProvider } from "../i18n";
import { FileDockInstances } from "../files/FileDockInstances";
import { FileCloseDialog } from "../files/FileCloseDialog";
import type { FileViewerActions } from "../files/fileActions";
import { FileBrowserDock } from "../fileBrowser/FileBrowserDock";
import { FileBrowserPanel } from "../fileBrowser/FileBrowserPanel";
import { createPreviewFileBrowserSource } from "../preview/fileBrowserPreview";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../styles/sidebar.css";
import "../styles/motion.css";
import "../App.css";
import "../dock/dock.css";
import "../dock/menus.css";
import "../dock/integration.css";

const client = { command: () => { throw new Error("Preview must not write to Host"); }, query: () => { throw new Error("Preview must not read Host"); } } as unknown as StudioClient;
const store = new DockStore(null); store.switchScope({ target: "local", project: "browser-qa", session: "file-browser-a" }, true);
const WIDTHS = [{ label: "窄 · 380", width: 380 }, { label: "中 · 720", width: 720 }, { label: "宽 · 1120", width: 1120 }] as const;

function Harness() {
  const dock = useDock();
  const [width, setWidth] = useState(1120);
  const [real, setReal] = useState(false);
  const [context, setContext] = useState<string[]>([]);
  const source = useMemo(() => createPreviewFileBrowserSource(), []);
  const actions: FileViewerActions = { openers: [], runShell: () => {}, addContext: input => setContext(previous => [...previous.slice(-3), input.path]) };
  return <div data-dock-workbench style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: 20, boxSizing: "border-box" }}>
    <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
      <strong style={{ marginRight: 8 }}>文件浏览器验收</strong>
      {WIDTHS.map(item => <button key={item.width} className={`btn small ${width === item.width ? "primary" : "outline"}`} onClick={() => setWidth(item.width)}>{item.label}</button>)}
      <button className="btn small outline" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>切换主题</button>
      <button className={`btn small ${real ? "primary" : "outline"}`} onClick={() => setReal(value => !value)}>{real ? "真实模式（未接入）" : "预览数据"}</button>
      <button className="btn small outline" onClick={() => dock.store.dispatch({ type: "open", panel: "file-browser" })}>在 Dock 浮窗中打开</button>
      <span data-testid="composer-context" className="muted small">Composer：{context.length ? context.join("、") : "（空）"}</span>
    </header>
    <div data-testid="stage" style={{ width, maxWidth: "100%", height: 560, resize: "both", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow-sm)" }}>
      <PreviewSurface preview={!real}>
        <FileBrowserPanel panelId="harness" scope={real ? "harness-real" : "harness-preview"} source={real ? null : source}
          unavailable={{ title: "文件浏览器尚未接入", detail: "浏览整台电脑需要新版 Host 提供全机文件读取；目前可以用左下角 Explorer 查看当前项目。" }}
          onAddContext={entry => actions.addContext({ path: entry.path, label: entry.name })} />
      </PreviewSurface>
    </div>
    <p className="muted small" style={{ marginTop: 8 }}>拖动舞台右下角改变宽度：&lt;480 单树，480–900 位置栏 + 列表，≥900 默认分栏；工具栏右侧可显式切换。</p>
    <aside style={{ position: "absolute", right: 0, top: 640, width: 440, height: 420 }}><DockGroupRegion region="right" visible /></aside>
    <FileBrowserDock targetId={null} actions={actions} />
    <FileDockInstances workspaceId="browser-qa" targetId={null} onSettings={() => {}} actions={actions} />
    <DockFloatingLayer /><FileCloseDialog />
  </div>;
}
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><ExecutionTargets client={client}>{() => <DockProvider definitions={WORKBENCH_PANELS} store={store}><Harness /></DockProvider>}</ExecutionTargets></I18nProvider></PreviewModeProvider>);
