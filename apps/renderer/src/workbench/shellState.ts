import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type { AuthorityEpoch, AuthorityId, ClientBootstrap, ClientError, ClientEvent } from "@omp-studio/client-contract";
import { shouldRecordShellEvent, toShellEventLogEntry } from "../shellMemory";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { type IconName } from "../icons";
import { type TranslationParams } from "../i18n";
import { getAppSettings, readLastRoute } from "../settings/appSettings";
import { desktopNotice, notifyAskConfirmation, clearAskConfirmationNotice } from "../settings/desktopNotice";
import { type Action, type Route, type SecondaryRoute, type ViewState } from "./types";

const KNOWN_ROUTES: ReadonlyArray<Route> = ["home", "workbench", "history", "agent-hub", "capabilities", "model-config", "settings", "diagnostics", "media", "evaluation", "statistics"];

function parseStoredRoute(value: string | undefined): Route | undefined {
  return value !== undefined && (KNOWN_ROUTES as readonly string[]).includes(value) ? (value as Route) : undefined;
}

/** 启动落地页：不恢复最近项目时停首页；「上次页面」读持久化的 route。 */
export function initialRouteFromSettings(): Route {
  const settings = getAppSettings();
  if (!settings.restoreLastProject) return "home";
  if (settings.startupPage === "home") return "home";
  if (settings.startupPage === "last") return parseStoredRoute(readLastRoute()) ?? "workbench";
  return "workbench";
}

/** App 级系统通知：由 ClientEvent 流触发，偏好开关在 desktopNotice 内判断。 */
export function notifyFromEvent(event: ClientEvent, t: (key: string, params?: TranslationParams) => string): void {
  if (event.kind === "interaction.required") {
    notifyAskConfirmation(event.interaction.interactionId, event.interaction.leaseGeneration, event.interaction.title);
    return;
  }
  if (event.kind === "interaction.resolved") {
    clearAskConfirmationNotice(event.interactionId, event.leaseGeneration);
    return;
  }
  if (event.kind === "command.receipt" && event.receipt.status === "failed") {
    desktopNotice("error", t("shell.commandFailed"), event.receipt.error.message);
    return;
  }
  if (event.kind === "resync.required") {
    desktopNotice("error", t("shell.resyncRequired"), event.reason);
  }
}

export function isSecondary(route: Route): route is SecondaryRoute {
  return route === "home" || route === "history" || route === "agent-hub" || route === "capabilities" || route === "model-config" || route === "settings" || route === "diagnostics" || route === "media" || route === "evaluation" || route === "statistics";
}

export const SECONDARY_META: Record<SecondaryRoute, { titleKey: string; icon: IconName }> = {
  statistics: {titleKey:"nav.statistics",icon:"pulse"},
  home: { titleKey: "nav.home", icon: "home" },
  history: { titleKey: "nav.history", icon: "history" },
  "agent-hub": { titleKey: "nav.agentHub", icon: "bot" },
  capabilities: { titleKey: "nav.capabilities", icon: "package" },
  "model-config": { titleKey: "nav.modelConfig", icon: "server" },
  settings: { titleKey: "nav.settings", icon: "settings" },
  diagnostics: { titleKey: "nav.diagnostics", icon: "pulse" },
  evaluation: { titleKey: "nav.evaluation", icon: "pulse" },
  media: { titleKey: "media.title", icon: "image" },
};

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "ready": {
      const { error: _clearedError, hostError: _clearedHostError, ...rest } = state;
      return { ...rest, loading: false, bootstrap: action.bootstrap, ...(action.hostError ? { hostError: action.hostError } : {}), ...(action.clientState ? { clientState: action.clientState } : {}) };
    }
    case "state":
      return { ...state, clientState: action.clientState };
    case "model":
      return { ...state, model: { ...state.model, ...action.model } };
    case "error":
      return { ...state, loading: false, error: action.error };
    case "event":
      if (!shouldRecordShellEvent(action.event)) return state;
      return { ...state, events: [...state.events.slice(-199), toShellEventLogEntry(action.event)] };
  }
}

export function unavailableBootstrap(): ClientBootstrap {
  return {
    contractVersion: CLIENT_CONTRACT_VERSION,
    authority: { authorityId: "desktop-unavailable" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
    runtime: { status: "unavailable", classification: "unavailable" },
    surface: { terminalAttach: false, fileReveal: false, previewInput: false, openExternal: false },
    capabilityManifest: { profile: "limited", generatedAt: "1970-01-01T00:00:00.000Z", hash: "unavailable", capabilities: [] },
    commandManifestHash: "unavailable",
    selected: {},
  };
}

export function asError(cause: unknown): ClientError {
  const value = cause as { code?: unknown; message?: unknown } | null;
  if (value && typeof value.code === "string" && typeof value.message === "string") {
    return { code: value.code as ClientError["code"], message: value.message };
  }
  return {
    code: "TRANSPORT_ERROR",
    message: cause instanceof Error && cause.message ? cause.message : "Unknown client error",
  };
}

export function snapshotFrom(state: ViewState): OperatorStateSnapshot | undefined {
  if (state.clientState !== undefined) {
    return state.clientState.entities.snapshot ?? undefined;
  }
  return state.bootstrap && "snapshot" in state.bootstrap ? state.bootstrap.snapshot : state.model.home?.snapshot;
}
