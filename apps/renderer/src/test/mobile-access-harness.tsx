/** 设置 → 手机访问验收：预览 fixture 下的三步配对流程。`?w=` 设栏宽，`?theme=dark` 看深色；按钮在同一挂载页面切换中英文。不接 Host。 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { MobileAccessSettings } from "../settings/MobileAccessSettings";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/pages.css";

const query = new URLSearchParams(location.search);
document.documentElement.setAttribute("data-theme", query.get("theme") === "dark" ? "dark" : "light");

function Harness() {
  const { resolvedLanguage, setLanguage } = useI18n();
  const [width] = useState(() => Number(query.get("w")) || 760);
  return <div style={{ maxWidth: width, margin: "0 auto", padding: "8px 24px 32px", height: "100vh", overflow: "auto", background: "var(--bg)" }}>
    <button type="button" className="btn small outline" id="harness-language" onClick={() => setLanguage(resolvedLanguage === "zh" ? "en" : "zh")}>{resolvedLanguage === "zh" ? "EN" : "中文"}</button>
    <MobileAccessSettings preview />
  </div>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><PreviewModeProvider><Harness /></PreviewModeProvider></I18nProvider>);
