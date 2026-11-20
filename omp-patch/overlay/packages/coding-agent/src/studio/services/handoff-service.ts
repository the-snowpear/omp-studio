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
	static readonly #running = new WeakSet<AgentSession>();

	static running(session: AgentSession): boolean {
		return this.#running.has(session);
	}

	constructor(private readonly session: AgentSession) {}

	/**
	 * Compact the active session with the native background handoff method.
	 * Native compaction owns the winning branch and summary insertion.
	 */
	async handoff(customInstructions?: string): Promise<StudioHandoffResult> {
		if (
			this.session.isCompacting ||
			this.session.isBackgroundCompacting ||
			StudioHandoffService.running(this.session)
		)
			throw new StudioHandoffError("BUSY_COMPACTING", "Runtime is compacting");
		if (this.session.getVibeModeState()?.enabled) {
			throw new StudioHandoffError("MODE_CONFLICT", "Exit vibe mode before handing off the session");
		}
		const messageCount = this.session.sessionManager.getBranch().filter(entry => entry.type === "message").length;
		if (messageCount < 2) {
			throw new StudioHandoffError("COMMAND_BLOCKED", "Nothing to hand off (no messages yet)");
		}
		StudioHandoffService.#running.add(this.session);
		try {
			const result = await this.session.compact(customInstructions, { mode: "handoff" });
			return { handedOff: true, sessionId: this.session.sessionId, document: result.summary };
		} catch (error) {
			throw new StudioHandoffError(
				"INTERNAL_ERROR",
				error instanceof Error ? error.message : "Handoff generation failed",
			);
		} finally {
			StudioHandoffService.#running.delete(this.session);
		}
	}
}
