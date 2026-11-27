/** Web 控制条验收：四种控制状态 × 宽 / 窄停靠栏，同页切换中英文。`?theme=dark` 看深色。
    浮动形态：聚焦任一手柄按方向键（或直接拖动），Home 回到停靠。不接 Host。 */
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "../i18n";
import { WebControlBar, type WebControlHolder } from "../web/WebControlBar";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../web/web.css";

const query = new URLSearchParams(location.search);
document.documentElement.setAttribute("data-theme", query.get("theme") === "dark" ? "dark" : "light");

const samples: { id: string; holder: WebControlHolder; demo?: boolean; signIn?: boolean }[] = [
  { id: "self", holder: { kind: "self" } },
  { id: "other", holder: { kind: "other", name: "iPad Pro" } },
  { id: "long", holder: { kind: "other", name: "工作室共享的 MacBook Pro（客厅那台带外接显示器的）" }, signIn: true },
  { id: "free", holder: { kind: "free" }, demo: true },
];

function Harness() {
  const { resolvedLanguage, setLanguage } = useI18n();
  return <div style={{ minHeight: "100vh", padding: 24, background: "var(--bg)", color: "var(--text)", display: "grid", gap: 20 }}>
    <button type="button" className="btn small outline" id="harness-language" style={{ justifySelf: "start" }}
      onClick={() => setLanguage(resolvedLanguage === "zh" ? "en" : "zh")}>{resolvedLanguage === "zh" ? "EN" : "中文"}</button>
    {[880, 360].map(width => <div key={width} style={{ display: "grid", gap: 12 }}>
      {samples.map(sample => <div key={sample.id} data-sample={`${sample.id}-${width}`}
        style={{ width, display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ height: 36, background: "var(--bg)" }} />
        <WebControlBar holder={sample.holder} demo={Boolean(sample.demo)} busy={false} onTakeControl={() => {}}
          manageOpen={false} onManage={() => {}} authorizationUrl={sample.signIn ? "https://example.invalid/sign-in" : undefined} />
      </div>)}
    </div>)}
  </div>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><Harness /></I18nProvider>);
