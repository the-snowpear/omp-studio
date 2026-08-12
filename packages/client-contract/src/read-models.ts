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

export type RuntimeConnectionStatus = "connecting" | "connected" | "disconnected";

export type RuntimeClassification =
  | "managed"
  | "compatible-system"
  | "limited-system"
  | "rejected";

export type RuntimeBackend = "studio-host" | "rpc-ui" | "acp";

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
  readonly version?: string;
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

/** Home page read model: runtime status plus the current read snapshot. */
export interface HomeReadModel {
  readonly authority: PublicAuthorityIdentity;
  readonly runtime: RuntimeConnection;
  readonly snapshot: OperatorStateSnapshot;
  readonly recentThreads: ReadonlyArray<RecentThread>;
}
