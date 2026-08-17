import type { AgentSession } from "../../session/agent-session";

export class StudioForkError extends Error {
	constructor(
		readonly code: "BUSY_STREAMING" | "BUSY_COMPACTING" | "MODE_CONFLICT" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioForkError";
	}
}

export class StudioForkService {
	constructor(private readonly session: AgentSession) {}

	async fork(): Promise<{ forked: boolean; sessionId: string }> {
		if (this.session.isStreaming) throw new StudioForkError("BUSY_STREAMING", "Runtime is streaming");
		if (this.session.isCompacting) throw new StudioForkError("BUSY_COMPACTING", "Runtime is compacting");
		if (this.session.getVibeModeState()?.enabled) {
			throw new StudioForkError("MODE_CONFLICT", "Exit vibe mode before forking the session");
		}
		const forked = await this.session.fork();
		if (!forked)
			throw new StudioForkError("COMMAND_BLOCKED", "Session fork was cancelled or persistence is disabled");
		return { forked: true, sessionId: this.session.sessionManager.getSessionId() };
	}
}
