/**
 * @omp-studio/host-client-api
 *
 * P1 presentation-neutral Host facade for the product client
 * (FRONTEND_INTEGRATION.md §13 P1). `StudioHostClientFacade` implements the
 * exact client-contract transport envelopes over injected Host seams and
 * never imports Electron. Unavailable operations fail closed; `accepted`
 * is always distinct from the terminal receipt.
 */

export { StudioHostClientFacade } from "./facade.js";
export type { StudioHostClientFacadeOptions } from "./facade.js";

export {
  createDefaultHostDiagnosticsFactory,
  formatRuntimeDisconnectMessage,
  formatRuntimeMissingMessage,
  formatRuntimeUnavailableMessage,
  isClientError,
  toClientError,
} from "./services.js";
export type {
  HostCatalogEntry,
  HostDiagnosticsFactory,
  HostExtensibilityService,
  HostMcpService,
  HostAgentDefinitionsService,
  HostInteractionRespondInput,
  HostManifestProvider,
  HostModelsService,
  HostRuntimeAccess,
  HostResidentsService,
  HostRuntimeDisconnect,
  HostRuntimeHelloView,
  HostRuntimeUnavailable,
  HostRuntimeInstallProbe,
  HostRuntimeInstallService,
  HostSemanticCommandService,
  HostSessionCatalogProvider,
  HostSessionArchiveProvider,
  HostSessionTelemetryProbePort,
  HostSessionTelemetryStorePort,
  HostTelemetryProbeWorkspacePort,
  HostUsageService,
  HostWorkspaceService,
  HostWorkspaceFileService,
  HostGitService,
  HostGitHubService,
} from "./services.js";

export {
  buildDiagnosticsReadModel,
  environmentIdFor,
  historyIdFor,
  neutralCapabilityManifest,
  neutralCommandManifest,
  redactDetail,
  redactText,
  sanitizeDisplayText,
  threadIdFor,
} from "./read-models.js";

export { mapRemoteInteractionToClient, sanitizeApprovalDetail } from "./interaction-map.js";

export { HostEventBus, HostEventCursor, eventMatchesScope } from "./events.js";
export type { HostEventContext, HostEventSeed, HostEventSeedBase } from "./events.js";
