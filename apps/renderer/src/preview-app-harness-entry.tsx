/**
 * 临时预览 harness：渲染完整 App 工作台（预览模式数据）。
 * 仅用于本地 UI 验证，不属于产品代码。
 *
 * 打开 `preview-app-harness.html?preview=1` 会强制预览夹具，便于截图。
 */
import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientTransport } from "@omp-studio/client-contract";
import { createContractFixtureApi } from "@omp-studio/testkit";

import { App } from "./App";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sidebar.css";
import "./styles/workbench.css";
import "./styles/pages.css";
import "./styles/agent-hub.css";
import "./styles/models-roles.css";
import "./styles/btw.css";
import "./App.css";

try {
  window.localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  window.localStorage.setItem("omp.appSettings", JSON.stringify({
    theme: "light",
    density: "standard",
    startupPage: "workbench",
    restoreLastProject: true,
    restoreLastSession: true,
    rememberLayout: false,
    toolActivity: "concise",
  }));
  window.localStorage.setItem("omp.gitGraphLayout", JSON.stringify({ open: true, splitRatio: 0.46 }));
} catch {
  /* storage blocked */
}
document.documentElement.setAttribute("data-theme", "light");
document.documentElement.setAttribute("data-density", "standard");

const host = document.getElementById("root");
if (host !== null) {
  const transport = createContractFixtureApi() as unknown as ClientTransport;
  const client = new StudioClientImpl(transport);
  createRoot(host).render(<App client={client} />);
}
