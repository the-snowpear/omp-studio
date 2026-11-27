import type { SessionManager } from "../../session/session-manager";

const approvalSnapshots = new WeakMap<SessionManager, { leaf: string | null; waiting: boolean }>();

/** A resumed/fork-repaired parent result also settles approvals from its nested calls. */
export function sessionWaitingForApproval(manager: SessionManager | undefined): boolean {
	if (typeof manager?.getBranch !== "function") return false;
	const leaf = manager.getLeafId();
	const cached = approvalSnapshots.get(manager);
	if (cached?.leaf === leaf) return cached.waiting;
	const pending = new Map<string, string | undefined>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "tool_approval_requested") {
			const data = entry.data as { toolCallId: string; parentToolCallId?: string };
			pending.set(data.toolCallId, data.parentToolCallId);
		} else if (entry.type === "custom" && entry.customType === "tool_approval_resolved") {
			pending.delete((entry.data as { toolCallId: string }).toolCallId);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			const id = entry.message.toolCallId;
			pending.delete(id);
			for (const [child, parent] of pending) if (parent === id) pending.delete(child);
		}
	}
	const waiting = pending.size > 0;
	approvalSnapshots.set(manager, { leaf, waiting });
	return waiting;
}
