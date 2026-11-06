/** Manual browser QA: the real dock tab strip hosting web pages as tabs, in preview data. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserElementReference } from "@omp-studio/studio-protocol";
import type { StudioClient } from "@omp-studio/client-contract";
import { BrowserDockInstances } from "../browser/BrowserDockInstances";
import { BrowserPane } from "../browser/BrowserPane";
import { browserHub } from "../browser/browserSessions";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { browserReferenceSnapshot } from "../composer/browserReference";
import { emptySnapshot } from "../composer/types";
import { DockProvider, useDock } from "../dock/DockContext";
import { DockFloatingLayer, DockGroupRegion, DockRail } from "../dock/DockRegions";
import { PanelRegistration } from "../dock/PanelRegistration";
import { DockStore } from "../dock/store";
import { I18nProvider } from "../i18n";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider } from "../preview/PreviewContext";
import type { createPreviewBrowserBackend } from "../preview/managedBrowserPreview";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/sidebar.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../App.css";
import "../dock/dock.css";
import "../dock/menus.css";
import "../dock/integration.css";

const unavailable = () => { throw new Error("This UI harness must not call the Host."); };
const client = { command: unavailable, query: unavailable } as unknown as StudioClient;
const params = new URLSearchParams(location.search);
const scope = (chat: string) => ({ target: "preview", project: "browser-qa", session: chat });
const store = new DockStore(null);
store.switchScope(scope("browser-qa-a"), true);
store.dispatch({ type: "region", region: "right", visible: true });
store.dispatch({ type: "activate", groupId: "right-main", panel: "browser" });

function Surface() {
  const { layout, store: dock, scope: current } = useDock();
  const [width, setWidth] = useState(Number(params.get("width")) || 760);
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [chat, setChat] = useState("browser-qa-a");
  const [, setSnapshot] = useState(emptySnapshot);
  const composer = useRef<ChipComposerHandle>(null);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const onReferences = (references: BrowserElementReference[]) => {
    for (const element of references) {
      const reference = browserReferenceSnapshot(element);
      composer.current?.insertChip({ kind: "browser", label: reference.title, reference });
    }
    composer.current?.focus();
  };
  return <>
    <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}>
      <strong style={{ marginRight: 8 }}>Browser 验收</strong>
      {[760, 520, 380].map(value => <button key={value} className={`btn small${width === value ? " primary" : " outline"}`} onClick={() => setWidth(value)}>{value}px</button>)}
      <button className="btn small outline" onClick={() => setDark(value => !value)}>深浅主题</button>
      <button className="btn small outline" onClick={() => { const next = chat.endsWith("a") ? "browser-qa-b" : "browser-qa-a"; dock.switchScope(scope(next), true); setChat(next); }}>切换对话（{chat.slice(-1)}）</button>
      <button className="btn small outline" onClick={() => {
        (browserHub(true)!.backend as ReturnType<typeof createPreviewBrowserBackend>).agentOpen(chat, "http://localhost:6006/?path=/story/badge");
      }}>模拟 Agent 新开网页</button>
    </header>
    <main className="adaptive-workbench" style={{ display: "flex", position: "relative", height: "calc(100vh - 45px)", background: "var(--bg)", color: "var(--text)", "--dock-rail-w": `${layout.rail.width}px` } as CSSProperties}>
      <div className="convo-wrap" style={{ flex: 1, position: "relative", minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <div className="composer-region" style={{ padding: 12 }}><ChipComposer ref={composer} ariaLabel="对话输入框" placeholder="选中的元素会以引用胶囊进入这里…" onChange={setSnapshot} /></div>
        <DockRail mode={layout.rail.mode} />
      </div>
      <aside className="side-panel open" style={{ position: "relative", width: layout.right.visible ? width : 0, flex: "none", overflow: "hidden" }}>
        <DockGroupRegion region="right" visible={layout.right.visible} />
      </aside>
    </main>
    <PanelRegistration panels={{ browser: visibility => <BrowserPane client={client} chatId={current.session} available={false} visible={visibility.visible} /> }} />
    <BrowserDockInstances sessionId={current.session} available={false} capabilities={undefined} remote={false} onReferences={onReferences} />
    <DockFloatingLayer />
  </>;
}
createRoot(document.getElementById("root")!).render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider></I18nProvider></PreviewModeProvider>);
