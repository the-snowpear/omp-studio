import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { TimeTravelEntry } from "../history/TimeTravelActivation";
import { HistoryPage } from "../HistoryPage";
import { TimeTravelSettings } from "../settings/TimeTravelSettings";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/pages.css";
import "../styles/typography.css";
import "../styles/tabs.css";

function Harness() {
  const [page, setPage] = useState("history");
  const [theme, setTheme] = useState("light");
  document.documentElement.dataset.theme = theme;
  return (
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <div
          style={{
            minHeight: "100vh",
            background: "var(--bg)",
            padding: "24px clamp(16px, 4vw, 56px)",
          }}
        >
          <header
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              borderBottom: "1px solid var(--border)",
              paddingBottom: 18,
              marginBottom: 28,
            }}
          >
            <strong style={{ marginRight: "auto" }}>OMP Studio</strong>
            <TimeTravelEntry onOpen={() => setPage("history")} />
            <button
              className="btn small outline"
              onClick={() =>
                setPage(page === "history" ? "settings" : "history")
              }
            >
              {page === "history" ? "设置" : "会话历史"}
            </button>
            <button
              className="btn small outline"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              切换主题
            </button>
          </header>
          {page === "history" ? (
            <HistoryPage onRoute={() => {}} onSelectThread={() => {}} />
          ) : (
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              <TimeTravelSettings visible />
            </div>
          )}
        </div>
      </PreviewModeProvider>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
