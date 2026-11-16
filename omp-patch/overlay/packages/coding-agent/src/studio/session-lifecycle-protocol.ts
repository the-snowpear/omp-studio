import type { SessionPurgeDiagnostic } from "../session/session-db-purge";

export interface SessionResumePreparation {
	targetSessionId: string;
	requestedSessionId: string;
	recordedCwd: string;
	/** @deprecated Display compatibility only; not an execution directory. */
	cwd: string;
	executionCwd?: string;
	workspaceId?: string;
	/** Added by the Host; never derived from a session id by the renderer. */
	threadId?: string;
	requiresWorkspaceSelection: boolean;
}

/** Private one-shot maintenance input. No executable, database path or chat startup options. */
export interface StudioSessionPurgeRequest {
	schemaVersion: 1;
	requestId: string;
	sessionId: string;
	sessionFile: string;
	agentDir: string;
}

export type StudioSessionPurgeResult =
	| { status: "complete"; diagnostic: SessionPurgeDiagnostic }
	| {
			status: "partial";
			reason: "session-unavailable" | "native-purge-partial" | "native-purge-unreported";
			diagnostic?: SessionPurgeDiagnostic;
	  };

export type StudioSessionPurgeResponse = {
	schemaVersion: 1;
	requestId: string;
	result: StudioSessionPurgeResult;
};
