import type { AgentSession } from "../../session/agent-session";

export class StudioHandoffError extends Error {
	constructor(
		readonly code: "BUSY_STREAMING" | "BUSY_COMPACTING" | "MODE_CONFLICT" | "COMMAND_BLOCKED" | "INTERNAL_ERROR",
		message: string,
	) {
		super(message);
		this.name = "StudioHandoffError";
	}
}

export interface StudioHandoffResult {
	handedOff: boolean;
	sessionId: string;
	document: string;
	savedPath?: string;
}

export class StudioHandoffService {
	constructor(private readonly session: AgentSession) {}

	/**
	 * Generate a handoff document from the current session and start a fresh
	 * session seeded with it (mirrors the TUI `/handoff` command). The
	 * SessionManager switches to the new session file, so the returned
	 * sessionId is the post-handoff identity.
	 */
	async handoff(customInstructions?: string): Promise<StudioHandoffResult> {
		if (this.session.isStreaming) throw new StudioHandoffError("BUSY_STREAMING", "Runtime is streaming");
		if (this.session.isCompacting) throw new StudioHandoffError("BUSY_COMPACTING", "Runtime is compacting");
		if (this.session.getVibeModeState()?.enabled) {
			throw new StudioHandoffError("MODE_CONFLICT", "Exit vibe mode before handing off the session");
		}
		const messageCount = this.session.sessionManager.getBranch().filter(entry => entry.type === "message").length;
		if (messageCount < 2) {
			throw new StudioHandoffError("COMMAND_BLOCKED", "Nothing to hand off (no messages yet)");
		}
		let result: Awaited<ReturnType<AgentSession["handoff"]>>;
		try {
			result = await this.session.handoff(customInstructions);
		} catch (error) {
			throw new StudioHandoffError(
				"INTERNAL_ERROR",
				error instanceof Error ? error.message : "Handoff generation failed",
			);
		}
		if (result === undefined) {
			throw new StudioHandoffError("COMMAND_BLOCKED", "Handoff was cancelled or produced no document");
		}
		return {
			handedOff: true,
			sessionId: this.session.sessionManager.getSessionId(),
			document: result.document,
			...(result.savedPath === undefined ? {} : { savedPath: result.savedPath }),
		};
	}
}
