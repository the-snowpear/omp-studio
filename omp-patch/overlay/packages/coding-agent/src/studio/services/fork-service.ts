import type { AgentSession } from "../../session/agent-session";
import { runtimeText } from "../locale";
import { withStudioSessionTransition } from "./session-control-service";

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

	async fork(beforeTransition?: () => Promise<void>): Promise<{ forked: boolean; sessionId: string }> {
		if (this.session.isCompacting) throw new StudioForkError("BUSY_COMPACTING", "Runtime is compacting");
		if (this.session.getVibeModeState()?.enabled) {
			throw new StudioForkError("MODE_CONFLICT", "Exit vibe mode before forking the session");
		}
		return withStudioSessionTransition(
			this.session,
			async () => {
				const forked = await this.session.fork(undefined, { requireIdle: true });
				if (!forked)
					throw new StudioForkError(
						"COMMAND_BLOCKED",
						runtimeText(
							"会话分叉已取消，或未启用持久化。",
							"Session fork was cancelled or persistence is disabled",
						),
					);
				return { forked: true, sessionId: this.session.sessionManager.getSessionId() };
			},
			beforeTransition,
		);
	}
}
