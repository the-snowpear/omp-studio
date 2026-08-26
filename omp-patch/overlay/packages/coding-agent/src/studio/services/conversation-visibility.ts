import type { ConversationRole } from "../conversation-protocol";

/**
 * Roles the operator conversation surface may show. Runtime harness traffic
 * uses `developer` / `custom` / etc. and must not be mapped onto `system`.
 */
export function publicConversationRole(role: unknown): ConversationRole | undefined {
	if (role === "user" || role === "assistant" || role === "system") return role;
	return undefined;
}

/**
 * Agent-injected user rows that must stay off the operator conversation
 * surface: plan-approval leftovers that kept `synthetic`, and steers injected
 * by agents (peer IRC). A steer attributed to the user is the operator's own
 * 插入纠偏 input — hiding it strands the optimistic composer bubble at the
 * bottom of the timeline, so it must render at its chronological position.
 */
export function isHarnessInjectedUserMessage(message: {
	readonly role?: unknown;
	readonly synthetic?: unknown;
	readonly steering?: unknown;
	readonly attribution?: unknown;
}): boolean {
	if (message.role !== "user") return false;
	if (message.synthetic === true) return true;
	return message.steering === true && message.attribution !== "user";
}
