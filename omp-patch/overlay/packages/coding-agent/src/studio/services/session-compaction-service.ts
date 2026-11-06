import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentSession } from "../../session/agent-session";
import {
	formatSessionCompactionInput,
	parseSessionCompactionInput,
	SESSION_COMPACTION_ENTRY,
	type SessionCompactionState,
} from "../session-compaction-protocol";
import { resolveSessionCompactionSettings, sessionCompactionThreshold } from "./session-compaction-policy";
import { SessionControlError } from "./session-control-service";

export class StudioSessionCompactionService {
	constructor(readonly session: AgentSession) {}

	get(): SessionCompactionState {
		const session = this.session;
		const configured = resolveSessionCompactionSettings(session.settings, session.model, session.sessionManager);
		const contextWindow = session.model?.contextWindow ?? 0;
		const automatic = configured.enabled;
		return {
			sessionId: session.sessionId,
			threshold: sessionCompactionThreshold(session.sessionManager),
			contextWindow,
			automatic,
			triggerTokens: automatic && contextWindow > 0 ? resolveThresholdTokens(contextWindow, configured) : null,
		};
	}

	async set(input: string): Promise<SessionCompactionState> {
		let threshold;
		try {
			threshold = parseSessionCompactionInput(input);
		} catch (cause) {
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				cause instanceof Error ? cause.message : "Invalid compaction threshold",
			);
		}
		const manager = this.session.sessionManager;
		manager.appendCustomEntry(SESSION_COMPACTION_ENTRY, {
			sessionId: this.session.sessionId,
			input: formatSessionCompactionInput(threshold),
		});
		await manager.ensureOnDisk();
		await manager.flush();
		this.session.refreshIdleMaintenance();
		return this.get();
	}
}
