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
  CapabilityManifest,
  OperatorCommandManifest,
  OperatorStateSnapshot,
} from "@omp-studio/studio-protocol";

import type { CommandRequestId, IdempotencyKey, InteractionId, ThreadId, WorkspaceId } from "./ids.js";
import type {
  DiagnosticReadModel,
  EnvironmentReadModel,
  ConfigWriteResult,
  ExtensibilityReadModel,
  HomeReadModel,
  ModelApiKind,
  ModelAuthType,
  ModelConfigReadModel,
  ModelProviderTestResult,
  RuntimeInstallState,
  SessionHistoryReadModel,
  WorkspaceListReadModel,
} from "./read-models.js";

/** Empty input shape for queries that take no arguments. */
export type EmptyInput = Readonly<Record<string, never>>;

export interface QueryInputMap {
  "environment.get": EmptyInput;
  "capabilities.get": EmptyInput;
  "commands.getManifest": EmptyInput;
  "diagnostics.get": EmptyInput;
  "history.list": { readonly limit?: number };
  "session.state": EmptyInput;
  "home.get": EmptyInput;
  "models.get": EmptyInput;
  "skills.get": EmptyInput;
  "projects.list": EmptyInput;
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
  /** Host workspace inventory. Paths never leave the Host registry. */
  "projects.list": WorkspaceListReadModel;
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

export interface ModelProviderModelInput {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly image?: boolean;
}

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
  readonly expectedHash?: string;
}

/** Non-persisting connectivity smoke test for a provider (draft or saved). */
export interface ModelProviderTestInput {
  readonly providerId?: string;
  readonly api?: ModelApiKind | string;
  readonly endpointUrl?: string;
  readonly apiKey?: string;
}

/** Public semantic command inputs exposed by the Runtime control surface. */
export interface RuntimeCommandInputMap {
  "core.prompt": { readonly text: string };
  "core.steer": { readonly text: string };
  "core.followUp": { readonly text: string };
  "core.abort": EmptyInput;
  "queue.enqueue": { readonly text: string };
  "runtime.pause": EmptyInput;
  "runtime.resume": { readonly expectedPauseEpoch: number };
  "turn.retry": EmptyInput;
  "mode.plan.enter": { readonly initialPrompt?: string };
  "mode.plan.exit": { readonly discardDraft?: boolean };
  "mode.plan.review.open": EmptyInput;
  "mode.plan.review.respond": { readonly decision: "approve" | "refine" | "dismiss"; readonly feedback?: string };
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
  "session.fork": EmptyInput;
  "session.tree.get": EmptyInput;
  "session.tree.navigate": { readonly targetId: string; readonly summarize?: boolean; readonly customInstructions?: string; readonly reanswer?: unknown };
  "operator.invoke": { readonly commandId: string; readonly arguments?: unknown };
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
  /** Resume a thread from history or the home page. */
  "session.resume": { readonly threadId: ThreadId };
  /** Drop a thread. Destructive: the Host issues a one-time confirmation. */
  "session.drop": { readonly threadId: ThreadId };
  /** Answer an `interaction_required` prompt issued by the Host. */
  "interaction.respond": {
    readonly interactionId: InteractionId;
    readonly decision: "submit" | "cancel";
    readonly value?: InteractionResponseValue;
  };
  /** Create or update a custom provider in models.yml. */
  "models.provider.upsert": ModelProviderUpsertInput;
  /** Remove a custom provider from models.yml. */
  "models.provider.delete": { readonly id: string; readonly expectedHash?: string };
  /** Persist a global modelRoles assignment via `omp config set`. */
  "models.roles.set": { readonly roleId: string; readonly selector: string };
  /** Start an OAuth login through a short-lived OMP RPC sidecar. */
  "models.login.start": { readonly providerId: string };
  /** Non-persisting connectivity smoke test against a provider endpoint. */
  "models.provider.test": ModelProviderTestInput;
  /** Persist the quick model-switch rotation order into config.yml. */
  "models.cycleOrder.set": { readonly order: ReadonlyArray<string> };
  /** Activate a known workspace (Host-owned registry; never a path). */
  "workspace.open": { readonly workspaceId: WorkspaceId };
  /** Open the system directory picker and register the chosen folder. */
  "workspace.pick": EmptyInput;
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
  // Runtime control commands share the same accepted/receipt lifecycle. Their
  // terminal state is observed through events, so the result is the current
  // public Runtime snapshot.
}

export type CommandInputMap = CoreCommandInputMap & RuntimeCommandInputMap;

interface CoreCommandResultMap {
  "runtime.install": RuntimeInstallState;
  "session.resume": OperatorStateSnapshot;
  "session.drop": OperatorStateSnapshot;
  "interaction.respond": OperatorStateSnapshot;
  "models.provider.upsert": ConfigWriteResult;
  "models.provider.delete": ConfigWriteResult;
  "models.roles.set": ConfigWriteResult;
  "models.login.start": ConfigWriteResult;
  "models.provider.test": ModelProviderTestResult;
  "models.cycleOrder.set": ConfigWriteResult;
  "workspace.open": WorkspaceListReadModel;
  "workspace.pick": WorkspaceListReadModel;
  "plugins.setEnabled": ConfigWriteResult;
  "skills.setEnabled": ConfigWriteResult;
}

export type CommandResultMap = CoreCommandResultMap & {
  [K in keyof RuntimeCommandInputMap]: OperatorStateSnapshot;
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
  | "INTERNAL_ERROR";

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
