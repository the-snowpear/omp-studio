/**
 * Deterministic, safe contract fixtures (P0).
 *
 * Every fixture value is fixed at module load: opaque branded identities,
 * epochs, versions and pre-redacted display text only. Nothing here is or
 * resembles a Bridge token, private endpoint, session/workspace path, PID,
 * process handle or secret. All timestamps and ids are literal constants so
 * the same suite produces bit-identical expectations on every run.
 *
 * The fake host keeps its own per-instance copy of this data (so a
 * deliberately mutating test can never poison later tests) and hands out
 * the same instance reference on every call — the suite's mutation-after-
 * call assertions therefore prove the adapter defensively clones results
 * before returning them and requests before forwarding them.
 */

import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type {
  AuthorityEpoch,
  AuthorityId,
  ClientBootstrap,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientEvent,
  ClientQueryRequest,
  ClientQueryResponse,
  CommandName,
  CommandRequestId,
  DiagnosticEntryId,
  EnvironmentId,
  EventCursor,
  HistoryEntryId,
  IdempotencyKey,
  GitRepositoryId,
  GitWorktreeId,
  QueryInput,
  QueryName,
  ConversationTranscriptReadPage,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
  SubscriptionScope,
  ThreadId,
  Unsubscribe,
  WorkspaceId,
} from "@omp-studio/client-contract";
import type {
  DiagnosticReadModel,
  EnvironmentReadModel,
  HomeReadModel,
  PublicAuthorityIdentity,
  ResidentsReadModel,
  RuntimeConnection,
  RuntimeInstallState,
  SessionHistoryReadModel,
  SurfaceCapabilities,
} from "@omp-studio/client-contract";
import type {
  AgentId,
  AgentTranscriptPage,
  CapabilityManifest,
  Generation,
  OpaqueCursor,
  OperatorCommandManifest,
  OperatorStateSnapshot,
} from "@omp-studio/studio-protocol";

import { conversationChangedEvent, conversationLiveSequence, conversationPages } from "./conversation-fixtures.js";
import type { ContractFixtureApi, FixtureCalls, FixtureSubscription } from "./types.js";

/** Public opaque authority/runtime identities (never secrets). */
const AUTHORITY_ID = "auth-0001" as AuthorityId;
const AUTHORITY_EPOCH = 7 as AuthorityEpoch;
const RUNTIME_ID = "rt-0001" as RuntimeId;
const RUNTIME_EPOCH = 3 as RuntimeEpoch;
const STATE_VERSION = 41 as StateVersion;
const ENVIRONMENT_ID = "env-0001" as EnvironmentId;
const THREAD_ID = "thr-0001" as ThreadId;
const SESSION_ID = "sess-0001" as SessionId;
const WORKSPACE_ID = "ws-0001" as WorkspaceId;
const AGENT_ID = "agent-0001" as AgentId;
const GIT_REPOSITORY_ID = "repo-0001" as GitRepositoryId;
const GIT_WORKTREE_ID = "worktree-0001" as GitWorktreeId;
const HISTORY_ID = "hist-0001" as HistoryEntryId;
const DIAGNOSTIC_ID = "diag-0001" as DiagnosticEntryId;
const COMMAND_REQUEST_ID = "cmd-req-0001" as CommandRequestId;
const COMMAND_REQUEST_ID_2 = "cmd-req-0002" as CommandRequestId;
const IDEM_KEY_1 = "idem-0001" as IdempotencyKey;
const IDEM_KEY_2 = "idem-0002" as IdempotencyKey;
const T0 = "2026-08-12T00:00:00.000Z";
const T_ACCEPTED = "2026-08-12T00:00:05.000Z";
const UPSTREAM_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Minimal valid operator state snapshot for the fixture runtime. */
const SNAPSHOT: OperatorStateSnapshot = {
  runtimeId: RUNTIME_ID,
  runtimeEpoch: RUNTIME_EPOCH,
  stateVersion: STATE_VERSION,
  sessionId: SESSION_ID,
  isStreaming: false,
  isCompacting: false,
  activeMode: "normal", approvalMode: "yolo",
  plan: { status: "off" },
  goal: { status: "off" },
  pause: { paused: false },
  pendingMessages: 0,
  activeCommandIds: [],
  agentsRevision: 0,
  jobsRevision: 0,
  agents: [],
  jobs: [],
};

/** Minimal valid capability manifest built from the protocol shape. */
const CAPABILITY_MANIFEST: CapabilityManifest = {
  profile: "full-parity-v1",
  generatedAt: T0,
  hash: "cap-fixture-0001",
  capabilities: [
    { id: "core.prompt", grade: "stable", version: 1, evidence: "testkit-fixture" },
    { id: "session.state", grade: "stable", version: 1, evidence: "testkit-fixture" },
    {
      id: "interaction.respond",
      grade: "experimental",
      version: 2,
      evidence: "testkit-fixture",
      limitations: ["fixture-only"],
    },
  ],
};

/** Minimal valid operator command manifest (returned by the manifest query). */
const OPERATOR_COMMAND_MANIFEST: OperatorCommandManifest = {
  generatedAt: T0,
  upstreamCommit: UPSTREAM_COMMIT,
  hash: "op-cmd-fixture-0001",
  commands: [
    {
      id: "operator.invoke",
      name: "invoke",
      aliases: [],
      description: "Invoke an operator command.",
      source: "builtin",
      implementation: "shared-service",
      interactionKinds: [],
      presentation: "native",
      availability: "available",
      risk: "normal",
      effect: "session",
      contractTestId: "testkit-operator-invoke",
    },
  ],
  unclassifiedBuiltins: [],
};

const AUTHORITY: PublicAuthorityIdentity = {
  authorityId: AUTHORITY_ID,
  authorityEpoch: AUTHORITY_EPOCH,
};

const RUNTIME_CONNECTION: RuntimeConnection = {
  status: "connected",
  classification: "managed",
  runtimeId: RUNTIME_ID,
  runtimeEpoch: RUNTIME_EPOCH,
  backend: "studio-host",
  runtimeVersion: "0.1.0",
  upstreamVersion: "0.1.0",
  upstreamCommit: UPSTREAM_COMMIT,
};

const SURFACE: SurfaceCapabilities = {
  terminalAttach: false,
  fileReveal: false,
  previewInput: false,
  openExternal: true,
};

const INSTALLER: RuntimeInstallState = {
  status: "installed",
  version: "0.1.0",
  signature: "verified",
};

const ENVIRONMENT: EnvironmentReadModel = {
  platform: "win32",
  arch: "x64",
  authority: AUTHORITY,
  runtime: RUNTIME_CONNECTION,
  installer: INSTALLER,
};

const DIAGNOSTICS: DiagnosticReadModel = {
  generatedAt: T0,
  authority: AUTHORITY,
  redacted: true,
  entries: [
    {
      entryId: DIAGNOSTIC_ID,
      scope: "host",
      level: "info",
      message: "Fixture diagnostic entry.",
      occurredAt: T0,
    },
  ],
};

const HISTORY: SessionHistoryReadModel = {
  total: 1,
  entries: [
    {
      historyId: HISTORY_ID,
      threadId: THREAD_ID,
      environmentId: ENVIRONMENT_ID,
      sessionId: SESSION_ID,
      title: "Fixture session",
      summary: "Deterministic testkit fixture session.",
      startedAt: T0,
      lastActiveAt: T0,
      messageCount: 3,
      status: "active",
    },
  ],
};

const RESIDENTS: ResidentsReadModel = {
  generatedAt: T0,
  activeSessionId: SESSION_ID,
  residents: [
    {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      phase: "running",
      pendingMessages: 1,
      lastActivityAt: T0,
    },
  ],
};

const HOME: HomeReadModel = {
  authority: AUTHORITY,
  runtime: RUNTIME_CONNECTION,
  snapshot: SNAPSHOT,
  recentThreads: [{ threadId: THREAD_ID, title: "Fixture thread", lastActiveAt: T0 }],
};

const BOOTSTRAP: ClientBootstrap = {
  contractVersion: CLIENT_CONTRACT_VERSION,
  authority: AUTHORITY,
  runtime: RUNTIME_CONNECTION,
  surface: SURFACE,
  capabilityManifest: CAPABILITY_MANIFEST,
  commandManifestHash: OPERATOR_COMMAND_MANIFEST.hash,
  selected: {
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    sessionId: SESSION_ID,
  },
  snapshot: SNAPSHOT,
  stateVersion: STATE_VERSION,
  cursor: "c-41" as EventCursor,
  residents: RESIDENTS,
};

const QUERY_INPUTS = {
  "environment.get": {},
  "capabilities.get": {},
  "commands.getManifest": {},
  "diagnostics.get": {},
  "history.list": { limit: 5, workspaceId: WORKSPACE_ID },
  "residents.list": {},
  "session.state": {},
  "home.get": {},
  "models.get": {},
  "skills.get": {},
  "mcp.get": {},
  "mcp.logs.get": { name: "filesystem" },
  "agents.definitions.get": {},
  "projects.list": {},
  "workspace.fileTree": { workspaceId: WORKSPACE_ID },
  "usage.get": {},
  "session.transcript.read": { limit: 50 },
  "agent.transcript.read": { agentId: AGENT_ID, limit: 50 },
  "agent.conversation.read": { agentId: AGENT_ID, limit: 50 },
  "session.transcript.readPage": { sessionId: SESSION_ID, limit: 50 },
  "session.agents.list": { sessionId: SESSION_ID },
  "session.telemetry.read": { sessionId: SESSION_ID },
  "git.toolchain.get": {},
  "git.repository.get": { workspaceId: WORKSPACE_ID },
  "git.diff.get": { workspaceId: WORKSPACE_ID, path: "src/index.ts", target: "working" },
  "git.branches.list": { workspaceId: WORKSPACE_ID },
  "git.worktrees.list": { workspaceId: WORKSPACE_ID },
  "git.remotes.list": { workspaceId: WORKSPACE_ID },
  "git.log.list": { workspaceId: WORKSPACE_ID, limit: 80 },
  "git.commit.changes": { workspaceId: WORKSPACE_ID, oid: UPSTREAM_COMMIT },
  "git.commit.diff": { workspaceId: WORKSPACE_ID, oid: UPSTREAM_COMMIT, path: "src/index.ts" },
  "github.auth.get": { workspaceId: WORKSPACE_ID },
  "github.pr.list": { workspaceId: WORKSPACE_ID, state: "open" },
  "github.pr.get": { workspaceId: WORKSPACE_ID, number: 1 },
  "github.pr.checks": { workspaceId: WORKSPACE_ID, number: 1 },
} satisfies { readonly [K in QueryName]: QueryInput<K> };

const QUERY_RESPONSES = {
  "environment.get": { ok: true, queryName: "environment.get", result: ENVIRONMENT },
  "capabilities.get": { ok: true, queryName: "capabilities.get", result: CAPABILITY_MANIFEST },
  "commands.getManifest": {
    ok: true,
    queryName: "commands.getManifest",
    result: OPERATOR_COMMAND_MANIFEST,
  },
  "diagnostics.get": { ok: true, queryName: "diagnostics.get", result: DIAGNOSTICS },
  "history.list": { ok: true, queryName: "history.list", result: HISTORY },
  "residents.list": { ok: true, queryName: "residents.list", result: RESIDENTS },
  "session.state": { ok: true, queryName: "session.state", result: SNAPSHOT },
  "home.get": { ok: true, queryName: "home.get", result: HOME },
  "models.get": {
    ok: true,
    queryName: "models.get",
    result: {
      providers: [],
      presets: [],
      roles: [],
      cycleOrder: [],
      availableModels: [],
      loginProviders: [],
      generatedModelsYml: "providers: {}\n",
      generatedConfigYml: "modelRoles: {}\n",
      runtimeEffectHint: "test",
      loginAvailable: false,
      ompAvailable: false,
      modelRoleStorage: "global",
      projectScopeAvailable: false,
      modelProviderOrder: [],
      fallbackChains: {},
      fallbackRevertPolicy: "cooldown-expiry",
      webSearch: {
        enabled: true,
        order: [],
        exclude: [],
        timeoutSeconds: 60,
        geminiModel: "",
        providers: [],
        advanced: { searxng: { endpoint: "", tokenSet: false, basicUsername: "", passwordSet: false }, exa: { enabled: true, searchDelayMs: 1000 } },
      },
    },
  },
  "skills.get": {
    ok: true,
    queryName: "skills.get",
    result: {
      skills: [],
      plugins: [],
      warnings: [],
      generatedAt: T0,
    },
  },
  "mcp.get": {
    ok: true,
    queryName: "mcp.get",
    result: {
      servers: [],
      warnings: [],
      generatedAt: T0,
    },
  },
  "mcp.logs.get": {
    ok: true,
    queryName: "mcp.logs.get",
    result: {
      name: "filesystem",
      lines: [],
      generatedAt: T0,
      emptyReason: "尚无日志，请先测试连接",
    },
  },
  "agents.definitions.get": {
    ok: true,
    queryName: "agents.definitions.get",
    result: {
      agents: [],
      warnings: [],
      builtinToolNames: [],
      roleAliases: [],
      projectScopeAvailable: false,
      generatedAt: T0,
    },
  },
  "projects.list": {
    ok: true,
    queryName: "projects.list",
    result: { workspaces: [] },
  },
  "workspace.fileTree": {
    ok: true,
    queryName: "workspace.fileTree",
    result: { workspaceId: WORKSPACE_ID, nodes: [] },
  },
  "usage.get": {
    ok: true,
    queryName: "usage.get",
    result: {
      generatedAt: T0,
      days: [],
      models: [],
      byModel: [],
      hours: [],
    },
  },
  "session.transcript.read": {
    ok: true,
    queryName: "session.transcript.read",
    result: conversationPages.userAssistant,
  },
  "agent.transcript.read": {
    ok: true,
    queryName: "agent.transcript.read",
    result: {
      agentId: AGENT_ID,
      generation: 1 as Generation,
      cursor: "agent-cursor-0" as OpaqueCursor,
      messages: [
        { id: "agent-m-1", role: "user", ts: 1_754_000_000_000, text: "audit the lockfile" },
        { id: "agent-m-2", role: "assistant", ts: 1_754_000_060_000, text: "scanned 312 dependencies" },
      ],
      eof: true,
    } satisfies AgentTranscriptPage,
  },
  "agent.conversation.read": {
    ok: true,
    queryName: "agent.conversation.read",
    result: conversationPages.userAssistant,
  },
  "session.telemetry.read": {
    ok: true,
    queryName: "session.telemetry.read",
    result: { sessionId: SESSION_ID, source: "live", semantics: "current-live", telemetry: { sessionId: SESSION_ID, capturedAt: "2026-08-16T00:00:00.000Z", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, context: null } },
  },
  "session.transcript.readPage": {
    ok: true,
    queryName: "session.transcript.readPage",
    result: {
      sessionId: SESSION_ID,
      transcriptRevision: "fixture-revision-1",
      branchLeafId: conversationPages.userAssistant.branchLeafId,
      items: conversationPages.userAssistant.items,
      headCursor: conversationPages.userAssistant.headCursor,
      hasMoreBefore: false,
    } satisfies ConversationTranscriptReadPage,
  },
  "session.agents.list": {
    ok: true,
    queryName: "session.agents.list",
    result: {
      sessionId: SESSION_ID,
      agents: [
        {
          agentId: AGENT_ID,
          generation: 1 as Generation,
          kind: "sub",
          displayName: "WorkerEcho",
          status: "parked",
          updatedAt: "2026-08-19T00:00:00.000Z",
          hasLiveSession: false,
          hasTranscript: true,
          unreadCount: 0,
          activeJobIds: [],
        },
      ],
    },
  },
  "git.toolchain.get": {
    ok: true,
    queryName: "git.toolchain.get",
    result: { git: { available: true, version: "git version fixture" }, githubCli: { available: true, version: "gh version fixture" } },
  },
  "git.repository.get": {
    ok: true,
    queryName: "git.repository.get",
    result: {
      workspaceId: WORKSPACE_ID,
      isRepository: true,
      repositoryId: GIT_REPOSITORY_ID,
      worktreeId: GIT_WORKTREE_ID,
      branch: "main",
      headOid: UPSTREAM_COMMIT,
      detached: false,
      unborn: false,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      stashCount: 0,
      changes: [],
      insertions: 0,
      deletions: 0,
      revision: "git-revision-1",
    },
  },
  "git.diff.get": {
    ok: true,
    queryName: "git.diff.get",
    result: { workspaceId: WORKSPACE_ID, path: "src/index.ts", target: "working", patch: "", binary: false, truncated: false, revision: "diff-revision-1" },
  },
  "git.branches.list": {
    ok: true,
    queryName: "git.branches.list",
    result: { workspaceId: WORKSPACE_ID, branches: [{ name: "main", remote: false, current: true, headOid: UPSTREAM_COMMIT, upstream: "origin/main", ahead: 0, behind: 0, checkedOutWorktreeId: GIT_WORKTREE_ID }] },
  },
  "git.worktrees.list": {
    ok: true,
    queryName: "git.worktrees.list",
    result: { workspaceId: WORKSPACE_ID, rootConfigured: false, worktrees: [{ worktreeId: GIT_WORKTREE_ID, name: "fixture", branch: "main", headOid: UPSTREAM_COMMIT, current: true, detached: false, bare: false, locked: false, prunable: false, workspaceId: WORKSPACE_ID }] },
  },
  "git.remotes.list": {
    ok: true,
    queryName: "git.remotes.list",
    result: { workspaceId: WORKSPACE_ID, remotes: [{ name: "origin", fetchUrl: "https://github.com/example/fixture.git", pushUrl: "https://github.com/example/fixture.git", host: "github.com", repository: "example/fixture" }] },
  },
  "git.log.list": {
    ok: true,
    queryName: "git.log.list",
    result: {
      workspaceId: WORKSPACE_ID,
      commits: [{
        oid: UPSTREAM_COMMIT,
        parents: [],
        subject: "Fixture commit",
        authorName: "fixture",
        authorDate: "2026-01-01T00:00:00Z",
        refs: [{ name: "main", kind: "local", current: true }],
        relation: "head",
      }],
      truncated: false,
      headOid: UPSTREAM_COMMIT,
      upstream: "origin/main",
      mergeBaseOid: UPSTREAM_COMMIT,
      ahead: 0,
      behind: 0,
    },
  },
  "git.commit.changes": {
    ok: true,
    queryName: "git.commit.changes",
    result: { workspaceId: WORKSPACE_ID, oid: UPSTREAM_COMMIT, subject: "Fixture commit", files: [{ path: "src/index.ts", status: "modified" }] },
  },
  "git.commit.diff": {
    ok: true,
    queryName: "git.commit.diff",
    result: { workspaceId: WORKSPACE_ID, oid: UPSTREAM_COMMIT, path: "src/index.ts", patch: "", binary: false, truncated: false },
  },
  "github.auth.get": {
    ok: true,
    queryName: "github.auth.get",
    result: { available: true, authenticated: true, host: "github.com", account: "fixture", gitProtocol: "https" },
  },
  "github.pr.list": {
    ok: true,
    queryName: "github.pr.list",
    result: { workspaceId: WORKSPACE_ID, pullRequests: [] },
  },
  "github.pr.get": {
    ok: true,
    queryName: "github.pr.get",
    result: { workspaceId: WORKSPACE_ID, pullRequest: { number: 1, title: "Fixture PR", state: "open", draft: false, headBranch: "feature", baseBranch: "main", headOid: UPSTREAM_COMMIT, url: "https://github.com/example/fixture/pull/1" }, checks: [] },
  },
  "github.pr.checks": {
    ok: true,
    queryName: "github.pr.checks",
    result: { workspaceId: WORKSPACE_ID, pullRequestNumber: 1, checks: [], overall: "neutral" },
  },
} satisfies { readonly [K in QueryName]: ClientQueryResponse<K> };

const COMMAND_RUNTIME_INSTALL: ClientCommandRequest<"runtime.install"> = {
  commandName: "runtime.install",
  input: { channel: "stable" },
  idempotencyKey: IDEM_KEY_1,
  requestId: COMMAND_REQUEST_ID,
};

const COMMAND_SESSION_RESUME: ClientCommandRequest<"session.resume"> = {
  commandName: "session.resume",
  input: { threadId: THREAD_ID },
  idempotencyKey: IDEM_KEY_2,
  requestId: COMMAND_REQUEST_ID_2,
};

const COMMAND_REQUESTS: ReadonlyArray<ClientCommandRequest> = [
  COMMAND_RUNTIME_INSTALL,
  COMMAND_SESSION_RESUME,
];

/**
 * Accepted acknowledgements the fixture returns. The host echoes the
 * client-generated requestId back unchanged, so each accepted envelope
 * carries exactly the requestId its request carried — the adapter must
 * never rewrite or re-derive it.
 */
const COMMAND_ACCEPTED: ReadonlyArray<ClientCommandAccepted> = [
  {
    commandName: "runtime.install",
    requestId: COMMAND_RUNTIME_INSTALL.requestId,
    status: "accepted",
    acceptedAt: T_ACCEPTED,
  },
  {
    commandName: "session.resume",
    requestId: COMMAND_SESSION_RESUME.requestId,
    status: "accepted",
    acceptedAt: T_ACCEPTED,
  },
];

const SNAPSHOT_EVENT: ClientEvent = {
  authorityEpoch: AUTHORITY_EPOCH,
  runtimeEpoch: RUNTIME_EPOCH,
  stateVersion: 42 as StateVersion,
  cursor: "c-42" as EventCursor,
  occurredAt: "2026-08-12T00:00:01.000Z",
  kind: "snapshot",
  snapshot: { ...SNAPSHOT, stateVersion: 42 as StateVersion },
};

const ACCEPTED_EVENT: ClientEvent = {
  authorityEpoch: AUTHORITY_EPOCH,
  runtimeEpoch: RUNTIME_EPOCH,
  stateVersion: 42 as StateVersion,
  cursor: "c-43" as EventCursor,
  occurredAt: "2026-08-12T00:00:02.000Z",
  kind: "command.accepted",
  accepted: {
    commandName: "runtime.install",
    requestId: COMMAND_REQUEST_ID,
    status: "accepted",
    acceptedAt: "2026-08-12T00:00:02.000Z",
  },
};

const RECEIPT_EVENT: ClientEvent = {
  authorityEpoch: AUTHORITY_EPOCH,
  runtimeEpoch: RUNTIME_EPOCH,
  stateVersion: 43 as StateVersion,
  cursor: "c-44" as EventCursor,
  occurredAt: "2026-08-12T00:00:03.000Z",
  kind: "command.receipt",
  receipt: {
    requestId: COMMAND_REQUEST_ID,
    commandName: "runtime.install",
    status: "completed",
    result: INSTALLER,
    observedAt: "2026-08-12T00:00:04.000Z",
  },
};

/** Authority-level event, deliberately not tied to any runtime. */
const DIAGNOSTICS_EVENT: ClientEvent = {
  authorityEpoch: AUTHORITY_EPOCH,
  stateVersion: 43 as StateVersion,
  cursor: "c-45" as EventCursor,
  occurredAt: "2026-08-12T00:00:05.000Z",
  kind: "diagnostics.changed",
};

const RESIDENTS_EVENT: ClientEvent = {
  authorityEpoch: AUTHORITY_EPOCH,
  stateVersion: 43 as StateVersion,
  cursor: "c-46" as EventCursor,
  occurredAt: "2026-08-12T00:00:06.000Z",
  kind: "residents.changed",
  residents: RESIDENTS,
};

const CONVERSATION_EVENT: ClientEvent = conversationChangedEvent(conversationLiveSequence[0]!, 12);

const EVENTS: ReadonlyArray<ClientEvent> = [
  SNAPSHOT_EVENT,
  ACCEPTED_EVENT,
  RECEIPT_EVENT,
  DIAGNOSTICS_EVENT,
  RESIDENTS_EVENT,
  CONVERSATION_EVENT,
];

/**
 * Fixture events carry no thread identity: snapshots expose a sessionId,
 * and SessionId and ThreadId are distinct identities. The fixture must not
 * invent a session→thread relationship, so thread-scoped subscriptions
 * conservatively match nothing (see scopeMatches below).
 */

function commandRequestIdOf(event: ClientEvent): CommandRequestId | undefined {
  switch (event.kind) {
    case "command.accepted":
      return event.accepted.requestId;
    case "interaction.required":
      return event.interaction.requestId;
    case "command.receipt":
      return event.receipt.requestId;
    default:
      return undefined;
  }
}

/**
 * Fixture subscription filter. The adapter forwards the scope verbatim;
 * the host decides which events each scope receives.
 *
 * Scope semantics mirror client eventMatchesScope exactly:
 * - all: every event;
 * - runtime: every event carrying a runtime epoch;
 * - command: the three command kinds whose requestId matches;
 * - thread: nothing — snapshots carry a sessionId but no threadId, and
 *   SessionId and ThreadId are distinct identities, so no event can be
 *   bound to a thread until the contract gains thread identity.
 */
function scopeMatches(scope: SubscriptionScope, event: ClientEvent): boolean {
  switch (scope.scope) {
    case "all":
      return true;
    case "runtime":
      return event.runtimeEpoch !== undefined;
    case "command":
      return commandRequestIdOf(event) === scope.requestId;
    case "thread":
      return false;
  }
}

/** Immutable base fixture data; every fixture instance deep-clones it. */
export interface ContractFixtureData {
  readonly bootstrap: ClientBootstrap;
  readonly queryInputs: { readonly [K in QueryName]: QueryInput<K> };
  readonly queryResponses: { readonly [K in QueryName]: ClientQueryResponse<K> };
  readonly commandRequests: ReadonlyArray<ClientCommandRequest>;
  readonly commandAccepted: ReadonlyArray<ClientCommandAccepted>;
  /** Timestamp the fake host stamps on every accepted acknowledgement. */
  readonly commandAcceptedAt: string;
  readonly events: ReadonlyArray<ClientEvent>;
  readonly threadId: ThreadId;
  readonly commandRequestId: CommandRequestId;
  readonly idempotencyKey: IdempotencyKey;
}

export const contractFixtures: ContractFixtureData = {
  bootstrap: BOOTSTRAP,
  queryInputs: QUERY_INPUTS,
  queryResponses: QUERY_RESPONSES,
  commandRequests: COMMAND_REQUESTS,
  commandAccepted: COMMAND_ACCEPTED,
  commandAcceptedAt: T_ACCEPTED,
  events: EVENTS,
  threadId: THREAD_ID,
  commandRequestId: COMMAND_REQUEST_ID,
  idempotencyKey: IDEM_KEY_1,
};

/**
 * Fake host implementing every adapter-facing method plus the test hooks.
 *
 * Fail-closed rules (owned by the host, observed through the adapter):
 * - unknown/malformed queryName -> `ok: false` INVALID_ARGUMENT envelope;
 * - unknown/malformed commandName -> rejection with code INVALID_ARGUMENT;
 * - every operation after close -> rejection with code UNAVAILABLE;
 * - subscribe after close -> synchronous throw with code UNAVAILABLE.
 */

/**
 * One-shot malformed-response injection (see the override hooks). The
 * `active: true` variant carries the raw override value, which may
 * legitimately be `null`; consuming a hook resets the pair to the
 * inactive sentinel so the override applies exactly once.
 */
type OneShotOverride =
  | { readonly active: false }
  | { readonly active: true; readonly value: unknown };

class ContractFixture implements ContractFixtureApi {
  readonly calls: FixtureCalls = {
    bootstrapCalls: 0,
    queryCalls: 0,
    commandCalls: 0,
    subscribeCalls: 0,
    closeCalls: 0,
    lastQueryRequest: undefined,
    lastCommandRequest: undefined,
    subscriptions: [],
  };

  private readonly data: ContractFixtureData;
  private readonly commandNames: Readonly<Record<string, boolean>>;
  private closed = false;
  /** One-shot malformed-response injections (see the override hooks). */
  private bootstrapOverride: OneShotOverride = { active: false };
  private queryOverride: OneShotOverride = { active: false };
  private commandOverride: OneShotOverride = { active: false };

  constructor(base: ContractFixtureData) {
    this.data = structuredClone(base);
    this.commandNames = this.data.commandRequests.reduce<Record<string, boolean>>(
      (names, request) => {
        names[request.commandName] = true;
        return names;
      },
      {},
    );
  }

  async bootstrap(): Promise<ClientBootstrap> {
    this.throwIfClosed();
    this.calls.bootstrapCalls += 1;
    const override = this.bootstrapOverride;
    this.bootstrapOverride = { active: false };
    if (override.active) {
      return override.value as ClientBootstrap;
    }
    return this.data.bootstrap;
  }

  async query<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): Promise<ClientQueryResponse<TName>> {
    this.throwIfClosed();
    this.calls.queryCalls += 1;
    this.calls.lastQueryRequest = request;
    const override = this.queryOverride;
    this.queryOverride = { active: false };
    if (override.active) {
      return override.value as ClientQueryResponse<TName>;
    }
    // The compile-time type guarantees `queryName`, but callers may still
    // hand us malformed values at runtime; validate before use.
    const rawName: unknown = request.queryName;
    if (typeof rawName !== "string") {
      return {
        ok: false,
        queryName: rawName as TName,
        error: {
          code: "INVALID_ARGUMENT",
          message: `Unknown queryName: ${String(rawName)}`,
        },
      };
    }
    const name: string = rawName;
    if (!Object.hasOwn(this.data.queryResponses, name)) {
      return {
        ok: false,
        queryName: name as TName,
        error: {
          code: "INVALID_ARGUMENT",
          message: `Unknown queryName: ${String(rawName)}`,
        },
      };
    }
    return this.data.queryResponses[name as TName];
  }

  async command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>> {
    this.throwIfClosed();
    this.calls.commandCalls += 1;
    this.calls.lastCommandRequest = request;
    const override = this.commandOverride;
    this.commandOverride = { active: false };
    if (override.active) {
      return override.value as ClientCommandAccepted<TName>;
    }
    // The compile-time type guarantees `commandName`, but callers may still
    // hand us malformed values at runtime; validate before use.
    const rawName: unknown = request.commandName;
    if (typeof rawName !== "string") {
      throw Object.assign(new Error(`Unknown commandName: ${String(rawName)}`), {
        code: "INVALID_ARGUMENT",
      });
    }
    const name: string = rawName;
    if (this.commandNames[name] !== true) {
      throw Object.assign(new Error(`Unknown commandName: ${String(rawName)}`), {
        code: "INVALID_ARGUMENT",
      });
    }
    // The host echoes the client-generated requestId unchanged; it never
    // derives or rewrites it. Only reachable for known command names
    // (validated above), so malformed envelopes still fail closed.
    return {
      commandName: name as TName,
      requestId: request.requestId,
      status: "accepted",
      acceptedAt: this.data.commandAcceptedAt,
    };
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    this.throwIfClosed();
    this.calls.subscribeCalls += 1;
    const subscription: FixtureSubscription = {
      scope,
      listener,
      unsubscribed: false,
    };
    this.calls.subscriptions.push(subscription);
    return () => {
      subscription.unsubscribed = true;
    };
  }

  async close(): Promise<void> {
    this.calls.closeCalls += 1;
    this.closed = true;
    for (const subscription of this.calls.subscriptions) {
      subscription.unsubscribed = true;
    }
  }

  emit(event: ClientEvent): void {
    for (const subscription of this.calls.subscriptions) {
      if (!subscription.unsubscribed && scopeMatches(subscription.scope, event)) {
        subscription.listener(event);
      }
    }
  }

  overrideBootstrap(result: unknown): void {
    this.bootstrapOverride = { active: true, value: result };
  }

  overrideQueryResponse(response: unknown): void {
    this.queryOverride = { active: true, value: response };
  }

  overrideCommandResponse(response: unknown): void {
    this.commandOverride = { active: true, value: response };
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw Object.assign(new Error("transport is closed"), { code: "UNAVAILABLE" });
    }
  }
}

/** Creates a fresh fake host with its own copy of the fixture data. */
export function createContractFixtureApi(): ContractFixtureApi {
  return new ContractFixture(contractFixtures);
}
