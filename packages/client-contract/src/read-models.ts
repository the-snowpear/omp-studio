/**
 * Public read models for the P0 surface: environment, capability, diagnostic,
 * session history and home pages (FRONTEND_INTEGRATION.md §12.1).
 *
 * Every model exposes only safe display facts: opaque identities, epochs,
 * versions and pre-redacted text. No absolute paths, PIDs, process handles,
 * private endpoints, tokens or secrets may ever appear in these shapes.
 */

import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import type {
  AuthorityEpoch,
  AuthorityId,
  DiagnosticEntryId,
  EnvironmentId,
  HistoryEntryId,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  ThreadId,
  WorkspaceId,
} from "./ids.js";

/** Platform family, mirroring the public PlatformPort union. Never implies a path. */
export type PlatformId = "win32" | "darwin";

/** CPU architecture of the running platform. */
export type ArchId = "x64" | "arm64";

/**
 * Public (non-secret) part of the Host authority identity. The Renderer may
 * display and compare it; it never includes endpoints, tokens or process
 * information.
 */
export interface PublicAuthorityIdentity {
  readonly authorityId: AuthorityId;
  readonly authorityEpoch: AuthorityEpoch;
}

export type RuntimeConnectionStatus = "connecting" | "connected" | "disconnected" | "unavailable";

export type RuntimeClassification =
  | "unavailable"
  | "managed"
  | "compatible-system"
  | "limited-system"
  | "rejected";

export type RuntimeBackend = "studio-host" | "rpc-ui" | "acp";

/**
 * Why a Runtime never connected (`status === "unavailable"`). Closed union
 * so the Renderer can map to copy without parsing Host English sentences.
 * Present only with `unavailableReason`; never a path, PID or endpoint.
 */
export type RuntimeUnavailableCode =
  | "no-workspace"
  | "workspace-unusable"
  | "not-installed"
  | "resolution-rejected"
  | "resolution-limited"
  | "launch-failed"
  | "handshake-timeout"
  | "spawn-failed"
  | "exited-before-ready"
  | "not-wired";

/**
 * Why a previously connected Runtime dropped (`status === "disconnected"`).
 * Closed union so the Renderer can map copy without parsing Host sentences.
 * Present only with `disconnectReason`; never a path, PID or endpoint.
 */
export type RuntimeDisconnectCode =
  | "pipe-closed"
  | "process-exit"
  | "lease-lost"
  | "host-stop";

/**
 * Runtime connection facts exposed to the Renderer. Carries only public
 * display facts: opaque identity, epochs, backend and versions. Never
 * carries the runtime PID, process handle, private endpoint or session
 * file path.
 */
export interface RuntimeConnection {
  readonly status: RuntimeConnectionStatus;
  readonly classification: RuntimeClassification;
  /** Opaque runtime identity; present once a runtime has been selected. */
  readonly runtimeId?: RuntimeId;
  /** Monotonic runtime generation; isolates stale runtime state and events. */
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly backend?: RuntimeBackend;
  readonly runtimeVersion?: string;
  readonly upstreamVersion?: string;
  readonly upstreamCommit?: string;
  /** Present only when classification is "rejected". Safe, pre-redacted text. */
  readonly rejectionReason?: string;
  /**
   * Present when `status` is `"unavailable"` and the Host knows why.
   * Closed code for UI mapping; optional next to a pre-redacted sentence.
   */
  readonly unavailableCode?: RuntimeUnavailableCode;
  /** Safe, pre-redacted sentence explaining why the Runtime never connected. */
  readonly unavailableReason?: string;
  /**
   * Present when `status` is `"disconnected"` and the Host knows why.
   * Closed code for UI mapping; optional next to a pre-redacted sentence.
   */
  readonly disconnectCode?: RuntimeDisconnectCode;
  /** Safe, pre-redacted sentence explaining why the Runtime dropped. */
  readonly disconnectReason?: string;
}

/**
 * What the current surface (Desktop shell or local WebUI) may expose.
 * `terminalAttach`, `previewInput` and `fileReveal` default to off and are
 * only granted per surface policy (FRONTEND_INTEGRATION.md §10).
 */
export interface SurfaceCapabilities {
  readonly terminalAttach: boolean;
  readonly fileReveal: boolean;
  readonly previewInput: boolean;
  readonly openExternal: boolean;
}

export type RuntimeInstallStatus =
  | "not-installed"
  | "installing"
  | "installed"
  | "update-available"
  | "failed";

export type SignatureStatus = "verified" | "unverified" | "unknown";

/**
 * Runtime installer facts for the environment page. Never carries install
 * or fallback paths.
 */
export interface RuntimeInstallState {
  readonly status: RuntimeInstallStatus;
  /** Currently installed runtime version, when one exists. */
  readonly version?: string;
  /**
   * Newest locally discovered signed artifact version. Present when a
   * probe found an artifact (installable or newer than `version`).
   * Never a path.
   */
  readonly availableVersion?: string;
  readonly signature: SignatureStatus;
  /** Safe, pre-redacted message (e.g. a failure reason). */
  readonly message?: string;
}

/** Environment page read model: platform, authority, runtime and installer. */
export interface EnvironmentReadModel {
  readonly platform: PlatformId;
  readonly arch: ArchId;
  readonly authority: PublicAuthorityIdentity;
  readonly runtime: RuntimeConnection;
  readonly installer: RuntimeInstallState;
}

export type DiagnosticLevel = "info" | "warning" | "error";

export type DiagnosticScope = "host" | "runtime" | "bridge" | "installer";

export interface DiagnosticEntry {
  readonly entryId: DiagnosticEntryId;
  readonly scope: DiagnosticScope;
  readonly level: DiagnosticLevel;
  /** Pre-redacted text, safe to display and copy verbatim. */
  readonly message: string;
  /**
   * Structured detail values, already redacted at the Host boundary.
   * Kept as a value record because diagnostic payloads are heterogeneous;
   * every other shape in this contract is exact.
   */
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/** Diagnostics page read model. `redacted` is a contract guarantee. */
export interface DiagnosticReadModel {
  readonly generatedAt: string;
  readonly authority: PublicAuthorityIdentity;
  readonly entries: ReadonlyArray<DiagnosticEntry>;
  readonly redacted: true;
}

export type SessionHistoryStatus = "active" | "archived" | "closed";

/** One session-history row: opaque ids plus a safe, path-free summary. */
export interface SessionHistoryEntry {
  readonly historyId: HistoryEntryId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly sessionId?: SessionId;
  /** Safe display title; never a path. */
  readonly title: string;
  /** Safe summary snippet; never a path. */
  readonly summary?: string;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly messageCount: number;
  readonly status: SessionHistoryStatus;
}

export interface SessionHistoryReadModel {
  readonly entries: ReadonlyArray<SessionHistoryEntry>;
  readonly total: number;
}

/** Recent thread row for the home page: opaque id plus a safe title. */
export interface RecentThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly lastActiveAt: string;
}

/**
 * One workspace row for the workbench/home surfaces. Carries only the
 * opaque workspace id, a basename-only display name and the last-open
 * timestamp. Never a path, cwd or root: paths live in the Host registry.
 */
export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  /** Basename only. Never a path. */
  readonly name: string;
  readonly lastOpenedAt: string;
  readonly active: boolean;
}

/** Workspace inventory read model; the active workspace is optional. */
export interface WorkspaceListReadModel {
  readonly workspaces: ReadonlyArray<WorkspaceRecord>;
  readonly activeWorkspaceId?: WorkspaceId;
}

/** A workspace-relative Explorer node. Absolute paths never cross the Host boundary. */
export interface WorkspaceFileNode {
  readonly type: "file" | "dir";
  readonly name: string;
  /** Normalized workspace-relative path (forward slashes). */
  readonly path: string;
  readonly children?: ReadonlyArray<WorkspaceFileNode>;
}

/** Current file tree for a registered workspace. */
export interface WorkspaceFileTreeReadModel {
  readonly workspaceId: WorkspaceId;
  readonly nodes: ReadonlyArray<WorkspaceFileNode>;
}

/** Terminal result for a workspace file mutation. */
export interface WorkspaceFileMutationResult {
  readonly applied: boolean;
  readonly kind: "file" | "directory";
  readonly path: string;
}

/** Home page read model: runtime status plus the current read snapshot. */
export interface HomeReadModel {
  readonly authority: PublicAuthorityIdentity;
  readonly runtime: RuntimeConnection;
  readonly snapshot: OperatorStateSnapshot;
  readonly recentThreads: ReadonlyArray<RecentThread>;
  /** Most-recently-opened workspaces; the full list comes from `projects.list`. */
  readonly recentWorkspaces?: ReadonlyArray<WorkspaceRecord>;
}

/** One local calendar day of aggregated token usage. Date is `YYYY-MM-DD`. */
export interface TokenUsageDayPoint {
  readonly date: string;
  readonly totalTokens: number;
}

/** Safe model id for the homepage usage chart legend. Never a path. */
export interface TokenUsageModelRef {
  readonly id: string;
}

/** Per-model tokens for one local calendar day. */
export interface TokenUsageModelDayPoint {
  readonly date: string;
  readonly model: string;
  readonly tokens: number;
}

/** Per-model tokens for one local hour of today (`0`–`23`). */
export interface TokenUsageHourPoint {
  readonly hour: number;
  readonly model: string;
  readonly tokens: number;
}

/**
 * Homepage Token heatmap / curve read model. Aggregates only: no session
 * files, folders, or other filesystem facts.
 */
export interface TokenUsageReadModel {
  readonly generatedAt: string;
  readonly days: ReadonlyArray<TokenUsageDayPoint>;
  readonly models: ReadonlyArray<TokenUsageModelRef>;
  readonly byModel: ReadonlyArray<TokenUsageModelDayPoint>;
  readonly hours: ReadonlyArray<TokenUsageHourPoint>;
  readonly unavailableReason?: string;
}

/** Wire API used by a provider or custom model in `models.yml`. */
export type ModelApiKind =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "azure-openai-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-gemini-cli"
  | "google-vertex";

export type ModelAuthType = "oauth" | "api-key" | "env" | "command" | "none";

/**
 * OMP treats a models.yml `apiKey` as an environment variable name when it
 * looks like one (`FOO_BAR`, all-caps identifiers). Literal keys (`sk-…`)
 * and `!command` values are not env names.
 */
export function isModelEnvConfigName(value: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return false;
  if (/^sk/i.test(value)) return false;
  return value.includes("_") || (value === value.toUpperCase() && value.length >= 4);
}

export type ModelProviderSource = "builtin" | "custom" | "runtime" | "extension";

export type ModelProviderStatus =
  | "available"
  | "not-authenticated"
  | "disabled"
  | "offline"
  | "auth-expired"
  | "config-error"
  | "connection-failed";

export type ModelEntryStatus = "available" | "disabled" | "unavailable";

export type ModelEntrySource = "catalog" | "discovery" | "custom" | "extension";

/**
 * Credential metadata for a provider.
 * `apiKey` echoes the credential value stored in models.yml (plain key for
 * `api-key`, `!command` string for `command`) so the editor can pre-fill it.
 * `envName` is the environment variable name for `env` auth (not a secret).
 * Deliberate choice: the desktop console is a local trusted surface.
 */
export interface ModelAuthMeta {
  readonly type: ModelAuthType;
  readonly hasSecret: boolean;
  readonly account?: string;
  readonly apiKey?: string;
  readonly envName?: string;
}

export interface ModelDiscoveryMeta {
  readonly type: string;
  readonly timeoutMs?: number;
}

export interface ModelCostMeta {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** Safe subset of OMP `remoteCompaction` exposed for display/edit. */
export interface ModelProviderRemoteCompaction {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly model?: string;
}

/** Partial `models.yml` modelOverrides / extra custom-model fields. */
export interface ModelOverridePatch {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly image?: boolean;
  readonly tools?: boolean;
  readonly cost?: ModelCostMeta;
  readonly omitMaxOutputTokens?: boolean;
  readonly premiumMultiplier?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contextPromotionTarget?: string;
  readonly compactionModel?: string;
  readonly remoteCompaction?: ModelProviderRemoteCompaction;
  /** Allowed thinking strengths written as `thinking.efforts` in models.yml. */
  readonly thinking?: ReadonlyArray<string>;
}

/** One model row under a provider. Safe display facts only. */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly selector: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly image: boolean;
  readonly reasoning: boolean;
  readonly tools: boolean;
  readonly cost?: ModelCostMeta;
  readonly status: ModelEntryStatus;
  readonly source: ModelEntrySource;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly omitMaxOutputTokens?: boolean;
  readonly premiumMultiplier?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contextPromotionTarget?: string;
  readonly compactionModel?: string;
  readonly remoteCompaction?: ModelProviderRemoteCompaction;
  /** Allowed thinking strengths (`off` / `low` / `medium` / `high` / `xhigh` / `max`). */
  readonly thinking?: ReadonlyArray<string>;
}

/** One configured or discovered provider on the model-config page. */
export interface ModelProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly source: ModelProviderSource;
  readonly status: ModelProviderStatus;
  readonly statusDetail: string;
  readonly api: ModelApiKind | string;
  readonly endpointUrl?: string;
  readonly local: boolean;
  readonly enabled: boolean;
  readonly website?: string;
  readonly note?: string;
  readonly auth: ModelAuthMeta;
  readonly discovery?: ModelDiscoveryMeta;
  readonly headers?: Record<string, string>;
  readonly disableStrictTools?: boolean;
  readonly transport?: "pi-native";
  readonly remoteCompaction?: ModelProviderRemoteCompaction;
  readonly models: ReadonlyArray<ModelCatalogEntry>;
  /** Safe subset of `models.yml` modelOverrides (no secrets). */
  readonly modelOverrides?: Readonly<Record<string, ModelOverridePatch>>;
}

export type ModelPresetAuth = ModelAuthType;

export interface ModelPresetItem {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly api: ModelApiKind | string;
  readonly auth: ReadonlyArray<ModelPresetAuth>;
  readonly endpoint?: string;
  readonly local?: boolean;
  readonly discovery?: string;
  readonly popular?: boolean;
  readonly oauth?: boolean;
}

export interface ModelPresetGroup {
  readonly group: string;
  readonly items: ReadonlyArray<ModelPresetItem>;
}

export type ModelRoleIssueKind =
  | "model-missing"
  | "provider-unauth"
  | "provider-disabled"
  | "provider-down"
  | "model-disabled"
  | "model-unavailable";

export interface ModelRoleIssue {
  readonly kind: ModelRoleIssueKind;
  readonly detail: string;
}

export type ModelRoleStorage = "global" | "project";
export type ModelFallbackRevertPolicy = "cooldown-expiry" | "never";

/** Built-in or custom model role. `scope` is which config file currently owns the assignment. */
export interface ModelRoleRecord {
  readonly id: string;
  readonly alias: string;
  readonly name: string;
  readonly desc: string;
  readonly builtin: boolean;
  readonly primary: string;
  readonly thinking?: string;
  readonly scope: ModelRoleStorage;
  readonly issue?: ModelRoleIssue;
}

export interface AvailableModelRecord {
  readonly provider: string;
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly image?: boolean;
  readonly tools?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly thinking?: ReadonlyArray<string>;
  readonly cost?: ModelCostMeta;
}

export interface ModelLoginProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly authenticated: boolean;
}

/**
 * Model-config page read model. Paths, API keys and auth-store secrets
 * never appear. `generated*Yml` is Host-built and already redacted.
 */
export interface ModelConfigReadModel {
  readonly providers: ReadonlyArray<ModelProviderRecord>;
  readonly presets: ReadonlyArray<ModelPresetGroup>;
  readonly roles: ReadonlyArray<ModelRoleRecord>;
  readonly cycleOrder: ReadonlyArray<string>;
  readonly availableModels: ReadonlyArray<AvailableModelRecord>;
  readonly loginProviders: ReadonlyArray<ModelLoginProviderRecord>;
  readonly generatedModelsYml: string;
  readonly generatedConfigYml: string;
  readonly runtimeEffectHint: string;
  readonly contentHash?: string;
  readonly loginAvailable: boolean;
  readonly ompAvailable: boolean;
  readonly unavailableReason?: string;
  readonly modelRoleStorage: ModelRoleStorage;
  readonly projectScopeAvailable: boolean;
  readonly modelProviderOrder: ReadonlyArray<string>;
  readonly fallbackChains: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly fallbackRevertPolicy: ModelFallbackRevertPolicy;
}

/** Skill origin as OMP discovery would classify it. Never a filesystem path. */
export type SkillScope = "workspace" | "global" | "builtin";

/** Which configured source produced the winning skill of a given name. */
export type SkillSourceKind = "native" | "plugin" | "managed";

/**
 * One configured skill. Paths, SKILL.md body and Host-internal directories
 * never appear. `loaded` / session availability are unknown without Runtime
 * introspection and are therefore omitted.
 */
export interface SkillRecord {
  readonly name: string;
  readonly desc: string;
  readonly scope: SkillScope;
  readonly sourceKind: SkillSourceKind;
  /** Safe display label: OMP / Codex / Claude / OpenCode / GitHub / Agents / 插件 / 托管. */
  readonly sourceLabel: string;
  /** Frontmatter `enabled` is not `false`. */
  readonly enabled: boolean;
  readonly hide: boolean;
  /** Pre-redacted validation problem (e.g. missing description). */
  readonly error?: string;
}

export type PluginSourceKind = "npm" | "marketplace" | "link" | "git";

export type PluginConfigStatus = "configured" | "error";

/**
 * One configured plugin from ~/.omp/plugins (and project overrides).
 * Contribution lists are declared entry names from the package manifest,
 * not Runtime-registered tools.
 */
export interface PluginRecord {
  readonly name: string;
  readonly version: string;
  readonly sourceKind: PluginSourceKind;
  /** Safe display label: npm / 市场 / 链接 / git. */
  readonly srcLabel: string;
  readonly enabled: boolean;
  readonly status: PluginConfigStatus;
  readonly tools: number;
  readonly commands: number;
  readonly hooks: number;
  readonly ui: boolean;
  readonly toolItems: ReadonlyArray<string>;
  readonly commandItems: ReadonlyArray<string>;
  readonly hookItems: ReadonlyArray<string>;
  readonly uiItems: ReadonlyArray<string>;
  readonly err?: string;
}

/**
 * Configured skills + plugins inventory. This is a disk scan of OMP-native
 * locations, not the Runtime effective/loaded set.
 */
export interface ExtensibilityReadModel {
  readonly skills: ReadonlyArray<SkillRecord>;
  readonly plugins: ReadonlyArray<PluginRecord>;
  /** Pre-redacted collision / parse notes. Never paths. */
  readonly warnings: ReadonlyArray<string>;
  readonly generatedAt: string;
  readonly unavailableReason?: string;
}

/** MCP transport kinds surfaced in the public inventory (no connection details). */
export type McpTransport = "stdio" | "http" | "sse";

/**
 * Configured-only MCP status. Not Runtime connection state
 * (`connected` / reconnecting / error).
 */
export type McpConfigStatus = "enabled" | "disabled" | "shadowed";

/**
 * Last Host-owned one-shot probe for an MCP server. Never includes command,
 * URL, headers, or secrets.
 */
export interface McpLastProbe {
  readonly ok: boolean;
  readonly at: string;
  readonly detail: string;
  readonly toolCount?: number;
}

/**
 * One configured MCP server from OMP-native mcp.json discovery.
 * Never includes command, args, env, url, headers, or OAuth secrets.
 */
export interface McpServerRecord {
  readonly name: string;
  readonly transport: McpTransport;
  /** Effective enabled after denylist / allowlist / per-entry flags. */
  readonly enabled: boolean;
  readonly status: McpConfigStatus;
  /** Safe display label: 用户 / 项目. */
  readonly sourceLabel: string;
  readonly scope: "user" | "project";
  /** Host-process memory from the last `mcp.test`; omitted until probed. */
  readonly lastProbe?: McpLastProbe;
}

/**
 * Configured MCP server inventory. Disk scan of OMP-native mcp.json paths,
 * not live MCPManager connection state.
 */
export interface McpReadModel {
  readonly servers: ReadonlyArray<McpServerRecord>;
  /** Pre-redacted parse / collision notes. Never paths. */
  readonly warnings: ReadonlyArray<string>;
  readonly generatedAt: string;
  readonly unavailableReason?: string;
}

/** Terminal result of a Host-owned MCP one-shot connect (`initialize` + `tools/list`). */
export interface McpTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
  readonly toolCount?: number;
}

/**
 * Recent Host-owned MCP probe log lines for one server. Pre-redacted;
 * never paths, URLs, or secrets.
 */
export interface McpLogsReadModel {
  readonly name: string;
  readonly lines: ReadonlyArray<string>;
  readonly generatedAt: string;
  readonly emptyReason?: string;
}

/**
 * Configured OMP task-agent definition (Markdown + YAML frontmatter).
 * Disk inventory, not a live Agent Hub instance. Paths never appear.
 */
export type AgentDefinitionSource = "project" | "user" | "bundled" | "plugin";

/** Thinking selectors OMP accepts on agent frontmatter (`thinking-level` / `thinking`). */
export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "auto";

export interface AgentDefinitionRecord {
  readonly name: string;
  readonly description: string;
  /** Prompt body below the frontmatter. Empty when the bundled prompt is packed in the runtime. */
  readonly systemPrompt: string;
  readonly tools?: ReadonlyArray<string>;
  readonly spawns?: ReadonlyArray<string> | "*";
  readonly model?: ReadonlyArray<string>;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly output?: unknown;
  readonly blocking?: boolean;
  readonly autoloadSkills?: ReadonlyArray<string>;
  readonly readSummarize?: boolean;
  /** `true` = default prewalk target; string = custom model pattern. */
  readonly prewalk?: boolean | string;
  /** `true` = default advisor-role model; string = custom advisor model pattern. */
  readonly advisor?: boolean | string;
  readonly source: AgentDefinitionSource;
  /** Safe display label: 项目 / 用户 / 内置 / 插件. */
  readonly sourceLabel: string;
  readonly editable: boolean;
  readonly canDelete: boolean;
  readonly canFork: boolean;
  /** `task.disabledAgents` overlay. */
  readonly disabled: boolean;
  readonly overrideModel?: string;
  /** `task.agentPrewalk` overlay: `on` / `off` / pattern. */
  readonly prewalkOverride?: string;
  /** `task.agentAdvisor` overlay: `on` / `off` / pattern. */
  readonly advisorOverride?: string;
  readonly contentHash?: string;
  readonly error?: string;
  /** Bundled agents whose system prompt lives in the runtime binary. */
  readonly promptPacked?: boolean;
}

/**
 * Effective task-agent roster (first-wins by name) plus picker catalogs.
 * Not the Runtime loaded set.
 */
export interface AgentDefinitionsReadModel {
  readonly agents: ReadonlyArray<AgentDefinitionRecord>;
  /** Pre-redacted collision / parse notes. Never paths. */
  readonly warnings: ReadonlyArray<string>;
  readonly builtinToolNames: ReadonlyArray<string>;
  readonly roleAliases: ReadonlyArray<string>;
  readonly projectScopeAvailable: boolean;
  readonly generatedAt: string;
  readonly unavailableReason?: string;
}

export type ConfigRuntimeEffect = "immediate" | "new-session" | "restart-process";

/** Terminal result of a provider connection smoke test. Never a Runtime snapshot. */
export interface ModelProviderTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
  /** HTTP status observed on a successful reachability probe (any response counts). */
  readonly httpStatus?: number;
  /** Number of retries performed (only timeout-class failures are retried). */
  readonly retryCount?: number;
}

/** One model id returned by a discovery probe. Never a secret. */
export interface ModelDiscoveryModel {
  readonly id: string;
  readonly name: string;
}

/** Terminal result of a non-persisting discovery probe. */
export interface ModelDiscoveryResult {
  readonly ok: boolean;
  readonly found: number;
  readonly usable: number;
  readonly models: ReadonlyArray<ModelDiscoveryModel>;
  readonly latencyMs: number;
  readonly detail: string;
  readonly httpStatus?: number;
}

/** Terminal result of a model-config mutation. Never a Runtime snapshot. */
export interface ConfigWriteResult {
  readonly applied: boolean;
  readonly runtimeEffect: ConfigRuntimeEffect;
  readonly message?: string;
  readonly contentHash?: string;
}
