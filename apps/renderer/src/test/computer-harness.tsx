import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { AppSelect } from "../AppSelect";
import { ComputerPane } from "../browser/ComputerPane";
import { ComputerLinkProvider } from "../computer/links";
import type { ComputerFrameIntent } from "../computer/types";
import { ToolBody } from "../conversation/ToolBody";
import { DockProvider, DockPanel } from "../dock/DockContext";
import { DockFloatingLayer, DockGroupRegion } from "../dock/DockRegions";
import { DockStore } from "../dock/store";
import { SurfaceProvider } from "../dock/SurfaceContext";
import { I18nProvider } from "../i18n";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { COMPUTER_PREVIEW_SCENARIOS, COMPUTER_PREVIEW_SCENARIO_LABELS, type ComputerPreviewScenario } from "../preview/computerPreview";
import { TipHost } from "../TipHost";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../dock/dock.css";

const unavailable = () => { throw new Error("Computer harness must not call the Host"); };
const client = { query: unavailable, command: unavailable, subscribe: unavailable } as unknown as StudioClient;
function Harness() {
  const [scenario, setScenario] = useState<ComputerPreviewScenario>("running");
  const [wide, setWide] = useState(true), [low, setLow] = useState(false), [dark, setDark] = useState(false), [visible, setVisible] = useState(true), [docked, setDocked] = useState(false);
  const [session, setSession] = useState("computer-qa-a"), [intent, setIntent] = useState<ComputerFrameIntent>();
  const [store] = useState(() => { const value = new DockStore(); value.switchScope({ target: "local", project: "computer-qa", session: "computer-qa-a" }, true); value.dispatch({ type: "move", panels: ["computer"], target: { region: "right" } }); return value; });
  const [message, setMessage] = useState("");
  const container = useRef<HTMLElement>(null);
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setMeasured(current => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const width = wide ? 1080 : 360, height = low ? 230 : 670;
  const content = (size: { visible: boolean; width: number; height: number }) => <ComputerPane client={client} sessionId={session} sessionName={session.endsWith("a") ? "检查电脑工作区" : "另一段对话"} scopeKey={session} executionTarget={{ kind: "local" }} available={false} visible={size.visible && visible} width={size.width} height={size.height} previewScenario={scenario} frameIntent={intent} onRevealConversation={() => { setMessage("已定位隔离对话示例；本页不提交消息。"); return Promise.resolve(true); }} />;
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><PreviewSurface preview><SurfaceProvider document={document}><DockProvider definitions={WORKBENCH_PANELS} store={store}><ComputerLinkProvider onOpen={frame => { setIntent({ ...frame, id: crypto.randomUUID() }); store.dispatch({ type: "open", panel: "computer" }); }}>
    <main style={{ padding: 16, minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}><strong style={{ marginRight: "auto" }}>Computer · 隔离验收</strong><AppSelect aria-label="状态场景" value={scenario} onChange={event => { setScenario(event.target.value as ComputerPreviewScenario); setIntent(undefined); }}>{COMPUTER_PREVIEW_SCENARIOS.map(value => <option value={value} key={value}>{COMPUTER_PREVIEW_SCENARIO_LABELS[value]}</option>)}</AppSelect><button className="btn small outline" onClick={() => setWide(value => !value)}>宽窄切换</button><button className="btn small outline" onClick={() => setLow(value => !value)}>低高度</button><button className="btn small outline" onClick={() => setDark(value => !value)}>深浅主题</button><button className="btn small outline" onClick={() => setVisible(value => !value)}>显示 / 隐藏</button><button className="btn small outline" onClick={() => { setSession(value => value.endsWith("a") ? "computer-qa-b" : "computer-qa-a"); setIntent(undefined); }}>切换会话</button><button className="btn small outline" onClick={() => setDocked(value => !value)}>真实 Dock</button></header>
      <section ref={container} style={{ width, maxWidth: "100%", height, margin: "auto", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", position: "relative" }}>
        {docked ? <DockGroupRegion region="right" visible={visible} /> : content({ visible, ...measured })}
      </section>
      {docked ? <DockPanel id="computer">{content}</DockPanel> : null}<DockFloatingLayer />
      <section style={{ width, maxWidth: "100%", margin: "12px auto", padding: 12, border: "1px solid var(--border)", borderRadius: 12 }}><h3>Eval 内嵌 Computer · 同帧联动</h3><ToolBody tool={{ toolName: "eval", toolCallId: "computer-preview-eval", status: "succeeded", result: { type: "toolResult", toolName: "eval", toolCallId: "computer-preview-eval", isError: false, data: { cells: [{ code: "await computer.screenshot()", stdout: "Captured the target window.", status: "completed" }], media: [{ computerFrame: { frameId: "computer-preview-frame-1", sessionId: session, toolCallId: "computer-preview-eval" } }] } } }} />{message ? <p role="status">{message}</p> : null}</section>
    </main><TipHost />
  </ComputerLinkProvider></DockProvider></SurfaceProvider></PreviewSurface></PreviewModeProvider></I18nProvider>;
}
if (!new URL(location.href).searchParams.has("dockHost")) createRoot(document.getElementById("root")!).render(<Harness />);
