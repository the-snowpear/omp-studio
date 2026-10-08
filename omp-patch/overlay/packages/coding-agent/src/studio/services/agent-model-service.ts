import type { AgentSession } from "../../session/agent-session";
import { SessionManager, extractSessionInit, type PersistedSessionInit } from "../../session/session-manager";
import type { AgentModelInspection, AgentModelOperation } from "../agent-model-protocol";
import { ownedStudioAgent } from "./owned-sessions";
import { SessionControlError } from "./session-control-service";
function candidates(
	init: PersistedSessionInit | null,
): Pick<AgentModelInspection, "candidates" | "candidatesTruncated"> {
	if (!init?.retryFallback) return {};
	const chain = [init.retryFallback.primary, ...init.retryFallback.chain];
	return { candidates: chain.slice(0, 16), candidatesTruncated: chain.length > 16 };
}
export class StudioAgentModelService {
	constructor(readonly session: AgentSession) {}
	async execute(operation: AgentModelOperation): Promise<AgentModelInspection> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Agent model request belongs to another session");
		const ref = ownedStudioAgent(this.session, operation.agentId);
		if (!ref)
			throw new SessionControlError("COMMAND_BLOCKED", "The agent is not available in this session's registry");
		if (ref.session) {
			const session = ref.session;
			const model = session.model;
			const serving = session.servingModel;
			const configured = session.configuredThinkingLevel(),
				effective = session.thinkingLevel;
			return {
				agentId: ref.id,
				source: "live",
				...(model ? { selectedModel: model.provider + "/" + model.id } : {}),
				...(serving
					? { servingModel: serving.modelIdentity ?? serving.selector, usingFallback: serving.isFallback }
					: {}),
				...(configured ? { configuredThinking: configured } : {}),
				...(effective ? { effectiveThinking: effective } : {}),
				...candidates(extractSessionInit(session.sessionManager.getBranch())),
			};
		}
		if (ref.sessionFile) {
			const file = ref.sessionFile;
			const sourceSession = ref.session;
			const saved = await SessionManager.peekRestoreModels(file);
			const init = await SessionManager.peekSessionInit(file);
			if (
				ownedStudioAgent(this.session, operation.agentId) !== ref ||
				ref.sessionFile !== file ||
				ref.session !== sourceSession
			)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"The agent changed while its saved model configuration was being read",
				);
			return {
				agentId: ref.id,
				source: "saved",
				...(saved.selectors[0] ? { selectedModel: saved.selectors[0] } : {}),
				...(saved.thinking ? { configuredThinking: saved.thinking } : {}),
				...candidates(init?.init ?? null),
			};
		}
		return { agentId: ref.id, source: "starting" };
	}
}
