import type { ConversationRole } from "../conversation-protocol";

/**
 * Roles the operator conversation surface may show. Native harness traffic
 * stays hidden; explicitly displayed extension messages retain their own role.
 */
export function isComputerContinueMessage(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const message = value as { role?: unknown; customType?: unknown; attribution?: unknown; display?: unknown };
	return (
		message.role === "custom" &&
		message.customType === "studio-computer-continue" &&
		message.attribution === "user" &&
		message.display === true
	);
}
export function publicConversationRole(role: unknown, message?: unknown): ConversationRole | undefined {
	if (isComputerContinueMessage(message)) return "user";
	if (role === "user" || role === "assistant" || role === "system") return role;
	if ((role === "custom" || role === "hookMessage") && message && typeof message === "object") {
		const custom = message as { display?: unknown; customType?: unknown };
		// These native records already have dedicated Studio surfaces, or carry
		// agent-to-agent context rather than an extension's operator-facing body.
		if (
			custom.display === true &&
			typeof custom.customType === "string" &&
			custom.customType !== "advisor" &&
			custom.customType !== "async-result" &&
			!custom.customType.startsWith("irc:")
		)
			return "extension";
	}
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
