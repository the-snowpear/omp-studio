export interface SessionOwnerState {
	visibleSessionIds: readonly string[];
	blockedSessionIds: readonly string[];
	known: boolean;
}
export interface SessionOwnerOperation {
	kind: "session.owner.update";
	sessionId: string;
	state: SessionOwnerState;
}
