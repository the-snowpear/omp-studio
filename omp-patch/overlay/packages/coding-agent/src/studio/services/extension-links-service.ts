import type { AgentSession } from "../../session/agent-session";
import { isAgentViewSession, type AgentViewSession } from "../../session/agent-session-handle";
import type { ExtensionLinkOperation } from "../extension-links-protocol";
import { ownedStudioAgent } from "./owned-sessions";
import { SessionControlError } from "./session-control-service";

export function studioLinkTarget(
	session: AgentSession,
	target: { sessionId: string; sourceSessionId?: string; agentId?: string },
): AgentViewSession | undefined {
	if (target.sessionId !== session.sessionId)
		throw new SessionControlError("COMMAND_BLOCKED", "Extension links belong to another session");
	const owner = target.agentId ? ownedStudioAgent(session, target.agentId)?.session : session;
	return owner &&
		isAgentViewSession(owner) &&
		(!target.sourceSessionId || target.sourceSessionId === owner.sessionManager.getSessionId())
		? owner
		: undefined;
}

export async function activateStudioExtensionLink(
	session: AgentSession,
	operation: ExtensionLinkOperation,
): Promise<{ handled: boolean }> {
	const target = studioLinkTarget(session, operation);
	if (!target)
		throw new SessionControlError("COMMAND_BLOCKED", "The extension owning this conversation is no longer running");
	return { handled: await target.activateStudioLink(operation.url) };
}
