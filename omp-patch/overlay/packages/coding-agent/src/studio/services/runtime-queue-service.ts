import type { AgentSession } from "../../session/agent-session";
import type { RuntimeQueueOperation, RuntimeQueueResult } from "../runtime-queue-protocol";
import { SessionControlError } from "./session-control-service";
export class StudioRuntimeQueueService {
	constructor(readonly session: AgentSession) {}
	get(): RuntimeQueueResult {
		const native = this.session.getQueuedMessageEntries();
		const entries = [];
		let size = 0;
		for (const entry of native.slice(0, 100)) {
			const row = {
				...entry,
				text: entry.text.slice(0, 32768),
				editable: entry.editable && entry.text.length <= 32768,
			};
			size += Buffer.byteLength(JSON.stringify(row));
			if (size > 512000) break;
			entries.push(row);
		}
		return { entries, total: native.length, truncated: entries.length !== native.length };
	}
	execute(operation: RuntimeQueueOperation): RuntimeQueueResult {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The queue belongs to another session");
		if (operation.kind === "session.queue.get") return this.get();
		if (this.session.isCompacting) throw new SessionControlError("BUSY_COMPACTING", "Wait for compaction to finish");
		const entry = this.session
			.getQueuedMessageEntries()
			.find(entry => entry.id === operation.id && entry.queue === operation.queue);
		if (!entry || entry.state === "inFlight")
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"This message is already being delivered or is no longer queued. Refresh its state.",
			);
		const changed =
			operation.kind === "session.queue.restore"
				? entry.state === "held" && this.session.restoreQueuedMessage(entry.id)
				: operation.kind === "session.queue.edit"
					? this.session.editQueuedMessage(entry.id, entry.queue, operation.expectedText, operation.text)
					: operation.kind === "session.queue.remove"
						? this.session.removeQueuedMessage({ id: entry.id }, entry.queue)
						: entry.queue === "followUp" && this.session.promoteQueuedMessage({ id: entry.id });
		if (!changed)
			throw new SessionControlError("COMMAND_BLOCKED", "The queued message changed; refresh before editing it.");
		return this.get();
	}
}
