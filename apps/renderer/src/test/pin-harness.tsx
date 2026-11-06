/** Isolated acceptance surface: production docking, composer and local terminal. No model calls. */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { DockProvider, DockPanel, useDock } from "../dock/DockContext";
import { DockFloatingLayer, DockCardRegion, DockGroupRegion } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { TerminalSessionsProvider } from "../terminalSessions";
import { TerminalPane } from "../TerminalPane";
import { AppSelect } from "../AppSelect";
import { TipHost } from "../TipHost";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../App.css";

function Draft() {
  const composer = useRef<ChipComposerHandle>(null);
  const [selection, setSelection] = useState("one");
  return <section style={{ padding: 18 }}><h3>Explorer · 面板连续性验收</h3><label>保留输入 <input aria-label="保留输入" defaultValue="未保存草稿" /></label>
    <AppSelect aria-label="浮窗下拉" value={selection} onChange={event => setSelection(event.target.value)}><option value="one">第一项</option><option value="two">第二项</option></AppSelect>
    <ChipComposer ref={composer} ariaLabel="浮窗编辑器" placeholder="弹出前后继续输入" onChange={() => {}} onSubmit={() => {}} />
    <button onClick={() => composer.current?.insertChip({ kind: "file", label: "example.ts", path: "example.ts" })}>插入文件引用</button>
  </section>;
}
function Surface() {
  const { store, scope } = useDock();
  const [page, setPage] = useState(false);
  const [dark, setDark] = useState(false);
  return <div className="app" style={{ height: "100vh" }}>
    <header style={{ display: "flex", gap: 8, padding: 12 }}>
      <button onClick={() => setPage(value => !value)}>{page ? "返回工作台" : "打开设置页"}</button>
      <button onClick={() => store.switchScope({ ...scope, session: scope.session === "a" ? "b" : "a" }, false)}>切换会话</button>
      <button onClick={() => store.switchScope({ ...scope, project: scope.project === "one" ? "two" : "one" }, false)}>切换工作区</button>
      <button onClick={() => store.dispatch({ type: "open", panel: "files" })}>打开 Explorer</button>
      <button onClick={() => store.dispatch({ type: "move", panels: ["terminal"], target: { region: "float", rect: { x: 550, y: 80, width: 600, height: 420 } } })}>浮动 Terminal</button>
      <button onClick={() => { setDark(!dark); document.documentElement.dataset.theme = dark ? "light" : "dark"; }}>切换主题</button>
      <button onClick={() => store.resetPreset()}>重置布局</button>
      <button onClick={() => { void (globalThis as typeof globalThis & { pinAcceptance?: { closeMain(): Promise<void> } }).pinAcceptance?.closeMain(); }}>关闭主窗</button>
      <span>{scope.project} / {scope.session}</span>
    </header>
    <div className="app-shell" style={{ flex: 1 }}>
      {page && <section style={{ padding: 40 }}>设置页面：固定浮窗应继续显示</section>}
      <div className="adaptive-workbench" hidden={page} inert={page} style={{ flex: 1, height: "100%" }}><DockCardRegion region="left" /><DockGroupRegion region="bottom" visible /></div>
    </div>
    <DockPanel id="files"><Draft /></DockPanel><DockPanel id="terminal">{visibility => <TerminalPane visible={visibility.visible} workspaceId="one" />}</DockPanel>
    <DockFloatingLayer /><TipHost />
  </div>;
}
if (!new URL(location.href).searchParams.has("dockHost")) {
  const store = new DockStore(); store.switchScope({ target: "local", project: "one", session: "a" }, false);
  if (!store.getSnapshot().layout.floats.length) store.dispatch({ type: "move", panels: ["files"], target: { region: "float", rect: { x: 80, y: 60, width: 560, height: 400 } } });
  document.documentElement.dataset.theme = "light";
  createRoot(document.getElementById("root")!).render(<I18nProvider><PreviewModeProvider><DockProvider definitions={WORKBENCH_PANELS} store={store}><TerminalSessionsProvider><Surface /></TerminalSessionsProvider></DockProvider></PreviewModeProvider></I18nProvider>);
}
