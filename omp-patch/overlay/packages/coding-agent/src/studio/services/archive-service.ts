import { archiveCalls, archiveGrep, archiveStats } from "../../archive/activity";
import { archiveTranscript } from "../../archive/transcript";
import * as path from "node:path";
import {
	archiveSessions,
	archiveSearch,
	archiveRecaps,
	archivePrompts,
	archiveSession,
	type ArchiveSession,
	type ArchivePrompt,
	type ArchiveRecap,
} from "../../archive/archive";
import type { AgentSession } from "../../session/agent-session";
import type {
	ArchiveQueryOperation,
	ArchiveOperation,
	NativeArchiveSession,
	NativeArchiveText,
} from "../archive-protocol";
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
		...(row.recap !== null ? { recap: row.recap.slice(0, 512) } : {}),
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
	async execute(operation: ArchiveOperation | ArchiveQueryOperation): Promise<unknown> {
		const check = () => {
			if (operation.sessionId !== this.session.sessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "Archive request belongs to a different session");
		};
		check();

		const window =
			"since" in operation || "until" in operation
				? {
						...("since" in operation && operation.since !== undefined ? { since: operation.since } : {}),
						...("until" in operation && operation.until !== undefined ? { until: operation.until } : {}),
					}
				: undefined;
		if (operation.kind === "archive.transcript.read") {
			const { records } = await archiveTranscript(operation.targetSessionId, {
				detail: operation.detail ?? "auto",
				budget: operation.budget ?? 16000,
				turns: operation.turns,
				window,
			});
			check();
			const { file: _file, ...view } = records;
			return view;
		}
		if ("scope" in operation) {
			const scope = {
				cwd: operation.scope === "workspace" ? this.session.sessionManager.getCwd() : undefined,
				window,
				limit: PAGE + 1,
				subagents: "subagents" in operation && operation.subagents === true,
			};
			if (operation.kind === "archive.search") {
				const { records } = await archiveSearch(operation.query, scope);
				check();
				return {
					rows: records.slice(0, PAGE).map(row => ({
						...sessionRow(row),
						matches: row.matches.slice(0, 6).map(match => ({ ...match, text: match.text.slice(0, 512) })),
					})),
					truncated: records.length > PAGE,
				};
			}
			if (operation.kind === "archive.calls.list") {
				const { records } = await archiveCalls(operation.tools ? { tools: operation.tools } : {}, {}, scope);
				check();
				return {
					rows: records.slice(0, PAGE).map(row => ({
						session: row.session,
						agent: row.agent,
						project: projectName(row.project),
						at: row.at,
						callId: row.callId,
						tool: row.tool,
						args: row.args,
						result: row.result,
						isError: row.isError,
						model: row.model,
					})),
					truncated: records.length > PAGE,
				};
			}
			if (operation.kind === "archive.messages.grep") {
				const { records } = await archiveGrep(
					operation.pattern,
					{},
					{ sources: ["user", "assistant", "thinking", "args", "result"] },
					scope,
				);
				check();
				return {
					rows: records.slice(0, PAGE).map(row => ({
						session: row.session,
						agent: row.agent,
						project: projectName(row.project),
						at: row.at,
						source: row.source,
						tool: row.tool,
						text: row.text,
						match: row.match,
					})),
					truncated: records.length > PAGE,
				};
			}
			if (operation.kind === "archive.stats.read") {
				const { records } = await archiveStats(operation.by, {}, {}, scope);
				check();
				return {
					rows: records.slice(0, PAGE).map(row => ({
						...row,
						key: operation.by === "project" && row.key ? projectName(row.key) : row.key,
					})),
					truncated: records.length > PAGE,
				};
			}
		}
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
			const rows = (await archiveSessions({ cwd, window: undefined, limit: PAGE + 1 })).records;
			check();
			return { rows: rows.slice(0, PAGE).map(sessionRow), truncated: rows.length > PAGE };
		}
		const rows =
			operation.kind === "archive.recaps.list"
				? archiveRecaps({ cwd, window: undefined, limit: PAGE + 1 }).records
				: archivePrompts(operation.query.trim() || undefined, { cwd, window: undefined, limit: PAGE + 1 }).records;
		check();
		return { rows: rows.slice(0, PAGE).map(textRow), truncated: rows.length > PAGE };
	}
}
