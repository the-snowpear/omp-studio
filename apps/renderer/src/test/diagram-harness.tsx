/** Product diagram and window components, with explicit local text fixtures and no model calls. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DockProvider } from "../dock/DockContext";
import { DockFloatingLayer } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { MarkdownText } from "../conversation/markdown";
import { DiagramDockInstances } from "../diagrams/DiagramDockInstances";
import { PREVIEW_MERMAID_LARGE, PREVIEW_MERMAID_WIDE } from "../preview/mermaidPreview";
import { WORKBENCH_PANELS } from "../panels/registry";
import { TipHost } from "../TipHost";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../App.css";

function Harness() {
  const params = new URLSearchParams(location.search);
  const [language, setLanguage] = useState<"zh" | "en">(params.get("lang") === "en" ? "en" : "zh");
  const [preview, setPreview] = useState(params.get("preview") === "1");
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [store] = useState(() => {
    const value = new DockStore(); value.switchScope({ target: "local", project: "diagram-qa", session: "diagram-qa" }, preview); return value;
  });
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const zh = language === "zh";
  return <I18nProvider forcedLanguage={language}><PreviewModeProvider><PreviewSurface preview={preview}>
    <DockProvider definitions={WORKBENCH_PANELS} store={store}>
      <main className="app" style={{ height: "100vh" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, borderBottom: "1px solid var(--border)" }}>
          <strong style={{ marginRight: "auto" }}>{zh ? "图表查看验收 · 本地文本夹具" : "Diagram verification · Local text fixtures"}</strong>
          <button className="btn small" onClick={() => setLanguage(zh ? "en" : "zh")}>{zh ? "English" : "中文"}</button>
          <button className="btn small" onClick={() => setDark(value => !value)}>{dark ? zh ? "浅色" : "Light" : zh ? "深色" : "Dark"}</button>
          <button className="btn small" aria-pressed={preview} onClick={() => { store.switchScope(store.getSnapshot().scope, !preview); setPreview(value => !value); }}>{zh ? "预览显示" : "Preview display"}</button>
        </header>
        <div className="app-shell" data-dock-workbench style={{ flex: 1, minHeight: 0 }}>
          <div className="adaptive-workbench" style={{ width: "100%", height: "100%", overflow: "auto" }}>
            <div className="ev-body" style={{ width: "min(660px, calc(100% - 48px))", margin: "24px auto" }}>
              <MarkdownText text={zh ? "## 会话里的大型图表\n\n在原尺寸浮窗中阅读，旁边的会话内容保持原位。" : "## Large diagrams in a conversation\n\nRead at actual size in a diagram window while the conversation stays in place."} />
              <MarkdownText text={"```mermaid\n" + PREVIEW_MERMAID_LARGE + "\n```"} />
              <MarkdownText text={"```mermaid\n" + PREVIEW_MERMAID_WIDE + "\n```"} />
            </div>
          </div>
        </div>
        <DiagramDockInstances /><DockFloatingLayer /><TipHost />
      </main>
    </DockProvider>
  </PreviewSurface></PreviewModeProvider></I18nProvider>;
}

if (!new URL(location.href).searchParams.has("dockHost")) createRoot(document.getElementById("root")!).render(<Harness />);
