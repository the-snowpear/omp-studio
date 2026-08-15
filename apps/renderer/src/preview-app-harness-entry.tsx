/**
 * 临时预览 harness：渲染完整 App 工作台（预览模式数据）。
 * 仅用于本地 UI 验证，不属于产品代码。
 */
import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientTransport } from "@omp-studio/client-contract";
import { createContractFixtureApi } from "@omp-studio/testkit";

import { App } from "./App";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sidebar.css";
import "./styles/workbench.css";
import "./styles/pages.css";
import "./styles/agent-hub.css";
import "./styles/models-roles.css";
import "./App.css";

const host = document.getElementById("root");
if (host !== null) {
  const transport = createContractFixtureApi() as unknown as ClientTransport;
  const client = new StudioClientImpl(transport);
  createRoot(host).render(<App client={client} />);
}
