/** Runtime preparation never equates a saved transcript directory with a usable launch directory. */
export interface SessionResumePreparation {
  targetSessionId: string;
  requestedSessionId: string;
  recordedCwd: string;
  /** @deprecated Display compatibility only; never use this field as a launch directory. */
  cwd: string;
  /** Present only after an existing execution directory has been selected. */
  executionCwd?: string;
  workspaceId?: string;
  /** Host-issued opaque handle for consuming this preparation through session.resume. */
  threadId?: string;
  requiresWorkspaceSelection: boolean;
}

export type SessionPurgeStoreDiagnostic =
  | { status: "purged"; deletedRows: number }
  | { status: "absent" }
  | { status: "skipped"; reason: "test-default-paths" | "session-id-unavailable" }
  | { status: "failed"; reason: "store-unavailable" };

/** Independent native-store outcomes; complete does not imply cross-store atomicity. */
export interface SessionPurgeDiagnostic {
  history: SessionPurgeStoreDiagnostic;
  stats: SessionPurgeStoreDiagnostic;
}

export type SessionPurgePartialReason =
  | "runtime-unavailable"
  | "timeout"
  | "cancelled"
  | "process-failed"
  | "unsupported-runtime"
  | "session-unavailable"
  | "native-purge-partial"
  | "native-purge-unreported";

export type SessionPurgeResult =
  | { status: "complete"; diagnostic: SessionPurgeDiagnostic }
  | { status: "partial"; reason: SessionPurgePartialReason; diagnostic?: SessionPurgeDiagnostic };
