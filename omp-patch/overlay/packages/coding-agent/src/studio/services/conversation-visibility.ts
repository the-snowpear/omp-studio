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
 * Agent-injected user rows: plan-approval leftovers that kept `synthetic`,
 * and mid-turn steering. Live already drops these; persist/archive must too.
 */
export function isHarnessInjectedUserMessage(message: {
	readonly role?: unknown;
	readonly synthetic?: unknown;
	readonly steering?: unknown;
}): boolean {
	return message.role === "user" && (message.synthetic === true || message.steering === true);
}
