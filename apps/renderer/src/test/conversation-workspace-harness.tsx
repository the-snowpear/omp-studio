/** Isolated native-window acceptance: production App/docking/PTY, no model calls. */
import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientContextScope, ClientTransport } from "@omp-studio/client-contract";
import { contractFixtures } from "@omp-studio/testkit";
import { App } from "../App";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "../settings/startupNotice";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID } from "../onboarding/onboardingState";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/sidebar.css";
import "../styles/workbench.css";
import "../styles/pages.css";
import "../styles/agent-hub.css";
import "../styles/models-roles.css";
import "../styles/btw.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../App.css";

function transport(scope?: ClientContextScope): ClientTransport {
  return {
    openContext: async scope => transport(scope),
    bootstrap: async () => {
      const value = structuredClone(contractFixtures.bootstrap);
      if (scope?.sessionId && value.snapshot) return { ...value, snapshot: { ...value.snapshot, sessionId: scope.sessionId }, selected: { ...value.selected, workspaceId: scope.workspaceId, sessionId: scope.sessionId } };
      return value;
    },
    query: async request => structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]) as never,
    command: async () => { throw new Error("验收窗口不执行模型或工作区写操作。"); },
    subscribe: () => () => {}, close: async () => {},
  };
}
if (!new URL(location.href).searchParams.has("dockHost")) {
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
  document.documentElement.dataset.platform = "win32";
  createRoot(document.getElementById("root")!).render(<App client={new StudioClientImpl(transport())} />);
}
