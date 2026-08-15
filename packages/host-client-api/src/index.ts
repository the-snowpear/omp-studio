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
  HostRuntimeHelloView,
  HostRuntimeInstallService,
  HostSemanticCommandService,
  HostSessionCatalogProvider,
  HostUsageService,
  HostWorkspaceService,
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

export { HostEventBus, HostEventCursor, eventMatchesScope } from "./events.js";
export type { HostEventContext, HostEventSeed, HostEventSeedBase } from "./events.js";
