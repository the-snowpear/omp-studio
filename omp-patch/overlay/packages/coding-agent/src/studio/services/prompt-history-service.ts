import { getHistoryDbPath } from "@oh-my-pi/pi-utils";
import { HistoryStorage, type HistoryEntry, type HistoryFilter } from "../../session/history-storage";
import type { SessionManager } from "../../session/session-manager";
import {
	type PromptHistoryOperation,
	type PromptHistoryScope,
	validatePromptHistoryOperation,
} from "../prompt-history-protocol";
import { truncateUtf8 } from "./conversation-sanitizer";
import { SessionControlError } from "./session-control-service";

interface PromptHistorySession {
	readonly sessionId: string;
	readonly sessionManager: Pick<SessionManager, "getCwd">;
}

/** Uses the same native history/FTS rows as Ctrl+R; never reads transcript files or submits a prompt. */
export class StudioPromptHistoryService {
	constructor(readonly session: PromptHistorySession) {}

	execute(operation: PromptHistoryOperation): unknown {
		validatePromptHistoryOperation(operation);
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The prompt history session changed");
		const scope = operation.scope ?? "workspace";
		const history = HistoryStorage.open();
		const filter = this.#filter(scope);
		if (operation.kind === "history.prompts.list") {
			const limit = operation.limit ?? 50;
			const query = operation.query?.trim();
			const entries = query ? history.search(query, limit + 1, filter) : history.getRecent(limit + 1, filter);
			return {
				sessionId: operation.sessionId,
				scope,
				truncated: entries.length > limit,
				items: entries.slice(0, limit).map(entry => ({
					id: entry.id,
					revision: this.#revision(entry, scope),
					preview: truncateUtf8(entry.prompt, 480).text,
					createdAt: entry.created_at * 1000,
					useCount: entry.useCount,
					...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
					...(entry.sessionId === undefined ? {} : { sourceSessionId: entry.sessionId }),
				})),
			};
		}
		const entry = history.getById(operation.id);
		if (
			!entry ||
			(filter.cwd !== undefined && entry.cwd !== filter.cwd) ||
			(filter.sessionId !== undefined && entry.sessionId !== filter.sessionId) ||
			this.#revision(entry, scope) !== operation.revision
		)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"The selected prompt changed or left this history scope; refresh the list",
			);
		if (operation.kind === "history.prompts.read") {
			const body = truncateUtf8(entry.prompt, 128 * 1024);
			return { id: entry.id, revision: operation.revision, prompt: body.text, truncated: body.truncated };
		}
		if (!history.delete(entry.id, entry))
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"The selected prompt was submitted again; refresh before deleting",
			);
		return { id: entry.id, deleted: true };
	}

	#filter(scope: PromptHistoryScope): HistoryFilter {
		return scope === "profile"
			? {}
			: scope === "workspace"
				? { cwd: this.session.sessionManager.getCwd() }
				: { sessionId: this.session.sessionId };
	}

	#revision(entry: HistoryEntry, scope: PromptHistoryScope): string {
		return new Bun.CryptoHasher("sha256")
			.update(
				JSON.stringify([
					getHistoryDbPath(),
					this.session.sessionId,
					scope,
					entry.id,
					entry.prompt,
					entry.created_at,
					entry.cwd,
					entry.sessionId,
					entry.useCount,
				]),
			)
			.digest("hex");
	}
}
