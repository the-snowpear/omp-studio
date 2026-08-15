/**
 * Injected service ports consumed by {@link StudioHostClientFacade}.
 *
 * The facade is presentation-neutral: it never imports Electron and never
 * touches process/Bridge internals. Every Host capability it exposes is
 * injected as an explicit port, so the composition root (Electron Main in
 * P1) supplies the real seams and tests supply fakes. Ports carry only
 * safe public facts — opaque identities, epochs, versions and pre-redacted
 * text. Nothing here may structurally contain executable paths, Bridge
 * endpoints/tokens, PIDs or session filesystem data.
 */

import { randomUUID } from "node:crypto";

import type {
  ClientError,
  ClientErrorCode,
  ConfigWriteResult,
  DiagnosticEntryId,
  ExtensibilityReadModel,
  McpReadModel,
  AgentDefinitionConfigureInput,
  AgentDefinitionDeleteInput,
  AgentDefinitionsReadModel,
  AgentDefinitionUpsertInput,
  IdempotencyKey,
  InteractionId,
  InteractionResponseValue,
  ModelConfigReadModel,
  ModelDiscoveryResult,
  ModelFallbackSetInput,
  ModelProviderProbeInput,
  ModelProviderSetEnabledInput,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleCreateInput,
  ModelRolesWriteInput,
  RuntimeChannel,
  RuntimeInstallState,
  SessionHistoryStatus,
  ThreadId,
  WorkspaceId,
  WorkspaceListReadModel,
  TokenUsageReadModel,
} from "@omp-studio/client-contract";
import type {
  CapabilityManifest,
  OperatorCommandManifest,
  OperatorStateSnapshot,
  RuntimeBackend,
  RuntimeClassification,
  RuntimeEpoch,
  RuntimeId,
} from "@omp-studio/studio-protocol";
import type {
  HostBackend,
  RuntimePublication,
  StudioRuntimeSessionController,
} from "@omp-studio/studio-host";
import type { StudioOperation } from "@omp-studio/studio-protocol";
import { redactText } from "./read-models.js";

/**
 * Provider of a manifest (capability or operator command). Returning
 * `undefined` means "no Runtime evidence right now"; the facade fails
 * closed to its neutral empty manifest instead of claiming capabilities it
 * cannot prove. Provider errors are treated the same way.
 */
export type HostManifestProvider<T> = () => T | Promise<T> | undefined | Promise<undefined>;

/**
 * Safe public view of the negotiated Runtime hello. Supplied by the
 * composition root from the authenticated handshake; never contains the
 * executable identity/path, endpoint, token, PID or process handle.
 */
export interface HostRuntimeHelloView {
  readonly runtimeId: string;
  readonly runtimeEpoch: number;
  readonly classification: Exclude<RuntimeClassification, "unavailable">;
  readonly backend?: RuntimeBackend;
  readonly runtimeVersion?: string;
  readonly upstreamVersion?: string;
  readonly upstreamCommit?: string;
}

/**
 * Optional Runtime access bundle: the ready session controller plus safe
 * current hello/snapshot access and a projection observation hook.
 *
 * - `hello` is required when the bundle is present; `undefined` from the
 *   accessor means "no Runtime negotiated yet". The facade tracks the last
 *   known hello so a later `undefined` is read as a disconnect, not as a
 *   never-seen Runtime.
 * - `snapshot` defaults to `session.publication()?.snapshot` when the
 *   session controller is wired; an explicit accessor wins.
 * - `onPublication` lets the facade mirror Host projection changes (state
 *   version advances, terminal ledger outcomes) as ClientEvents. Wire it
 *   to whatever drives the controller (e.g. the Bridge projection
 *   listener).
 */
export interface HostRuntimeAccess {
  readonly session?: StudioRuntimeSessionController;
  readonly hello: () => HostRuntimeHelloView | undefined;
  readonly snapshot?: () => OperatorStateSnapshot | undefined;
  readonly onPublication?: (listener: (publication: RuntimePublication) => void) => () => void;
}

/** One session-history row as supplied by the Host-side catalog provider. */
export interface HostCatalogEntry {
  /** Opaque OMP session identity; the facade derives all public ids from it deterministically. */
  readonly sessionId: string;
  /** Safe display title; the facade bounds and sanitizes it again. */
  readonly title?: string;
  /** Safe summary snippet; the facade bounds and sanitizes it again. */
  readonly summary?: string;
  readonly createdAt?: string;
  readonly modifiedAt: string;
  readonly messageCount: number;
  readonly status: SessionHistoryStatus;
}

/**
 * Session catalog provider (SessionCatalog + Studio Thread metadata in the
 * integration plan). Never returns filesystem paths; the facade maps each
 * entry to opaque branded ids and bounded safe text.
 */
export interface HostSessionCatalogProvider {
  list(): HostCatalogEntry[] | Promise<HostCatalogEntry[]>;
}

/**
 * Diagnostics clock/id factory. Injected so tests get deterministic entry
 * ids and timestamps; the facade stamps every diagnostic and event with it.
 */
export interface HostDiagnosticsFactory {
  now(): string;
  newEntryId(): DiagnosticEntryId;
}

/**
 * Runtime install command service. Returns the safe installer read model;
 * the facade publishes `command.accepted` before delegating and the
 * terminal receipt from the returned state (or a mapped failure).
 */
export type HostRuntimeInstallService = (
  channel?: RuntimeChannel,
) => RuntimeInstallState | Promise<RuntimeInstallState>;

/**
 * Host-owned model/provider/role adapter. Paths and secrets stay here;
 * the facade only publishes the public read model and write receipts.
 */
export interface HostModelsService {
  get(): ModelConfigReadModel | Promise<ModelConfigReadModel>;
  upsertProvider(input: ModelProviderUpsertInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  deleteProvider(input: { readonly id: string; readonly expectedHash?: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  setProviderEnabled(input: ModelProviderSetEnabledInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  setRole(input: { readonly roleId: string; readonly selector: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  writeRoles(input: ModelRolesWriteInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  createRole(input: ModelRoleCreateInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  deleteRole(input: { readonly roleId: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  setRoleStorage(input: { readonly storage: "global" | "project" }): ConfigWriteResult | Promise<ConfigWriteResult>;
  setFallback(input: ModelFallbackSetInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  setProviderOrder(input: { readonly order: ReadonlyArray<string> }): ConfigWriteResult | Promise<ConfigWriteResult>;
  writeModelsYml(input: {
    readonly text: string;
    readonly expectedHash?: string;
    readonly overlay?: ModelProviderUpsertInput;
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  startLogin(input: { readonly providerId: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  logout(input: { readonly providerId: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  testProvider(input: { readonly providerId?: string; readonly api?: string; readonly endpointUrl?: string; readonly apiKey?: string }): ModelProviderTestResult | Promise<ModelProviderTestResult>;
  probeProvider(input: ModelProviderProbeInput): ModelDiscoveryResult | Promise<ModelDiscoveryResult>;
  refreshDiscovery(): ConfigWriteResult | Promise<ConfigWriteResult>;
  setCycleOrder(input: { readonly order: ReadonlyArray<string> }): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned configured skills/plugins inventory. Paths stay in the
 * adapter; the facade only publishes the public read model.
 */
export interface HostExtensibilityService {
  get(): ExtensibilityReadModel | Promise<ExtensibilityReadModel>;
  /**
   * Whole-package plugin enable/disable (OMP-native files, no uninstall).
   * `scope` selects the user vs project inventory; the adapter resolves it
   * when omitted. Throws a ClientError-shaped error for unknown plugins.
   */
  setEnabled(input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  /**
   * Whole-skill enable/disable: toggles the winning SKILL.md frontmatter
   * `enabled` field. `scope` maps user → global, project → workspace;
   * builtin skills are rejected.
   */
  setSkillEnabled(input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned configured MCP server inventory. Paths stay in the adapter;
 * the facade only publishes the public read model.
 */
export interface HostMcpService {
  get(): McpReadModel | Promise<McpReadModel>;
  setEnabled(input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned task-agent definition inventory. Paths stay in the adapter;
 * the facade only publishes the public read model and write receipts.
 */
export interface HostAgentDefinitionsService {
  get(): AgentDefinitionsReadModel | Promise<AgentDefinitionsReadModel>;
  upsert(input: AgentDefinitionUpsertInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  delete(input: AgentDefinitionDeleteInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  configure(input: AgentDefinitionConfigureInput): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned workspace registry service. Paths live only in the Host
 * registry; the facade publishes the path-free workspace list.
 */
export interface HostWorkspaceService {
  list(): WorkspaceListReadModel | Promise<WorkspaceListReadModel>;
  open(input: { readonly workspaceId: WorkspaceId }): Promise<WorkspaceListReadModel>;
  pick(): Promise<WorkspaceListReadModel>;
}

/**
 * Host-owned token-usage adapter. Syncs via `omp stats --summary` and reads
 * aggregates from stats.db. Paths never appear on the public read model.
 */
export interface HostUsageService {
  get(): TokenUsageReadModel | Promise<TokenUsageReadModel>;
  openDashboard(): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/** Input accepted by the semantic interaction responder. */
export interface HostInteractionRespondInput {
  readonly interactionId: InteractionId;
  readonly decision: "submit" | "cancel";
  readonly value?: InteractionResponseValue;
}

/**
 * Explicit semantic command service for `session.resume`, `session.drop`
 * and `interaction.respond`. Absent (or a missing Runtime snapshot) means
 * the facade returns CAPABILITY_UNAVAILABLE / UNAVAILABLE — it never
 * fabricates a completion.
 */
export interface HostSemanticCommandService {
  resume(input: { readonly threadId: ThreadId }): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  drop(input: { readonly threadId: ThreadId }): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  respond(input: HostInteractionRespondInput): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  /** P4 Runtime primitive bridge. The Host remains the sole operation owner. */
  invoke?(operation: StudioOperation): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
}

/** Default diagnostics factory: real timestamps and random opaque entry ids. */
export function createDefaultHostDiagnosticsFactory(): HostDiagnosticsFactory {
  return {
    now: () => new Date().toISOString(),
    newEntryId: () => randomUUID() as DiagnosticEntryId,
  };
}

const CLIENT_ERROR_CODES: Record<ClientErrorCode, true> = {
  UNAVAILABLE: true,
  INVALID_ARGUMENT: true,
  STALE_EPOCH: true,
  STATE_VERSION_CONFLICT: true,
  CAPABILITY_UNAVAILABLE: true,
  RESYNC_REQUIRED: true,
  TRANSPORT_ERROR: true,
  INTERNAL_ERROR: true,
};

/** Narrow check for an already-shaped ClientError (e.g. thrown by a service). */
export function isClientError(value: unknown): value is ClientError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("code" in value) || !("message" in value)) return false;
  const { code, message } = value;
  if (typeof code !== "string" || typeof message !== "string") return false;
  return code in CLIENT_ERROR_CODES;
}

/** Idempotency-key sentinel helper; non-empty or invalid. */
export function isValidKey(value: IdempotencyKey): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Map a thrown value to a safe ClientError. ClientError-shaped throws pass
 * through unchanged (their message is already pre-redacted); everything
 * else is wrapped with a redacted message and the given fallback code.
 */
export function toClientError(error: unknown, fallbackCode: ClientErrorCode = "INTERNAL_ERROR"): ClientError {
  if (isClientError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { code: fallbackCode, message: redactText(error.message) };
  }
  return { code: fallbackCode, message: "Host rejected the request" };
}
