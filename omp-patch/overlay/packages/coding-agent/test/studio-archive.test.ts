import * as transcript from "../src/archive/transcript";
import { renderTranscriptRecords } from "../src/session/transcript-view";
import { TranscriptRecordKind } from "@oh-my-pi/pi-natives";
import { expect, test, spyOn } from "bun:test";
import * as archive from "../src/archive/archive";
import type { AgentSession } from "../src/session/agent-session";
import { StudioArchiveService } from "../src/studio/services/archive-service";
import { validateArchiveOperation } from "../src/studio/archive-protocol";
test("Archive bounds native content and pages while preserving IDs and omitting session paths", async () => {
	const session = { sessionId: "main", sessionManager: { getCwd: () => "/workspace" } } as unknown as AgentSession;
	const rows = Array.from({ length: 21 }, (_, index) => ({
		id: "session-" + index,
		file: "/private/session.jsonl",
		project: "/private/workspace",
		title: "界".repeat(600),
		created: "2026-10-07T00:00:00.000Z",
		modified: "2026-10-08T00:00:00.000Z",
		messages: 9,
		status: null,
		recap: "界".repeat(3000),
	}));
	const read = spyOn(archive, "archiveSessions").mockResolvedValue({ records: rows, text: "unused" });
	try {
		const result = await new StudioArchiveService(session).execute({
			kind: "archive.sessions.list",
			sessionId: "main",
			scope: "workspace",
		});
		expect(result).toMatchObject({
			truncated: true,
			rows: [
				{ id: "session-0", project: "workspace", truncated: true },
				...Array.from({ length: 19 }, (_, i) => ({ id: "session-" + (i + 1) })),
			],
		});
		expect(JSON.stringify(result)).not.toContain("/private/");
		expect(JSON.stringify(result)).not.toContain("界".repeat(513));
		expect(read).toHaveBeenCalledWith({ cwd: "/workspace", window: undefined, limit: 21 });
		await expect(
			new StudioArchiveService(session).execute({
				kind: "archive.sessions.list",
				sessionId: "foreign",
				scope: "all",
			}),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(read).toHaveBeenCalledTimes(1);
	} finally {
		read.mockRestore();
	}
});
test("Archive discards a read when its owning session changes and rejects path-shaped targets", async () => {
	const session = { sessionId: "main", sessionManager: { getCwd: () => "/workspace" } } as unknown as AgentSession;
	const pending = Promise.withResolvers<archive.ArchiveView<archive.ArchiveSession[]>>();
	const read = spyOn(archive, "archiveSessions").mockImplementation(() => pending.promise);
	try {
		const loading = new StudioArchiveService(session).execute({
			kind: "archive.sessions.list",
			sessionId: "main",
			scope: "all",
		});
		Object.assign(session, { sessionId: "next" });
		pending.resolve({ text: "", records: [] });
		await expect(loading).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(() =>
			validateArchiveOperation({
				kind: "archive.session.inspect",
				sessionId: "next",
				targetSessionId: "../../secrets.jsonl",
			}),
		).toThrow();
	} finally {
		read.mockRestore();
	}
});

test("Archive transcript query applies native turn/detail budget and does not return filesystem identity", async () => {
	const session = { sessionId: "main", sessionManager: { getCwd: () => "/workspace" } } as unknown as AgentSession;
	const records = [
		{ kind: TranscriptRecordKind.User, at: 1, text: "first prompt" },
		{ kind: TranscriptRecordKind.Assistant, at: 2, text: "earlier answer" },
		{ kind: TranscriptRecordKind.User, at: 3, text: "latest prompt" },
		{ kind: TranscriptRecordKind.Assistant, at: 4, text: "latest answer ".repeat(300) },
	];
	const read = spyOn(transcript, "archiveTranscript").mockImplementation(async (_id, options) => {
		const view = renderTranscriptRecords(records, { ...options, title: "Transcript" });
		return { text: view.text, records: { ...view, file: "/private/session.jsonl" } };
	});
	try {
		const result = (await new StudioArchiveService(session).execute({
			kind: "archive.transcript.read",
			sessionId: "main",
			targetSessionId: "history-id",
			turns: [-1, -1],
			budget: 512,
			detail: "auto",
		})) as { text: string; omitted: number };
		expect(result.text).toContain("latest prompt");
		expect(result.text).not.toContain("first prompt");
		expect(result.text.length).toBeLessThanOrEqual(512);
		expect(result).not.toHaveProperty("file");
	} finally {
		read.mockRestore();
	}
});

test("Archive full-text results retain source matches separately from prompt history", async () => {
	const session = { sessionId: "main", sessionManager: { getCwd: () => "/workspace" } } as unknown as AgentSession;
	const search = spyOn(archive, "archiveSearch").mockResolvedValue({
		text: "",
		records: [
			{
				id: "found",
				file: "/secret/a.jsonl",
				project: "/workspace",
				title: "title",
				created: "2026-11-01",
				modified: "2026-11-02",
				messages: 4,
				status: null,
				recap: null,
				matches: [{ source: "assistant", text: "the error was fixed", at: "2026-11-02" }],
			},
		],
	});
	const prompts = spyOn(archive, "archivePrompts");
	try {
		const result = await new StudioArchiveService(session).execute({
			kind: "archive.search",
			sessionId: "main",
			scope: "workspace",
			query: "error",
			since: 100,
			until: 200,
		});
		expect(result).toMatchObject({
			rows: [{ id: "found", matches: [{ source: "assistant", text: "the error was fixed" }] }],
		});
		expect(JSON.stringify(result)).not.toContain("/secret/");
		expect(prompts).not.toHaveBeenCalled();
		expect(search).toHaveBeenCalledWith("error", {
			cwd: "/workspace",
			window: { since: 100, until: 200 },
			limit: 21,
			subagents: false,
		});
	} finally {
		search.mockRestore();
		prompts.mockRestore();
	}
});
