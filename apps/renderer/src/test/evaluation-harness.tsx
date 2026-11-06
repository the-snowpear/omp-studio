import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { EvaluationPage } from "../evaluation/EvaluationPage";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/pages.css";
import "../styles/typography.css";
import "../App.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const client = {
  command: () => {
    throw new Error("Preview must not invoke Host");
  },
  query: () => {
    throw new Error("Preview must not query Host");
  },
} as unknown as StudioClient;
createRoot(document.getElementById("root")!).render(
  <I18nProvider forcedLanguage={params.get("lang") === "en" ? "en" : "zh"}>
    <PreviewModeProvider switchEnabled>
      <main className="page-body" style={{ height: "100dvh" }}>
        <EvaluationPage client={client} available={false} />
      </main>
    </PreviewModeProvider>
  </I18nProvider>,
);
