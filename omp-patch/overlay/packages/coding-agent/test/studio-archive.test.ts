import { expect, test, spyOn } from "bun:test";
import * as archive from "../src/archive/archive";
import type { AgentSession } from "../src/session/agent-session";
import { StudioArchiveService } from "../src/studio/services/archive-service";
import { validateArchiveOperation, validateArchiveResult } from "../src/studio/archive-protocol";
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
		recap: "界".repeat(3000),
	}));
	const read = spyOn(archive, "archiveSessions").mockResolvedValue({ records: rows, text: "unused" });
	try {
		const result = await new StudioArchiveService(session).execute({
			kind: "archive.sessions.list",
			sessionId: "main",
			scope: "workspace",
		});
		validateArchiveResult("archive.sessions.list", result);
		expect(result).toMatchObject({
			truncated: true,
			rows: [
				{ id: "session-0", project: "workspace", truncated: true },
				...Array.from({ length: 19 }, (_, i) => ({ id: "session-" + (i + 1) })),
			],
		});
		expect(JSON.stringify(result)).not.toContain("/private/");
		expect(JSON.stringify(result)).not.toContain("界".repeat(513));
		expect(read).toHaveBeenCalledWith("/workspace", 21);
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
