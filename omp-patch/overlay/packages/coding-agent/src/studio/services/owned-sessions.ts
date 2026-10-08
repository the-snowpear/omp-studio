import { AgentRegistry, type AgentRef } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
/** Agent identities proven by the registry's parent chain, including parked descendants. */
function ownedRefs(session: AgentSession): AgentRef[] {
	const registry = AgentRegistry.global();
	const main = registry.list().find(ref => ref.session?.sessionId === session.sessionId);
	if (!main) return [];
	return registry.list().filter(candidate => {
		const seen = new Set<string>();
		let ref = candidate;
		for (;;) {
			if (ref.id === main.id) return true;
			if (seen.has(ref.id)) return false;
			seen.add(ref.id);
			const parent = ref.parentId ? registry.get(ref.parentId) : undefined;
			if (!parent) return false;
			ref = parent;
		}
	});
}
export function ownedStudioAgent(session: AgentSession, agentId: string): AgentRef | undefined {
	return ownedRefs(session).find(ref => ref.id === agentId);
}
/** Live descendants plus the current main session; no foreign session can be controlled. */
export function ownedStudioSessions(session: AgentSession): AgentSession[] {
	const sessions = new Map([[session.sessionId, session]]);
	for (const ref of ownedRefs(session)) if (ref.session) sessions.set(ref.session.sessionId, ref.session);
	return [...sessions.values()];
}
