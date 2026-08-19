/**
 * Semantic request/response maps and envelopes for the product client.
 *
 * Query and command names are type-mapped: `QueryInput`/`QueryResult` and
 * `CommandInput`/`CommandResult` resolve each name to its exact shape, so
 * the Renderer never deals with untyped blobs. Protocol domain types
 * (`CapabilityManifest`, `OperatorCommandManifest`, `OperatorStateSnapshot`)
 * are reused via type-only imports because they are safe public contracts.
 */

import type {
  AgentId,
  AgentTranscriptPage,
  ApprovalMode,
  BtwSnapshot,
  CapabilityManifest,
  ConversationTranscriptPage,
  OpaqueCursor,
  OperatorCommandManifest,
  OperatorStateSnapshot,
  SessionTelemetryReadResult,
  SessionThinkingSelector,
  StudioAgentSnapshot,
} from "@omp-studio/studio-protocol";

import type { ConversationTranscriptReadPage } from "./conversation.js";
import type {
  GitBranchListReadModel,
  GitCommitChangesReadModel,
  GitCommitDiffReadModel,
  GitDiffReadModel,
  GitDiffTarget,
  GitExecuteInput,
  GitLogListReadModel,
  GitHubAuthReadModel,
  GitHubChecksReadModel,
  GitHubExecuteInput,
  GitHubOperationResult,
  GitHubPullRequestDetailReadModel,
  GitHubPullRequestListReadModel,
  GitOperationResult,
  GitRemoteListReadModel,
  GitRepositoryReadModel,
  GitToolchainReadModel,
  GitWorktreeListReadModel,
} from "./git.js";
import type { CommandRequestId, IdempotencyKey, InteractionId, SessionId, ThreadId, WorkspaceId } from "./ids.js";
import type {
  DiagnosticReadModel,
  EnvironmentReadModel,
  ConfigWriteResult,
  ExtensibilityReadModel,
  McpLogsReadModel,
  McpReadModel,
  McpTestResult,
  AgentDefinitionsReadModel,
  AgentThinkingLevel,
  HomeReadModel,
  ModelApiKind,
  ModelAuthType,
  ModelConfigReadModel,
  ModelDiscoveryResult,
  ModelOverridePatch,
  ModelProviderTestResult,
  RuntimeConnection,
  RuntimeInstallState,
  SessionHistoryReadModel,
  SessionHistoryStatus,
  TokenUsageReadModel,
  WorkspaceListReadModel,
  WorkspaceFileTreeReadModel,
  WorkspaceFileMutationResult,
} from "./read-models.js";

/** Empty input shape for queries that take no arguments. */
export type EmptyInput = Readonly<Record<string, never>>;

export interface QueryInputMap {
  "environment.get": EmptyInput;
  "capabilities.get": EmptyInput;
  "commands.getManifest": EmptyInput;
  "diagnostics.get": EmptyInput;
  "history.list": { readonly limit?: number; readonly status?: SessionHistoryStatus };
  "session.state": EmptyInput;
  "home.get": EmptyInput;
  "models.get": EmptyInput;
  "skills.get": EmptyInput;
  "mcp.get": EmptyInput;
  /** Recent Host-owned probe log for one configured MCP server. */
  "mcp.logs.get": { readonly name: string };
  "agents.definitions.get": EmptyInput;
  "projects.list": EmptyInput;
  /** Lists one directory level. Omit path for the workspace root. */
  "workspace.fileTree": { readonly workspaceId: WorkspaceId; readonly path?: string };
  "usage.get": EmptyInput;
  "session.transcript.read": { readonly cursor?: OpaqueCursor; readonly limit?: number };
  "agent.transcript.read": { readonly agentId: AgentId; readonly cursor?: OpaqueCursor; readonly limit?: number };
  "agent.conversation.read": { readonly agentId: AgentId; readonly cursor?: OpaqueCursor; readonly limit?: number };
  /** Runtime-independent persisted transcript page for an explicit session. */
  "session.transcript.readPage": {
    readonly sessionId: SessionId;
    /** When set, read that persisted child next to the parent session file. */
    readonly agentId?: AgentId;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  };
  /** Parked/aborted child agents persisted next to a parent session. Independent of Runtime residency. */
  "session.agents.list": {
    readonly sessionId: SessionId;
  };
  /** Read-only telemetry for a session: live snapshot, persisted record, or recomputed archive probe. */
  "session.telemetry.read": {
    readonly sessionId: SessionId;
  };
  "git.toolchain.get": EmptyInput;
  "git.repository.get": { readonly workspaceId: WorkspaceId };
  "git.diff.get": { readonly workspaceId: WorkspaceId; readonly path: string; readonly target: GitDiffTarget };
  "git.branches.list": { readonly workspaceId: WorkspaceId };
  "git.worktrees.list": { readonly workspaceId: WorkspaceId };
  "git.remotes.list": { readonly workspaceId: WorkspaceId };
  "git.log.list": { readonly workspaceId: WorkspaceId; readonly limit?: number; readonly skip?: number };
  "git.commit.changes": { readonly workspaceId: WorkspaceId; readonly oid: string };
  "git.commit.diff": { readonly workspaceId: WorkspaceId; readonly oid: string; readonly path: string };
  "github.auth.get": { readonly workspaceId?: WorkspaceId };
  "github.pr.list": { readonly workspaceId: WorkspaceId; readonly state?: "open" | "closed" | "merged" | "all" };
  "github.pr.get": { readonly workspaceId: WorkspaceId; readonly number: number };
  "github.pr.checks": { readonly workspaceId: WorkspaceId; readonly number: number };
}

export interface QueryResultMap {
  "environment.get": EnvironmentReadModel;
  /** Capability read model; the protocol manifest is the safe public shape. */
  "capabilities.get": CapabilityManifest;
  /** Operator command manifest; reused from the protocol as a public shape. */
  "commands.getManifest": OperatorCommandManifest;
  "diagnostics.get": DiagnosticReadModel;
  "history.list": SessionHistoryReadModel;
  /** Reused from the protocol as a public shape. */
  "session.state": OperatorStateSnapshot;
  "home.get": HomeReadModel;
  "models.get": ModelConfigReadModel;
  /** Configured OMP skills + plugins. Not Runtime CapabilityManifest. */
  "skills.get": ExtensibilityReadModel;
  /** Configured OMP MCP servers. Disk scan, not MCPManager connection state. */
  "mcp.get": McpReadModel;
  /** Last Host probe lines for one MCP server. Never connection secrets. */
  "mcp.logs.get": McpLogsReadModel;
  /** Configured OMP task-agent definitions. Disk scan, not Agent Hub. */
  "agents.definitions.get": AgentDefinitionsReadModel;
  /** Host workspace inventory. Paths never leave the Host registry. */
  "projects.list": WorkspaceListReadModel;
  "workspace.fileTree": WorkspaceFileTreeReadModel;
  /** Homepage token heatmap / curve. Aggregates from omp stats.db only. */
  "usage.get": TokenUsageReadModel;
  /** Active-branch transcript page. Protocol public shape; never `unknown[]`. */
  "session.transcript.read": ConversationTranscriptPage;
  /** Per-agent transcript page from the Runtime Agent Hub. */
  "agent.transcript.read": AgentTranscriptPage;
  "agent.conversation.read": ConversationTranscriptPage;
  /** Persisted transcript page. Available independently of Runtime residency. */
  "session.transcript.readPage": ConversationTranscriptReadPage;
  /** Persisted child-agent roster for an explicit parent session. */
  "session.agents.list": { readonly sessionId: SessionId; readonly agents: readonly StudioAgentSnapshot[] };
  /** Session telemetry with provenance. Available independently of Runtime residency. */
  "session.telemetry.read": SessionTelemetryReadResult;
  "git.toolchain.get": GitToolchainReadModel;
  "git.repository.get": GitRepositoryReadModel;
  "git.diff.get": GitDiffReadModel;
  "git.branches.list": GitBranchListReadModel;
  "git.worktrees.list": GitWorktreeListReadModel;
  "git.remotes.list": GitRemoteListReadModel;
  "git.log.list": GitLogListReadModel;
  "git.commit.changes": GitCommitChangesReadModel;
  "git.commit.diff": GitCommitDiffReadModel;
  "github.auth.get": GitHubAuthReadModel;
  "github.pr.list": GitHubPullRequestListReadModel;
  "github.pr.get": GitHubPullRequestDetailReadModel;
  "github.pr.checks": GitHubChecksReadModel;
}

export type QueryName = keyof QueryInputMap & keyof QueryResultMap;
export type QueryInput<TName extends QueryName> = QueryInputMap[TName];
export type QueryResult<TName extends QueryName> = QueryResultMap[TName];

export type RuntimeChannel = "stable" | "canary";

/** Write-only auth payload for `models.provider.upsert`. Secrets are never echoed. */
export interface ModelProviderAuthInput {
  readonly type: ModelAuthType;
  readonly apiKey?: string;
  readonly envName?: string;
  readonly command?: string;
  readonly clearSecret?: boolean;
}

export interface ModelProviderModelInput extends ModelOverridePatch {
  readonly id: string;
  readonly api?: string;
  readonly baseUrl?: string;
}

export type ModelProviderOverrideInput = ModelOverridePatch;

export interface ModelProviderUpsertInput {
  readonly id: string;
  readonly name: string;
  readonly website?: string;
  readonly note?: string;
  readonly api: ModelApiKind | string;
  readonly endpointUrl?: string;
  readonly local?: boolean;
  readonly enabled?: boolean;
  readonly auth: ModelProviderAuthInput;
  readonly discovery?: { readonly type: string; readonly timeoutMs?: number } | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly disableStrictTools?: boolean;
  readonly transport?: "pi-native" | null;
  readonly remoteCompaction?: {
    readonly enabled?: boolean;
    readonly endpoint?: string;
    readonly model?: string;
  } | null;
  readonly models?: ReadonlyArray<ModelProviderModelInput>;
  /** null clears overrides; omit leaves previous YAML untouched. */
  readonly modelOverrides?: Readonly<Record<string, ModelProviderOverrideInput>> | null;
  readonly expectedHash?: string;
}

/** Non-persisting connectivity smoke test for a provider (draft or saved). */
export interface ModelProviderTestInput {
  readonly providerId?: string;
  readonly api?: ModelApiKind | string;
  readonly endpointUrl?: string;
  readonly apiKey?: string;
}

/** Toggle a provider via `config.yml` `disabledProviders` only. */
export interface ModelProviderSetEnabledInput {
  readonly id: string;
  readonly enabled: boolean;
}

/** One-shot runtime discovery probe. Never persists `models.db`. */
export interface ModelProviderProbeInput {
  readonly providerId: string;
  readonly endpointUrl?: string;
  readonly apiKey?: string;
  readonly discoveryType?: string;
  readonly timeoutMs?: number;
}

/** Replace the whole `modelRoles` map so deleted keys leave disk. */
export interface ModelRolesWriteInput {
  readonly roles: Readonly<Record<string, string>>;
}

/** Create a custom role (`modelTags` + optional `modelRoles` assignment). */
export interface ModelRoleCreateInput {
  readonly id: string;
  readonly name: string;
  readonly desc?: string;
  readonly color?: string;
  readonly selector?: string;
}

export interface ModelFallbackSetInput {
  readonly chains: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly revertPolicy?: "cooldown-expiry" | "never";
}

/** Create or replace a user/project task-agent Markdown definition. */
export interface AgentDefinitionUpsertInput {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly scope: "user" | "project";
  /** Omit or null = inherit parent tools. Non-empty lists get `yield` added by Host. */
  readonly tools?: ReadonlyArray<string> | null;
  /** Omit or null = inherit; `[]` = none; `"*"` = any. */
  readonly spawns?: ReadonlyArray<string> | "*" | null;
  readonly model?: ReadonlyArray<string> | null;
  readonly thinkingLevel?: AgentThinkingLevel | null;
  readonly output?: unknown;
  readonly blocking?: boolean | null;
  readonly autoloadSkills?: ReadonlyArray<string> | null;
  readonly readSummarize?: boolean | null;
  readonly prewalk?: boolean | string | null;
  readonly advisor?: boolean | string | null;
  readonly expectedHash?: string;
}

export interface AgentDefinitionDeleteInput {
  readonly name: string;
  readonly scope: "user" | "project";
  readonly expectedHash?: string;
}

/** Persist `task.disabledAgents` / `task.agentModelOverrides` / `task.agentPrewalk` / `task.agentAdvisor`. */
export interface AgentDefinitionConfigureInput {
  readonly name: string;
  readonly disabled?: boolean;
  readonly overrideModel?: string | null;
  readonly prewalkOverride?: string | null;
  readonly advisorOverride?: string | null;
}

/**
 * Image attachment on prompt / steer / follow-up. Matches the Runtime
 * `ImageContent` wire shape (`type` + base64 `data` + `mimeType`).
 */
export type PromptImageInput = {
  readonly type: "image";
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly data: string;
};

export type PromptTextInput = {
  readonly text: string;
  readonly images?: ReadonlyArray<PromptImageInput>;
};

/** Public semantic command inputs exposed by the Runtime control surface. */
export interface RuntimeCommandInputMap {
  "core.prompt": PromptTextInput;
  "core.steer": PromptTextInput;
  "core.followUp": PromptTextInput;
  "core.abort": EmptyInput;
  "queue.enqueue": { readonly text: string };
  "runtime.pause": EmptyInput;
  "runtime.resume": { readonly expectedPauseEpoch: number };
  "turn.retry": EmptyInput;
  "mode.plan.enter": { readonly initialPrompt?: string };
  "mode.plan.exit": { readonly discardDraft?: boolean };
  "mode.plan.review.open": EmptyInput;
  "mode.plan.review.respond": {
    readonly decision: "execute" | "compact" | "keep" | "approve" | "refine" | "dismiss";
    readonly feedback?: string;
  };
  "mode.vibe.enter": { readonly initialPrompt?: string };
  "mode.vibe.exit": EmptyInput;
  "goal.create": { readonly objective: string; readonly tokenBudget?: number };
  "goal.replace": { readonly objective: string; readonly tokenBudget?: number };
  "goal.show": EmptyInput;
  "goal.setBudget": { readonly tokenBudget?: number };
  "goal.pause": EmptyInput;
  "goal.resume": EmptyInput;
  "goal.drop": EmptyInput;
  "goal.guided.start": { readonly initial?: string };
  "loop.enable": { readonly prompt?: string; readonly limit?: { readonly turns?: number; readonly minutes?: number; readonly tokens?: number } };
  "loop.pause": EmptyInput;
  "loop.disable": EmptyInput;
  "session.fast.set": { readonly enabled: boolean };
  "session.prewalk.arm": { readonly target?: string };
  "session.prewalk.disarm": EmptyInput;
  /**
   * Switch the model of the live Runtime session. Same semantics as `/model`:
   * the session changes, `modelRoles` on disk does not. Rejected while the
   * Runtime is streaming or compacting.
   */
  "session.model.set": { readonly selector: string; readonly thinking?: SessionThinkingSelector };
  /** Set the session thinking level without changing the active model. */
  "session.thinking.set": { readonly level: SessionThinkingSelector };
  /**
   * In-place conversation reset. Keeps the same session identity and history
   * tree; not a new session (`session.create` / `/new`).
   */
  "session.clearContext": EmptyInput;
  "session.fork": EmptyInput;
  /**
   * Generate a handoff document from the current session and start a fresh
   * session seeded with it. The Runtime switches to the new session, so the
   * post-command snapshot carries the new sessionId.
   */
  "session.handoff": { readonly customInstructions?: string };
  "session.tree.get": EmptyInput;
  "session.tree.navigate": { readonly targetId: string; readonly summarize?: boolean; readonly customInstructions?: string; readonly reanswer?: unknown };
  "session.tree.branch": { readonly targetId: string };
  "operator.invoke": { readonly commandId: string; readonly arguments?: unknown };
  /** Side-channel question that does not enter the main transcript. */
  "btw.ask": { readonly question: string };
  /** Cancel the in-flight BTW answer. The id fences a stale abort against a newer ask. */
  "btw.abort": { readonly ephemeralId: string };
  /**
   * Promote a completed BTW answer into a real session branch. The token is
   * minted per ask and only travels on the `btw.ask` receipt, so a client that
   * merely observed `btw.changed` cannot branch someone else's answer.
   */
  "btw.branch": { readonly branchToken: string };
  /** Start a background side-agent. */
  "tan.start": { readonly work: string };
  /** Generate a TTSR rule candidate from a complaint. */
  "omfg.generate": { readonly complaint: string };
  /** Spawn a subagent via the native structured-subagent path. */
  "agent.spawn": {
    readonly definition: string;
    readonly assignment: string;
    readonly context?: string;
    readonly async?: boolean;
    readonly isolation?: string;
    readonly effort?: string;
  };
  /** Deliver a message to a live/parked subagent (generation-fenced). */
  "agent.send": {
    readonly agentId: string;
    readonly expectedGeneration: number;
    readonly text: string;
    readonly mode: "prompt" | "steer" | "followUp";
    readonly images?: ReadonlyArray<PromptImageInput>;
  };
  /** Stop a subagent. Confirmed in the Agent Hub dialog; Runtime does not issue a second gate. */
  "agent.kill": { readonly agentId: string; readonly expectedGeneration: number };
  /** Reattach a live session to a parked subagent. */
  "agent.revive": { readonly agentId: string; readonly expectedGeneration: number };
  /** Erase a terminal subagent record. Destructive: the Runtime issues a confirmation gate. */
  "agent.release": { readonly agentId: string; readonly expectedGeneration: number };
  /** Cancel a background job owned by the caller's subtree. */
  "job.cancel": { readonly jobId: string; readonly expectedGeneration: number };
}

/**
 * Value accepted by `interaction.respond`. Heterogeneous by nature
 * (select picks, editor text, approval payloads), hence the union.
 */
export type InteractionResponseValue =
  | string
  | boolean
  | ReadonlyArray<string>
  | Readonly<Record<string, unknown>>;

interface CoreCommandInputMap {
  /** Install or update the trusted runtime (environment page action). */
  "runtime.install": { readonly channel?: RuntimeChannel };
  /**
   * Start or restart the managed Runtime under the active workspace.
   * Completes with the public connection facts so diagnostics can refresh
   * without a second round-trip. Default is a no-op when already connected;
   * `force: true` stops the live process and launches a new one.
   */
  "runtime.ensure": { readonly force?: boolean };
  /** Start a fresh Runtime session in the active workspace. */
  "session.create": EmptyInput;
  /** Resume a thread from history or the home page. */
  "session.resume": { readonly threadId: ThreadId };
  /** Drop a thread. Destructive: the Host issues a one-time confirmation. */
  "session.drop": { readonly threadId: ThreadId };
  /**
   * Archive a thread: the Host moves the session JSONL (gzip) and its
   * artifacts into the OMP cold-archive tree. Reversible via
   * `session.unarchive`. If the session is the live Runtime session, the
   * Host aborts a streaming turn, switches the Runtime off that file, then
   * moves it.
   */
  "session.archive": { readonly threadId: ThreadId };
  /** Restore an archived thread back into the active sessions tree. */
  "session.unarchive": { readonly threadId: ThreadId };
  /** Answer an `interaction_required` prompt issued by the Host. */
  "interaction.respond": {
    readonly interactionId: InteractionId;
    /** Lease generation captured by the visible interaction card. */
    readonly leaseGeneration: number;
    readonly decision: "submit" | "cancel";
    readonly value?: InteractionResponseValue;
  };
  /**
   * Set the tool approval mode for every resident Runtime. The active
   * Runtime persists the mode to the OMP global configuration; sibling
   * resident Runtimes receive a non-persistent override.
   */
  "permissions.mode.set": {
    readonly mode: ApprovalMode;
  };
  /** Create or update a custom provider in models.yml. */
  "models.provider.upsert": ModelProviderUpsertInput;
  /** Remove a custom provider from models.yml. */
  "models.provider.delete": { readonly id: string; readonly expectedHash?: string };
  /** Persist a modelRoles assignment. Empty `selector` clears the role. */
  "models.roles.set": { readonly roleId: string; readonly selector: string };
  /** Replace the whole `modelRoles` map (YAML editor deletes included). */
  "models.roles.write": ModelRolesWriteInput;
  /** Create a custom role via `modelTags`. */
  "models.roles.create": ModelRoleCreateInput;
  /** Delete a custom role (`modelTags` + `modelRoles`). Built-in roles are rejected. */
  "models.roles.delete": { readonly roleId: string };
  /** Switch `modelRoleStorage` between global config and `<cwd>/.omp/config.yml`. */
  "models.roleStorage.set": { readonly storage: "global" | "project" };
  /** Persist `retry.fallbackChains` and optional `retry.fallbackRevertPolicy`. */
  "models.fallback.set": ModelFallbackSetInput;
  /** Persist `modelProviderOrder` (ambiguous model-id provider precedence). */
  "models.providerOrder.set": { readonly order: ReadonlyArray<string> };
  /** Enable/disable a provider via `disabledProviders` only. */
  "models.provider.setEnabled": ModelProviderSetEnabledInput;
  /** Replace models.yml from the source editor. Redacted apiKey values keep the previous secret. */
  "models.yml.write": {
    readonly text: string;
    readonly expectedHash?: string;
    /** When the form above is dirty, overlay this provider onto the parsed YAML before write. */
    readonly overlay?: ModelProviderUpsertInput;
  };
  /** Start an OAuth login through a short-lived OMP RPC sidecar. */
  "models.login.start": { readonly providerId: string };
  /** Soft-delete stored credentials for a provider in local `agent.db`. */
  "models.login.logout": { readonly providerId: string };
  /** Non-persisting connectivity smoke test against a provider endpoint. */
  "models.provider.test": ModelProviderTestInput;
  /** One-shot discovery HTTP probe. Does not write `models.db`. */
  "models.provider.probe": ModelProviderProbeInput;
  /** Force `omp models refresh` so runtime discovery rewrites `models.db`. */
  "models.discovery.refresh": EmptyInput;
  /** Persist the quick model-switch rotation order into config.yml. */
  "models.cycleOrder.set": { readonly order: ReadonlyArray<string> };
  /** Activate a known workspace (Host-owned registry; never a path). */
  "workspace.open": { readonly workspaceId: WorkspaceId };
  /** Open the system directory picker and register the chosen folder. */
  "workspace.pick": { readonly name?: string };
  /** Create an empty file inside the selected workspace. */
  "workspace.file.create": { readonly workspaceId: WorkspaceId; readonly path: string };
  /** Create a directory inside the selected workspace. */
  "workspace.directory.create": { readonly workspaceId: WorkspaceId; readonly path: string };
  /**
   * Whole-package plugin enable/disable: whether the plugin enters the
   * Runtime session. Never uninstalls or touches node_modules. Writes the
   * OMP-native files (installed_plugins.json / omp-plugins.lock.json /
   * plugin-overrides.json) so `skills.get` reflects the change immediately.
   */
  "plugins.setEnabled": {
    readonly name: string;
    readonly enabled: boolean;
    /** Which inventory scope to edit; resolved by the Host when omitted. */
    readonly scope?: "user" | "project";
  };
  /**
   * Whole-skill enable/disable: toggles the SKILL.md frontmatter `enabled`
   * field of the winning skill record. `skills.get` reflects the change
   * immediately; builtin skills cannot be toggled.
   */
  "skills.setEnabled": {
    readonly name: string;
    readonly enabled: boolean;
    /** Which inventory scope to edit; resolved by the Host when omitted. */
    readonly scope?: "user" | "project";
  };
  /**
   * Enable/disable a configured MCP server in OMP-native mcp.json
   * (and user-level disabledServers / enabledServers). Reflects in `mcp.get`
   * immediately; Runtime reconnect is `new-session`.
   */
  "mcp.setEnabled": {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  };
  /**
   * Open the winning skill's directory in the system file manager.
   * Paths stay in the Host; the Renderer only supplies the skill name.
   */
  "skills.reveal": {
    readonly name: string;
    readonly scope?: "user" | "project";
  };
  /**
   * Open the native OMP skills root (user `~/.omp/agent/skills` or project
   * `.omp/skills`) in the system file manager. Creates the directory if missing.
   */
  "skills.revealRoot": {
    readonly scope?: "user" | "project";
  };
  /**
   * Re-scan configured MCP inventory from disk. Does not reconnect a live
   * Runtime MCPManager (`runtimeEffect: new-session`).
   */
  "mcp.refresh": {
    readonly name?: string;
  };
  /**
   * One-shot Host probe: JSON-RPC `initialize` + `tools/list`. Secrets stay
   * in the adapter; the receipt never includes command, URL, or headers.
   */
  "mcp.test": {
    readonly name: string;
    readonly scope?: "user" | "project";
  };
  /** Create or replace a user/project `.omp/agents/*.md` definition. */
  "agents.definition.upsert": AgentDefinitionUpsertInput;
  /** Remove a user/project task-agent file. Bundled/plugin agents cannot be deleted. */
  "agents.definition.delete": AgentDefinitionDeleteInput;
  /** Persist per-agent overlays in config.yml (disable / model / prewalk / advisor). */
  "agents.definition.configure": AgentDefinitionConfigureInput;
  /** Open the native `omp stats` dashboard in the default browser. */
  "usage.openDashboard": EmptyInput;
  /** Execute one strictly typed Host-owned Git operation. */
  "git.execute": GitExecuteInput;
  /** Execute one strictly typed GitHub CLI operation. */
  "github.execute": GitHubExecuteInput;
  // Runtime control commands share the same accepted/receipt lifecycle. Their
  // terminal state is observed through events, so the result is the current
  // public Runtime snapshot.
}

export type CommandInputMap = CoreCommandInputMap & RuntimeCommandInputMap;

interface CoreCommandResultMap {
  "runtime.install": RuntimeInstallState;
  "runtime.ensure": RuntimeConnection;
  "session.create": OperatorStateSnapshot;
  "session.resume": OperatorStateSnapshot;
  "session.drop": OperatorStateSnapshot;
  "session.archive": ConfigWriteResult;
  "session.unarchive": ConfigWriteResult;
  "interaction.respond": OperatorStateSnapshot;
  "permissions.mode.set": {
    readonly mode: ApprovalMode;
    readonly syncStatus: "complete" | "partial";
    readonly appliedSessions: number;
    readonly failedSessions: number;
  };
  "models.provider.upsert": ConfigWriteResult;
  "models.provider.delete": ConfigWriteResult;
  "models.provider.setEnabled": ConfigWriteResult;
  "models.roles.set": ConfigWriteResult;
  "models.roles.write": ConfigWriteResult;
  "models.roles.create": ConfigWriteResult;
  "models.roles.delete": ConfigWriteResult;
  "models.roleStorage.set": ConfigWriteResult;
  "models.fallback.set": ConfigWriteResult;
  "models.providerOrder.set": ConfigWriteResult;
  "models.yml.write": ConfigWriteResult;
  "models.login.start": ConfigWriteResult;
  "models.login.logout": ConfigWriteResult;
  "models.provider.test": ModelProviderTestResult;
  "models.provider.probe": ModelDiscoveryResult;
  "models.discovery.refresh": ConfigWriteResult;
  "models.cycleOrder.set": ConfigWriteResult;
  "workspace.open": WorkspaceListReadModel;
  "workspace.pick": WorkspaceListReadModel;
  "workspace.file.create": WorkspaceFileMutationResult;
  "workspace.directory.create": WorkspaceFileMutationResult;
  "plugins.setEnabled": ConfigWriteResult;
  "skills.setEnabled": ConfigWriteResult;
  "skills.reveal": ConfigWriteResult;
  "skills.revealRoot": ConfigWriteResult;
  "mcp.setEnabled": ConfigWriteResult;
  "mcp.refresh": ConfigWriteResult;
  "mcp.test": McpTestResult;
  "agents.definition.upsert": ConfigWriteResult;
  "agents.definition.delete": ConfigWriteResult;
  "agents.definition.configure": ConfigWriteResult;
  "usage.openDashboard": ConfigWriteResult;
  "git.execute": GitOperationResult;
  "github.execute": GitHubOperationResult;
}

/**
 * Enriched `operator.invoke` completion: the Runtime's command output lines
 * and raw command result travel beside the post-command state snapshot so
 * surfaces (e.g. conversation export) can surface real operator feedback
 * instead of a bare snapshot.
 */
export interface OperatorInvokeOutcome {
  readonly snapshot: OperatorStateSnapshot;
  readonly output: ReadonlyArray<string>;
  readonly result: unknown;
}

/**
 * `session.tree.navigate` / `session.tree.branch` completion: post-command
 * snapshot plus the editor fill-back (text and optional images). Images
 * travel only on this receipt; the public transcript still strips them.
 */
export interface SessionTreeCommandOutcome {
  readonly snapshot: OperatorStateSnapshot;
  readonly cancelled?: boolean;
  readonly sessionId?: string;
  readonly editorText?: string;
  readonly editorImages?: ReadonlyArray<PromptImageInput>;
  readonly leafId?: string | null;
  readonly aborted?: boolean;
  readonly askReanswerCommitted?: boolean;
}

/**
 * `btw.ask` completion. The snapshot is the usual post-command Runtime state;
 * `branchToken` is the one-shot authorization for a later `btw.branch` and is
 * deliberately absent from the `btw.changed` event stream.
 */
export interface BtwAskOutcome {
  readonly snapshot: OperatorStateSnapshot;
  readonly ephemeralId: string;
  readonly branchToken: string;
  readonly status: "running";
}

/**
 * `btw.branch` completion. `branched: false` means the Runtime declined (stale
 * token, answer no longer complete, session moved on); `reason` carries the
 * Runtime's own wording so the surface does not have to guess.
 */
export interface BtwBranchOutcome {
  readonly snapshot: OperatorStateSnapshot;
  readonly branched: boolean;
  readonly newSessionId?: string;
  readonly newLeafId?: string;
  readonly reason?: string;
}

export type CommandResultMap = CoreCommandResultMap & {
  [K in Exclude<
    keyof RuntimeCommandInputMap,
    "operator.invoke" | "session.tree.navigate" | "session.tree.branch" | "btw.ask" | "btw.branch"
  >]: OperatorStateSnapshot;
} & {
  "operator.invoke": OperatorInvokeOutcome;
  "session.tree.navigate": SessionTreeCommandOutcome;
  "session.tree.branch": SessionTreeCommandOutcome;
  "btw.ask": BtwAskOutcome;
  "btw.branch": BtwBranchOutcome;
};

export type CommandName = keyof CommandInputMap & keyof CommandResultMap;
export type CommandInput<TName extends CommandName> = CommandInputMap[TName];
export type CommandResult<TName extends CommandName> = CommandResultMap[TName];

export type ClientErrorCode =
  | "UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "STALE_EPOCH"
  | "STATE_VERSION_CONFLICT"
  | "CAPABILITY_UNAVAILABLE"
  | "RESYNC_REQUIRED"
  | "TRANSPORT_ERROR"
  | "INTERNAL_ERROR"
  | "CURSOR_STALE";

export interface ClientError {
  readonly code: ClientErrorCode;
  readonly message: string;
}

/** Semantic query envelope sent to the transport (FRONTEND_INTEGRATION.md §9.1). */
export interface ClientQueryRequest<TName extends QueryName = QueryName> {
  readonly queryName: TName;
  readonly input: QueryInput<TName>;
}

/** Semantic query response: either the exact result or a typed error. */
export type ClientQueryResponse<TName extends QueryName = QueryName> =
  | { readonly ok: true; readonly queryName: TName; readonly result: QueryResult<TName> }
  | { readonly ok: false; readonly queryName: TName; readonly error: ClientError };

/**
 * Semantic command envelope sent to the transport. `requestId` is the
 * client-generated correlation id: the Host must echo it back unchanged in
 * every acknowledgement/receipt so client-side entries stay keyed to it.
 */
export interface ClientCommandRequest<TName extends CommandName = CommandName> {
  readonly commandName: TName;
  readonly input: CommandInput<TName>;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestId: CommandRequestId;
}

/**
 * Transport acknowledgement for a command. `accepted` means the Host took
 * the request — never that it succeeded. Terminal success arrives only via
 * `CommandReceipt` (`completed`/`failed`/`rejected`/`outcome_unknown`).
 */
export interface ClientCommandAccepted<TName extends CommandName = CommandName> {
  readonly commandName: TName;
  readonly requestId: CommandRequestId;
  readonly status: "accepted";
  readonly acceptedAt: string;
}
