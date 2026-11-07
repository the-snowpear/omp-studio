import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { SessionManager } from "../../session/session-manager";
import { isHarnessInjectedUserMessage, publicConversationRole } from "./conversation-visibility";

/** Private display metadata; the public OMP RPC event schema stays native. */
export type StudioAgentSessionEvent = AgentSessionEvent & { studioEntryId?: string };

/** Reserves display identities before the home thread can persist the corresponding entry. */
export class StudioConversationEntryIdentity {
	#compactionId: string | undefined;
	#messages: Array<{ role: string; timestamp: number; id: string }> = [];

	constructor(readonly manager: SessionManager) {}

	prepare(event: AgentSessionEvent): StudioAgentSessionEvent {
		if (event.type === "auto_compaction_end" || event.type === "manual_compaction_end") {
			const id = this.#compactionId;
			this.#compactionId = undefined;
			if (id && (event.aborted || event.skipped || !event.result)) this.manager.releaseCompactionId(id);
			return id ? { ...event, studioEntryId: id } : event;
		}
		if (event.type === "auto_compaction_start" || event.type === "manual_compaction_start") {
			if (this.#compactionId) this.manager.releaseCompactionId(this.#compactionId);
			this.#compactionId = this.manager.reserveCompactionId();
			return { ...event, studioEntryId: this.#compactionId };
		}
		if (
			(event.type !== "message_start" && event.type !== "message_end") ||
			isHarnessInjectedUserMessage(event.message)
		)
			return event;
		const message = event.message;
		const role = publicConversationRole(message.role, message);
		if (!role) return event;
		if (event.type === "message_end") {
			const index = this.#messages.findIndex(row => row.role === role && row.timestamp === message.timestamp);
			if (index < 0) return event;
			const [entry] = this.#messages.splice(index, 1);
			return { ...event, studioEntryId: entry.id };
		}
		let id: string;
		if (message.role === "custom" || message.role === "hookMessage") {
			id = this.manager.reserveCustomMessageId(message.customType, message.timestamp);
		} else if (role === "user" || role === "assistant" || role === "system") {
			id = this.manager.reserveMessageId(role);
		} else return event;
		this.#messages.push({ role, timestamp: message.timestamp, id });
		return { ...event, studioEntryId: id };
	}
}
