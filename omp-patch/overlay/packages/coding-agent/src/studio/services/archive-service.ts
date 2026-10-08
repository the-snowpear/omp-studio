import * as path from "node:path";
import {
	archiveSessions,
	archiveRecaps,
	archivePrompts,
	archiveSession,
	type ArchiveSession,
	type ArchivePrompt,
	type ArchiveRecap,
} from "../../archive/archive";
import type { AgentSession } from "../../session/agent-session";
import type { ArchiveOperation, NativeArchiveSession, NativeArchiveText } from "../archive-protocol";
import { SessionControlError } from "./session-control-service";
const PAGE = 20;
function projectName(value: string): string {
	return path.basename(value).slice(0, 80) || value.slice(0, 80);
}
function sessionRow(row: ArchiveSession): NativeArchiveSession {
	return {
		id: row.id,
		title: row.title.slice(0, 256),
		project: projectName(row.project),
		created: row.created,
		modified: row.modified,
		messages: row.messages,
		...(row.status ? { status: row.status } : {}),
		...(row.recap !== undefined ? { recap: row.recap.slice(0, 512) } : {}),
		truncated: row.title.length > 256 || (row.recap?.length ?? 0) > 512,
	};
}
function textRow(row: ArchiveRecap | ArchivePrompt): NativeArchiveText {
	return {
		text: row.text.slice(0, 512),
		at: row.at,
		...(row.session ? { sessionId: row.session } : {}),
		...(row.project ? { project: projectName(row.project) } : {}),
		...("uses" in row ? { uses: row.uses } : {}),
		truncated: row.text.length > 512,
	};
}
/** Read native Archive records without accepting filenames or changing session ownership. */
export class StudioArchiveService {
	constructor(readonly session: AgentSession) {}
	async execute(operation: ArchiveOperation): Promise<unknown> {
		const check = () => {
			if (operation.sessionId !== this.session.sessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "Archive request belongs to a different session");
		};
		check();
		if (operation.kind === "archive.session.inspect") {
			const native = (await archiveSession(operation.targetSessionId, 10, 11)).records;
			check();
			if (native.id !== operation.targetSessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "Select a complete session identity from Archive");
			return {
				session: sessionRow(native),
				recaps: native.recaps.slice(-10).map(textRow),
				prompts: native.prompts.slice(-10).map(textRow),
				truncated:
					native.recaps.length > 10 ||
					native.prompts.length >= 10 ||
					native.recaps.some(row => row.text.length > 512) ||
					native.prompts.some(row => row.text.length > 512),
			};
		}
		const cwd = operation.scope === "workspace" ? this.session.sessionManager.getCwd() : undefined;
		if (operation.kind === "archive.sessions.list") {
			const rows = (await archiveSessions(cwd, PAGE + 1)).records;
			check();
			return { rows: rows.slice(0, PAGE).map(sessionRow), truncated: rows.length > PAGE };
		}
		const rows =
			operation.kind === "archive.recaps.list"
				? archiveRecaps(cwd, PAGE + 1).records
				: archivePrompts(operation.query.trim() || undefined, cwd, PAGE + 1).records;
		check();
		return { rows: rows.slice(0, PAGE).map(textRow), truncated: rows.length > PAGE };
	}
}
